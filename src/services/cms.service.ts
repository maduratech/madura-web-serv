import { env } from '../config/env';
import { supabase } from '../lib/supabase';
import { childPricesFromDb, childPricesToDb } from '../lib/tour-price-db';
import { normalizeDestinationSlug } from '../lib/destination-slug';
import { DESTINATION_SELECT_TRIES } from '../lib/destination-db-schema';
import {
  buildDestinationDisplayLabel,
  destinationKind,
  isHeaderRegionParentRow,
  resolveDestinationParentSelection,
  type DestinationHierarchyRow,
} from '../lib/destination-hierarchy';
import { mergeHierarchyIntoDescription, parseHierarchyFromDescription } from '../lib/destination-cms-meta';
import {
  resolveSeedCountryName,
  resolveSeedHierarchyHint,
} from '../lib/destination-seed-hierarchy';
import { parseTourVisibility, type TourVisibilityStatus } from '../lib/tour-visibility';
import { parseTourCmsMeta } from '../lib/tour-meta';
import { readTourDestinationIds } from '../lib/tour-destinations';
import { splitOverviewWithMeta } from '../lib/tour-overview-meta';
import { ensureTourTaxonomyFromMeta } from './cms-taxonomy.service';
import { normalizeTourMarketAudience, type TourMarketAudience } from '../lib/tour-market-audience';
import { listTourDepartures, replaceTourDepartures } from './cms-departures.service';
import { invalidateDestinationHierarchyCache, invalidateToursListingCache } from '../lib/catalog-cache';
import { requestSupabaseRecoveryOnCatalogStale } from '../lib/supabase-recovery';

function invalidatePublicCatalogCaches(): void {
  invalidateToursListingCache();
  invalidateDestinationHierarchyCache();
}

/** PostgREST / Supabase wording when a column or embed is missing on this project. */
function isSchemaColumnMismatch(errMsg: string): boolean {
  const m = String(errMsg || '').toLowerCase();
  return (
    m.includes('does not exist') ||
    m.includes('could not find') ||
    m.includes('schema cache') ||
    m.includes('unknown column')
  );
}

export type CmsStaffRow = {
  id: string;
  email: string;
  full_name: string | null;
  role: 'staff' | 'super_admin';
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export async function getCmsStaffByUserId(userId: string): Promise<CmsStaffRow | null> {
  const { data, error } = await supabase
    .from('cms_staff')
    .select('id,email,full_name,role,is_active,created_at,updated_at')
    .eq('id', userId)
    .maybeSingle();
  if (error || !data) return null;
  return data as CmsStaffRow;
}

function parseBootstrapSuperAdminEmails(): Set<string> {
  return new Set(
    env.CMS_BOOTSTRAP_SUPER_ADMIN_EMAILS.split(',')
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean)
  );
}

/** First sign-in for allowlisted emails — grants website CMS super_admin (not CRM admin). */
export async function ensureBootstrapCmsStaff(input: {
  userId: string;
  email: string;
  full_name?: string | null;
}): Promise<CmsStaffRow | null> {
  const allowlist = parseBootstrapSuperAdminEmails();
  const email = input.email.trim().toLowerCase();
  if (!allowlist.has(email)) return null;

  const existing = await getCmsStaffByUserId(input.userId);
  if (existing?.is_active) return existing;

  return upsertCmsStaffForUser(input.userId, input.email, input.full_name, 'super_admin');
}

export async function listCmsStaff(): Promise<CmsStaffRow[]> {
  const { data, error } = await supabase
    .from('cms_staff')
    .select('id,email,full_name,role,is_active,created_at,updated_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []) as CmsStaffRow[];
}

export type CmsWebsiteUserRow = {
  id: string;
  email: string;
  full_name: string | null;
  phone: string | null;
  account_type: 'traveler' | 'staff' | 'super_admin';
  cms_role: 'staff' | 'super_admin' | null;
  /** Account can sign in (not banned / disabled). */
  is_active: boolean;
  is_cms_active: boolean;
  signed_up_at: string | null;
};

type ProfileListRow = {
  id: string;
  email?: string | null;
  full_name?: string | null;
  phone?: string | null;
  created_at?: string | null;
  is_active?: boolean | null;
};

function isAuthUserBanned(bannedUntil: string | null | undefined): boolean {
  if (!bannedUntil) return false;
  return new Date(bannedUntil) > new Date();
}

async function listAllAuthUsers() {
  const users: Array<{
    id: string;
    email?: string;
    created_at?: string;
    banned_until?: string | null;
    user_metadata?: Record<string, unknown>;
  }> = [];
  let page = 1;
  while (true) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    users.push(...data.users);
    if (data.users.length < 1000) break;
    page += 1;
  }
  return users;
}

async function findAuthUserByEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  const users = await listAllAuthUsers();
  return users.find((u) => (u.email || '').toLowerCase() === normalized) ?? null;
}

async function ensureProfile(
  userId: string,
  email: string,
  full_name?: string | null,
  isActive = true
): Promise<void> {
  const base = {
    id: userId,
    email,
    full_name: full_name?.trim() || null,
  };
  const withActive = { ...base, is_active: isActive };
  let res = await supabase.from('profiles').upsert(withActive, { onConflict: 'id' });
  if (res.error && /is_active|column/i.test(res.error.message)) {
    res = await supabase.from('profiles').upsert(base, { onConflict: 'id' });
  }
  if (res.error) throw new Error(res.error.message);
}

async function findOrCreateAuthUser(input: {
  email: string;
  full_name?: string | null;
  password?: string;
}): Promise<{ id: string; email: string }> {
  const email = input.email.trim().toLowerCase();
  const existing = await findAuthUserByEmail(email);
  if (existing) {
    return { id: existing.id, email: existing.email || email };
  }

  const password = input.password?.trim();
  if (!password || password.length < 8) {
    throw new Error(
      'No account exists for this email. Enter a temporary password (at least 8 characters) to create one.'
    );
  }

  const { data: created, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: input.full_name?.trim() || null,
    },
  });
  if (error) throw new Error(error.message);
  if (!created.user?.id) throw new Error('Failed to create authentication user.');

  return { id: created.user.id, email: created.user.email || email };
}

/** All website accounts (travelers + CMS staff), merged from profiles and cms_staff. */
export async function listWebsiteUsers(): Promise<CmsWebsiteUserRow[]> {
  const staffRows = await listCmsStaff();
  const staffById = new Map(staffRows.map((s) => [s.id, s]));

  const authUsers = await listAllAuthUsers();
  const authById = new Map(
    authUsers.map((u) => [
      u.id,
      {
        email: u.email || '',
        banned: isAuthUserBanned(u.banned_until),
        created_at: u.created_at,
        meta: (u.user_metadata || {}) as Record<string, unknown>,
      },
    ])
  );

  let profiles: ProfileListRow[] = [];
  const wide = await supabase
    .from('profiles')
    .select('id,email,full_name,phone,created_at,is_active')
    .order('created_at', { ascending: false });
  if (!wide.error) {
    profiles = (wide.data || []) as ProfileListRow[];
  } else {
    const narrow = await supabase
      .from('profiles')
      .select('id,email,full_name,phone')
      .order('email', { ascending: true });
    if (narrow.error) throw new Error(narrow.error.message);
    profiles = (narrow.data || []) as ProfileListRow[];
  }

  const profileById = new Map(profiles.map((p) => [String(p.id), p]));
  const rows: CmsWebsiteUserRow[] = [];
  const seen = new Set<string>();

  const pushRow = (id: string) => {
    const cms = staffById.get(id);
    const cmsRole = cms?.role ?? null;
    const account_type: CmsWebsiteUserRow['account_type'] =
      cmsRole === 'super_admin' ? 'super_admin' : cmsRole === 'staff' ? 'staff' : 'traveler';
    const profile = profileById.get(id);
    const auth = authById.get(id);
    const profileActive = profile?.is_active !== false;
    const is_active = profileActive && !(auth?.banned ?? false);
    const cmsActive = Boolean(cms?.is_active) && is_active;

    rows.push({
      id,
      email: String(profile?.email || cms?.email || auth?.email || '').trim(),
      full_name: (profile?.full_name ?? cms?.full_name ?? null) as string | null,
      phone: (profile?.phone ?? null) as string | null,
      account_type,
      cms_role: cmsRole,
      is_active,
      is_cms_active: cmsActive,
      signed_up_at:
        (profile?.created_at ?? auth?.created_at ?? cms?.created_at ?? null) as string | null,
    });
  };

  for (const p of profiles) {
    const id = String(p.id);
    seen.add(id);
    pushRow(id);
  }

  for (const u of authUsers) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    pushRow(u.id);
  }

  for (const s of staffRows) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    pushRow(s.id);
  }

  return rows.sort((a, b) => {
    const ta = a.signed_up_at ? Date.parse(a.signed_up_at) : 0;
    const tb = b.signed_up_at ? Date.parse(b.signed_up_at) : 0;
    return tb - ta;
  });
}

export type CreateManagedUserInput = {
  email: string;
  full_name?: string | null;
  password?: string;
  account_type: 'traveler' | 'staff' | 'super_admin';
};

export async function createManagedUser(input: CreateManagedUserInput): Promise<CmsWebsiteUserRow> {
  const authUser = await findOrCreateAuthUser({
    email: input.email,
    full_name: input.full_name,
    password: input.password,
  });
  await ensureProfile(authUser.id, authUser.email, input.full_name, true);

  if (input.account_type === 'staff' || input.account_type === 'super_admin') {
    await upsertCmsStaffForUser(
      authUser.id,
      authUser.email,
      input.full_name,
      input.account_type === 'super_admin' ? 'super_admin' : 'staff'
    );
  }

  const users = await listWebsiteUsers();
  const row = users.find((u) => u.id === authUser.id);
  if (!row) throw new Error('User saved but could not be loaded. Refresh the list.');
  return row;
}

async function upsertCmsStaffForUser(
  userId: string,
  email: string,
  full_name: string | null | undefined,
  role: 'staff' | 'super_admin'
): Promise<CmsStaffRow> {
  const { data, error } = await supabase
    .from('cms_staff')
    .upsert(
      {
        id: userId,
        email,
        full_name: full_name?.trim() || null,
        role,
        is_active: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'id' }
    )
    .select('id,email,full_name,role,is_active,created_at,updated_at')
    .single();
  if (error) throw new Error(error.message);
  return data as CmsStaffRow;
}

export async function upsertCmsStaff(input: {
  email: string;
  full_name?: string | null;
  role: 'staff' | 'super_admin';
  password?: string;
}): Promise<CmsStaffRow> {
  const authUser = await findOrCreateAuthUser({
    email: input.email,
    full_name: input.full_name,
    password: input.password,
  });
  await ensureProfile(authUser.id, authUser.email, input.full_name, true);
  return upsertCmsStaffForUser(authUser.id, authUser.email, input.full_name, input.role);
}

/** Disable or re-enable any website account (traveler ban + optional CMS staff flag). */
export type UpdateManagedUserInput = {
  full_name?: string | null;
  phone?: string | null;
  account_type?: 'traveler' | 'staff' | 'super_admin';
  password?: string;
  is_active?: boolean;
};

export async function updateManagedUser(
  userId: string,
  input: UpdateManagedUserInput,
  requestingUserId?: string
): Promise<CmsWebsiteUserRow> {
  const users = await listWebsiteUsers();
  const current = users.find((u) => u.id === userId);
  if (!current) throw new Error('User not found.');

  if (input.is_active !== undefined) {
    if (userId === requestingUserId && !input.is_active) {
      throw new Error('You cannot deactivate your own account.');
    }
    await setWebsiteUserActive(userId, input.is_active);
  }

  const nameProvided = input.full_name !== undefined;
  const phoneProvided = input.phone !== undefined;
  if (nameProvided || phoneProvided) {
    const profilePatch: Record<string, unknown> = {};
    if (nameProvided) profilePatch.full_name = input.full_name?.trim() || null;
    if (phoneProvided) profilePatch.phone = input.phone?.trim() || null;
    const { error: profErr } = await supabase.from('profiles').update(profilePatch).eq('id', userId);
    if (profErr) throw new Error(profErr.message);

    if (nameProvided) {
      const { error: metaErr } = await supabase.auth.admin.updateUserById(userId, {
        user_metadata: { full_name: input.full_name?.trim() || null },
      });
      if (metaErr) throw new Error(metaErr.message);
    }

    const staff = await getCmsStaffByUserId(userId);
    if (staff && nameProvided) {
      const { error: staffErr } = await supabase
        .from('cms_staff')
        .update({
          full_name: input.full_name?.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', userId);
      if (staffErr) throw new Error(staffErr.message);
    }
  }

  const password = input.password?.trim();
  if (password) {
    if (password.length < 8) {
      throw new Error('Password must be at least 8 characters.');
    }
    const { error: pwErr } = await supabase.auth.admin.updateUserById(userId, { password });
    if (pwErr) throw new Error(pwErr.message);
  }

  if (input.account_type !== undefined && input.account_type !== current.account_type) {
    if (
      userId === requestingUserId &&
      current.account_type === 'super_admin' &&
      input.account_type !== 'super_admin'
    ) {
      throw new Error('You cannot remove your own Super Admin access.');
    }
    if (input.account_type === 'traveler') {
      await removeCmsStaff(userId);
    } else {
      const role = input.account_type === 'super_admin' ? 'super_admin' : 'staff';
      const name = nameProvided ? input.full_name : current.full_name;
      await upsertCmsStaffForUser(userId, current.email, name, role);
    }
  }

  const refreshed = await listWebsiteUsers();
  const row = refreshed.find((u) => u.id === userId);
  if (!row) throw new Error('User updated but could not be loaded. Refresh the list.');
  return row;
}

export async function setWebsiteUserActive(userId: string, isActive: boolean): Promise<void> {
  const staff = await getCmsStaffByUserId(userId);
  if (staff) {
    await setCmsStaffActive(userId, isActive);
  }

  const profilePatch: Record<string, unknown> = { is_active: isActive };
  const { error: profErr } = await supabase.from('profiles').update(profilePatch).eq('id', userId);
  if (profErr && !/is_active|column/i.test(profErr.message)) {
    throw new Error(profErr.message);
  }

  const { error: banErr } = await supabase.auth.admin.updateUserById(userId, {
    ban_duration: isActive ? 'none' : '876000h',
  });
  if (banErr) throw new Error(banErr.message);
}

export async function setCmsStaffActive(userId: string, isActive: boolean): Promise<void> {
  const { error } = await supabase
    .from('cms_staff')
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq('id', userId);
  if (error) throw new Error(error.message);
}

export async function removeCmsStaff(userId: string): Promise<void> {
  const { error } = await supabase.from('cms_staff').delete().eq('id', userId);
  if (error) throw new Error(error.message);
}

export type CmsDestinationType = 'country' | 'city' | 'state';

export type CmsDestination = {
  id: number;
  name: string;
  slug: string | null;
  country: string | null;
  destination_type: CmsDestinationType | null;
  parent_id: number | null;
  country_id: number | null;
  state_id: number | null;
  display_label: string | null;
  description: string | null;
  is_active: boolean | null;
  flag_image_url: string | null;
  package_count: number;
  created_at?: string;
};

type DestinationRaw = {
  id: number;
  name?: string | null;
  slug?: string | null;
  country?: string | null;
  continent?: string | null;
  destination_type?: string | null;
  parent_id?: number | null;
  description?: string | null;
  is_active?: boolean | null;
  flag_image_url?: string | null;
  flag_iso?: string | null;
  created_at?: string | null;
};

function normalizeCmsDestinationType(value: unknown): CmsDestinationType | null {
  const t = String(value || '').trim().toLowerCase();
  if (t === 'country' || t === 'city' || t === 'state') return t;
  return null;
}

function mapDestinationRow(row: DestinationRaw, allRows: DestinationRaw[] = []): CmsDestination {
  const byId = new Map<number, DestinationHierarchyRow>();
  for (const item of allRows) {
    byId.set(Number(item.id), item as DestinationHierarchyRow);
  }
  const hierarchyRow = row as DestinationHierarchyRow;
  const metaHierarchy = parseHierarchyFromDescription(row.description);

  let parent_id =
    row.parent_id != null
      ? Number(row.parent_id)
      : metaHierarchy.parent_id != null
        ? Number(metaHierarchy.parent_id)
        : null;

  const rawTypeFromColumn = normalizeCmsDestinationType(row.destination_type);
  const rawTypeFromMeta = normalizeCmsDestinationType(metaHierarchy.destination_type);
  let rawType = rawTypeFromColumn || rawTypeFromMeta || null;

  // Column can stay `country` from an old default while CMS meta / parent link says city/state.
  if (
    rawType === 'country' &&
    rawTypeFromMeta &&
    rawTypeFromMeta !== 'country'
  ) {
    rawType = rawTypeFromMeta;
  }

  let destination_type = rawType;
  const seedHint = resolveSeedHierarchyHint(
    row.slug != null ? String(row.slug) : null,
    row.name,
  );
  if (seedHint?.destination_type) {
    destination_type = seedHint.destination_type;
  }
  if (!destination_type && parent_id != null) {
    const parent = byId.get(parent_id);
    destination_type =
      parent && destinationKind(parent) === 'country' ? 'state' : 'city';
  } else if (!destination_type) {
    destination_type = 'country';
  }

  if (destination_type === 'country' && parent_id != null) {
    const parent = byId.get(parent_id);
    if (parent && isHeaderRegionParentRow(parent)) {
      parent_id = null;
    } else if (parent && destinationKind(parent) === 'country') {
      destination_type = 'state';
    } else if (parent) {
      destination_type = 'city';
    }
  }

  let hierarchyRowWithType: DestinationHierarchyRow = {
    ...hierarchyRow,
    destination_type,
    parent_id,
  };
  const parents = resolveDestinationParentSelection(hierarchyRowWithType, byId);
  const country_id = parents.country_id ?? metaHierarchy.country_id ?? null;
  const state_id = parents.state_id ?? metaHierarchy.state_id ?? null;

  let effectiveParentId = parent_id;
  if (effectiveParentId == null && country_id != null) {
    if (destination_type === 'state') {
      effectiveParentId = country_id;
    } else if (destination_type === 'city') {
      effectiveParentId = state_id ?? country_id;
    }
  }

  hierarchyRowWithType = {
    ...hierarchyRowWithType,
    parent_id: effectiveParentId,
  };

  const countryRow = country_id ? byId.get(country_id) : undefined;
  let countryName = String(row.country ?? '').trim() || countryRow?.name?.trim() || null;

  if (!countryName && seedHint?.country_name) {
    countryName = seedHint.country_name;
  } else if (!countryName) {
    const seedCountry = resolveSeedCountryName(
      row.slug != null ? String(row.slug) : null,
      row.name,
    );
    if (seedCountry) countryName = seedCountry;
  }

  if (destination_type === 'country') {
    countryName = null;
  }

  let resolvedCountryId = country_id;
  if (!resolvedCountryId && countryName && allRows.length > 0) {
    const needle = countryName.toLowerCase();
    const match = allRows.find(
      (item) =>
        String(item.name || '').trim().toLowerCase() === needle &&
        normalizeCmsDestinationType(item.destination_type) === 'country',
    );
    if (match) resolvedCountryId = Number(match.id);
  }

  const display_label =
    allRows.length > 0
      ? buildDestinationDisplayLabel(hierarchyRowWithType, byId)
      : countryName && destination_type !== 'country'
        ? `${String(row.name || '').trim()}, ${countryName}`
        : String(row.name || '').trim() || null;

  return {
    id: Number(row.id),
    name: String(row.name || '').trim(),
    slug: row.slug != null ? String(row.slug).trim() || null : null,
    country: countryName,
    destination_type,
    parent_id: effectiveParentId,
    country_id: resolvedCountryId ?? country_id,
    state_id,
    display_label,
    description: row.description ?? null,
    is_active: row.is_active ?? true,
    flag_image_url: row.flag_image_url ?? null,
    package_count: 0,
    created_at: row.created_at ?? undefined,
  };
}

const CMS_DESTINATION_PAGE_SAVE_UNAVAILABLE =
  "We couldn't save the destination page content for India or Australia. Please try again in a few minutes. If this keeps happening, contact Madura Travel support.";

const CMS_DESTINATION_PAGE_SAVE_FAILED =
  "We couldn't save the destination page content. Please check your connection and try again.";

/** India/AU rich HTML is stored in destinations.description (meta comment + JSON). */
async function persistDestinationDescription(id: number, description: string | null): Promise<void> {
  const { error } = await supabase
    .from('destinations')
    .update({ description })
    .eq('id', id);
  if (!error) return;
  const msg = String(error.message || '');
  if (isSchemaColumnMismatch(msg)) {
    // eslint-disable-next-line no-console
    console.error('[cms] destination description column unavailable:', msg);
    throw new Error(CMS_DESTINATION_PAGE_SAVE_UNAVAILABLE);
  }
  // eslint-disable-next-line no-console
  console.error('[cms] destination description save failed:', msg);
  throw new Error(CMS_DESTINATION_PAGE_SAVE_FAILED);
}

async function tryPersistDestinationHierarchy(
  id: number,
  hierarchy: {
    destination_type: CmsDestinationType;
    parent_id: number | null;
    country_id?: number | null;
    state_id?: number | null;
  },
  description: string | null | undefined,
): Promise<void> {
  const patchAttempts: Record<string, unknown>[] = [
    {
      destination_type: hierarchy.destination_type,
      parent_id: hierarchy.parent_id,
    },
    { destination_type: hierarchy.destination_type },
    { parent_id: hierarchy.parent_id },
  ];

  for (const patch of patchAttempts) {
    const cleaned = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined)
    );
    if (!Object.keys(cleaned).length) continue;
    const { error } = await supabase.from('destinations').update(cleaned).eq('id', id);
    if (!error) return;
    if (!isSchemaColumnMismatch(String(error.message || ''))) {
      // eslint-disable-next-line no-console
      console.warn('[cms] destination hierarchy patch failed:', error.message);
      break;
    }
  }

  const merged = mergeHierarchyIntoDescription(description ?? null, {
    destination_type: hierarchy.destination_type,
    parent_id: hierarchy.parent_id,
    country_id: hierarchy.country_id ?? null,
    state_id: hierarchy.state_id ?? null,
  });
  if (merged && merged !== description) {
    await persistDestinationDescription(id, merged);
  }
}

async function selectDestinations(cols: string) {
  return supabase.from('destinations').select(cols).order('name');
}

async function fetchPackageCountsByDestination(
  destinations: CmsDestination[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  for (const d of destinations) counts.set(d.id, 0);

  const tries = [
    'id,destination_id,destination,overview',
    'id,destination_id,destination',
    'id,destination_id',
    'id,destination',
  ];
  let tours: Array<{
    id: number;
    destination_id?: number | null;
    destination?: string | null;
    overview?: string | null;
  }> = [];
  for (const cols of tries) {
    const { data, error } = await supabase.from('tours').select(cols);
    if (!error && data) {
      tours = data as unknown as typeof tours;
      break;
    }
    if (!/column .* does not exist/i.test(String(error?.message || ''))) break;
  }

  const nameToId = new Map<string, number>();
  for (const d of destinations) {
    const key = String(d.name || '').trim().toLowerCase();
    if (key) nameToId.set(key, d.id);
  }

  for (const tour of tours) {
    const linkedIds = new Set<number>();
    for (const id of readTourDestinationIds(tour)) {
      if (counts.has(id)) linkedIds.add(id);
    }

    if (!linkedIds.size && tour.destination) {
      for (const part of String(tour.destination).split(',')) {
        const key = part.trim().toLowerCase();
        const id = nameToId.get(key);
        if (id != null && counts.has(id)) linkedIds.add(id);
      }
    }

    for (const destId of linkedIds) {
      counts.set(destId, (counts.get(destId) ?? 0) + 1);
    }
  }

  return counts;
}

function attachPackageCounts(
  destinations: CmsDestination[],
  counts: Map<number, number>,
): CmsDestination[] {
  return destinations.map((d) => ({
    ...d,
    package_count: counts.get(d.id) ?? 0,
  }));
}

export async function listDestinations(): Promise<CmsDestination[]> {
  const tries = [...DESTINATION_SELECT_TRIES];
  let lastErr = '';
  for (const cols of tries) {
    const { data, error } = await selectDestinations(cols);
    if (!error && data) {
      const rows = data as unknown as DestinationRaw[];
      const mapped = rows.map((row) => mapDestinationRow(row, rows));
      const counts = await fetchPackageCountsByDestination(mapped);
      return attachPackageCounts(mapped, counts);
    }
    lastErr = String(error?.message || '');
    if (!/column .* does not exist/i.test(lastErr)) break;
  }
  throw new Error(`Failed to list destinations: ${lastErr}`);
}

export async function getDestination(id: number): Promise<CmsDestination | null> {
  const all = await listDestinations().catch(() => [] as CmsDestination[]);
  const fromList = all.find((d) => d.id === id);
  if (fromList) return fromList;

  const tries = [...DESTINATION_SELECT_TRIES];
  let lastErr = '';
  for (const cols of tries) {
    const { data, error } = await supabase.from('destinations').select(cols).eq('id', id).maybeSingle();
    if (!error && data) {
      const rawRows = all.map((d) => ({
        id: d.id,
        name: d.name,
        slug: d.slug,
        destination_type: d.destination_type,
        parent_id: d.parent_id,
      })) as DestinationRaw[];
      const mapped = mapDestinationRow(data as unknown as DestinationRaw, rawRows);
      const counts = await fetchPackageCountsByDestination(all.length ? all : [mapped]);
      return attachPackageCounts([mapped], counts)[0];
    }
    lastErr = String(error?.message || '');
    if (!/column .* does not exist/i.test(lastErr)) break;
  }
  if (lastErr.includes('0 rows')) return null;
  throw new Error(`Failed to fetch destination: ${lastErr}`);
}

function slugify(name: string): string {
  return normalizeDestinationSlug(name);
}

type DestinationHierarchyWrite = {
  destination_type: CmsDestinationType;
  parent_id: number | null;
};

async function resolveDestinationWriteFields(
  input: Partial<CmsDestination> & {
    country_id?: number | null;
    state_id?: number | null;
  },
): Promise<DestinationHierarchyWrite> {
  const destination_type = normalizeCmsDestinationType(input.destination_type) || 'country';
  const countryIdRaw = input.country_id;
  const stateIdRaw = input.state_id;

  let parent_id: number | null = null;

  if (destination_type === 'state') {
    const countryId = Number(countryIdRaw);
    if (!Number.isFinite(countryId) || countryId <= 0) {
      throw new Error('Select a country for this state.');
    }
    parent_id = countryId;
  } else if (destination_type === 'city') {
    const countryId = Number(countryIdRaw);
    if (!Number.isFinite(countryId) || countryId <= 0) {
      throw new Error('Select a country for this city.');
    }
    const stateId = Number(stateIdRaw);
    if (Number.isFinite(stateId) && stateId > 0) {
      parent_id = stateId;
    } else {
      parent_id = countryId;
    }
  } else {
    parent_id = null;
  }

  return {
    destination_type,
    parent_id,
  };
}

async function insertDestinationWithFallback(payload: Record<string, unknown>): Promise<CmsDestination> {
  const hierarchy = await resolveDestinationWriteFields(payload as Partial<CmsDestination>);
  const insertTries: Record<string, unknown>[] = [
    {
      name: payload.name,
      slug: payload.slug,
      destination_type: hierarchy.destination_type,
      parent_id: hierarchy.parent_id,
      flag_image_url: payload.flag_image_url,
      description: payload.description,
      is_active: payload.is_active,
    },
    {
      name: payload.name,
      slug: payload.slug,
      destination_type: hierarchy.destination_type,
      parent_id: hierarchy.parent_id,
      flag_image_url: payload.flag_image_url,
      description: payload.description,
    },
    {
      name: payload.name,
      slug: payload.slug,
      destination_type: hierarchy.destination_type,
      parent_id: hierarchy.parent_id,
      description: payload.description,
    },
    {
      name: payload.name,
      slug: payload.slug,
      destination_type: hierarchy.destination_type,
      parent_id: hierarchy.parent_id,
    },
    { name: payload.name, slug: payload.slug },
    { name: payload.name, slug: payload.slug, description: payload.description },
    {
      name: payload.name,
      slug: payload.slug,
      flag_image_url: payload.flag_image_url,
      description: payload.description,
    },
    { name: payload.name },
  ];
  let lastErr = '';
  for (const row of insertTries) {
    const cleaned = Object.fromEntries(
      Object.entries(row).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );
    if (!cleaned.name) continue;
    const { data, error } = await supabase.from('destinations').insert(cleaned).select('id').single();
    if (!error && data?.id) {
      const createdId = Number(data.id);
      const description =
        payload.description !== undefined && payload.description !== null
          ? String(payload.description).trim() || null
          : null;
      await tryPersistDestinationHierarchy(
        createdId,
        {
          destination_type: hierarchy.destination_type,
          parent_id: hierarchy.parent_id,
          country_id:
            payload.country_id != null && payload.country_id !== ''
              ? Number(payload.country_id)
              : null,
          state_id:
            payload.state_id != null && payload.state_id !== ''
              ? Number(payload.state_id)
              : null,
        },
        description,
      );
      if (description) {
        await persistDestinationDescription(createdId, description);
      }
      return getDestination(createdId) as Promise<CmsDestination>;
    }
    lastErr = String(error?.message || '');
    if (!isSchemaColumnMismatch(lastErr)) break;
  }
  throw new Error(`Failed to create destination: ${lastErr}`);
}

export async function createDestination(input: Partial<CmsDestination>): Promise<CmsDestination> {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Destination name is required.');
  const slug = normalizeDestinationSlug((input.slug || slugify(name)).trim() || slugify(name));
  const destination_type = normalizeCmsDestinationType(input.destination_type) || 'country';
  return insertDestinationWithFallback({
    name,
    slug,
    country: input.country?.trim() || null,
    destination_type,
    country_id: input.country_id ?? null,
    state_id: input.state_id ?? null,
    parent_id: input.parent_id ?? null,
    flag_image_url: input.flag_image_url?.trim() || null,
    description: input.description?.trim() || null,
    is_active: input.is_active !== false,
  });
}

export async function updateDestination(id: number, input: Partial<CmsDestination>): Promise<CmsDestination> {
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('Invalid destination id.');
  }

  const basePatch: Record<string, unknown> = {};
  if (input.name !== undefined) basePatch.name = String(input.name).trim();
  if (input.slug !== undefined) {
    basePatch.slug =
      normalizeDestinationSlug(String(input.slug).trim()) || slugify(String(input.name || ''));
  }
  if (input.flag_image_url !== undefined) basePatch.flag_image_url = input.flag_image_url?.trim() || null;
  if (input.is_active !== undefined) basePatch.is_active = Boolean(input.is_active);

  const hierarchyTouched =
    input.destination_type !== undefined ||
    input.parent_id !== undefined ||
    input.country_id !== undefined ||
    input.state_id !== undefined;

  let resolvedHierarchy: Awaited<ReturnType<typeof resolveDestinationWriteFields>> | null = null;
  if (hierarchyTouched) {
    const existing = await getDestination(id);
    resolvedHierarchy = await resolveDestinationWriteFields({
      destination_type: input.destination_type ?? existing?.destination_type ?? 'country',
      country_id: input.country_id ?? existing?.country_id ?? null,
      state_id: input.state_id ?? existing?.state_id ?? null,
      country: input.country ?? existing?.country ?? null,
      name: input.name ?? existing?.name ?? '',
    });
    basePatch.destination_type = resolvedHierarchy.destination_type;
    basePatch.parent_id = resolvedHierarchy.parent_id;
  }

  if (input.description !== undefined) {
    await persistDestinationDescription(id, input.description?.trim() || null);
  }

  if (resolvedHierarchy) {
    const existingDesc =
      input.description !== undefined ? input.description : (await getDestination(id))?.description;
    await tryPersistDestinationHierarchy(
      id,
      {
        destination_type: resolvedHierarchy.destination_type,
        parent_id: resolvedHierarchy.parent_id,
        country_id: input.country_id ?? null,
        state_id: input.state_id ?? null,
      },
      existingDesc ?? null,
    );
  }

  const patchVariants: Record<string, unknown>[] = [
    basePatch,
    Object.fromEntries(Object.entries(basePatch).filter(([key]) => key !== 'is_active')),
    Object.fromEntries(
      Object.entries(basePatch).filter(([key]) => !['flag_image_url', 'is_active'].includes(key))
    ),
  ];

  const selectTries = [...DESTINATION_SELECT_TRIES];

  let lastErr = '';
  for (const patch of patchVariants) {
    const cleaned = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(cleaned).length) {
      const existing = await getDestination(id);
      if (existing) return existing;
      throw new Error('Destination not found.');
    }

    for (const sel of selectTries) {
      const { data, error } = await supabase
        .from('destinations')
        .update(cleaned)
        .eq('id', id)
        .select(sel)
        .maybeSingle();
      if (!error && data) return mapDestinationRow(data as unknown as DestinationRaw);
      lastErr = String(error?.message || '');
      if (!/column .* does not exist/i.test(lastErr)) break;
    }
    if (!/column .* does not exist/i.test(lastErr)) break;
  }

  const fallback = await getDestination(id);
  if (fallback) return fallback;
  throw new Error(`Failed to update destination: ${lastErr || 'Unknown error'}`);
}

async function countLinkedRows(
  table: string,
  column: string,
  value: number | string
): Promise<{ count: number; skipped: boolean }> {
  const { count, error } = await supabase
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq(column, value);
  if (error) {
    if (isSchemaColumnMismatch(error.message)) return { count: 0, skipped: true };
    throw new Error(`${table}: ${error.message}`);
  }
  return { count: count ?? 0, skipped: false };
}

export async function deleteDestination(id: number): Promise<void> {
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('Invalid destination id.');
  }

  const dest = await getDestination(id);
  if (!dest) throw new Error('Destination not found.');

  const blockers: string[] = [];

  const toursById = await countLinkedRows('tours', 'destination_id', id);
  if (!toursById.skipped && toursById.count > 0) {
    blockers.push(`${toursById.count} tour(s)`);
  }

  if (dest.name) {
    const { count, error } = await supabase
      .from('tours')
      .select('id', { count: 'exact', head: true })
      .ilike('destination', dest.name);
    if (error && !isSchemaColumnMismatch(error.message)) {
      throw new Error(`tours: ${error.message}`);
    }
    if ((count ?? 0) > 0) {
      blockers.push(`${count} tour(s) matched by destination name`);
    }
  }

  const sightseeing = await countLinkedRows('sightseeing', 'destination_id', id);
  if (!sightseeing.skipped && sightseeing.count > 0) {
    blockers.push(`${sightseeing.count} attraction(s)`);
  }

  const transfers = await countLinkedRows('transfers', 'destination_id', id);
  if (!transfers.skipped && transfers.count > 0) {
    blockers.push(`${transfers.count} transfer(s)`);
  }

  if (blockers.length > 0) {
    throw new Error(
      `Cannot delete: still linked to ${blockers.join(', ')}. Remove or reassign them first.`
    );
  }

  const { error } = await supabase.from('destinations').delete().eq('id', id);
  if (error) {
    const msg = String(error.message || '');
    if (/foreign key|violates|referenced/i.test(msg)) {
      throw new Error(
        'Cannot delete: this destination is still referenced elsewhere. Remove linked records first.'
      );
    }
    throw new Error(msg || 'Failed to delete destination.');
  }
}

export type CmsTourItineraryDay = {
  day: string;
  city?: string;
  title: string;
  details: string;
};

export type CmsTour = {
  id: number;
  title: string;
  slug: string | null;
  /** Denormalized destination name (required on insert in `tours.destination`). */
  destination?: string | null;
  destination_id: number | null;
  destination_ids?: number[];
  duration_days: number | null;
  flow_type: 'enquiry' | 'booking' | 'both' | null;
  tour_region: string | null;
  starting_city: string | null;
  price_from: number | null;
  twin_sharing_price: number | null;
  triple_sharing_price: number | null;
  single_sharing_price: number | null;
  quad_sharing_price: number | null;
  infant_price: number | null;
  child_price: number | null;
  youth_price: number | null;
  sales_price: number | null;
  discounted_price: number | null;
  currency: string | null;
  market_audience: TourMarketAudience;
  max_travellers: number | null;
  min_age: number | null;
  visibility_status: TourVisibilityStatus;
  hero_image_url: string | null;
  gallery_image_urls: string[];
  overview: string | null;
  tour_includes: string[];
  tour_exclusions: string[];
  itinerary_days: CmsTourItineraryDay[];
  trip_code: string | null;
  created_at?: string;
  destinations?: { name: string; slug: string | null } | null;
};

type TourRaw = {
  id: number;
  title?: string | null;
  slug?: string | null;
  destination_id?: number | null;
  destination?: string | null;
  flow_type?: 'enquiry' | 'booking' | 'both' | null;
  tour_region?: string | null;
  starting_city?: string | null;
  duration_days?: number | null;
  twin_sharing_price?: number | null;
  triple_sharing_price?: number | null;
  single_sharing_price?: number | null;
  quad_sharing_price?: number | null;
  infant_price?: number | null;
  child_price?: number | null;
  youth_price?: number | null;
  sales_price?: number | null;
  discounted_price?: number | null;
  max_travellers?: number | null;
  min_age?: number | null;
  visibility_status?: string | null;
  is_active?: boolean | null;
  hero_image_url?: string | null;
  gallery_image_urls?: string[] | null;
  overview?: string | null;
  tour_includes?: string[] | null;
  tour_exclusions?: string[] | null;
  itinerary_days?: CmsTourItineraryDay[] | null;
  created_at?: string | null;
  destination_ref?: { name?: string | null; slug?: string | null } | { name?: string | null; slug?: string | null }[] | null;
  destinations?: { name?: string | null; slug?: string | null } | { name?: string | null; slug?: string | null }[] | null;
};

function pickEmbed(row: TourRaw): { name: string; slug: string | null } | null {
  const embed = row.destination_ref ?? row.destinations;
  if (!embed) return null;
  const first = Array.isArray(embed) ? embed[0] : embed;
  if (!first) return null;
  return { name: String(first.name || '').trim(), slug: first.slug != null ? String(first.slug) : null };
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v || '').trim()).filter(Boolean);
}

function parseItineraryDays(value: unknown): CmsTourItineraryDay[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      const row = entry as { day?: string; city?: string; title?: string; details?: string };
      const city = String(row?.city || '').trim();
      return {
        day: String(row?.day || '').trim(),
        ...(city ? { city } : {}),
        title: String(row?.title || '').trim(),
        details: String(row?.details || '').trim(),
      };
    })
    .filter((entry) => entry.day && entry.title);
}

function mapTourRow(row: TourRaw): CmsTour {
  const embed = pickEmbed(row);
  const twin = row.twin_sharing_price ?? null;
  const price = twin ?? row.discounted_price ?? row.sales_price ?? null;
  const slug = row.slug != null ? String(row.slug).trim() || null : null;
  const childBands = childPricesFromDb(row);
  return {
    id: Number(row.id),
    title: String(row.title || '').trim(),
    slug,
    destination_id: row.destination_id ?? null,
    destination_ids: readTourDestinationIds({
      destination_id: row.destination_id,
      overview: row.overview,
    }),
    destination: String(row.destination || embed?.name || '').trim() || null,
    duration_days: row.duration_days ?? null,
    flow_type: row.flow_type ?? null,
    tour_region: row.tour_region ?? null,
    starting_city: row.starting_city ?? null,
    price_from: price != null ? Number(price) : null,
    twin_sharing_price: twin != null ? Number(twin) : null,
    triple_sharing_price: row.triple_sharing_price ?? null,
    single_sharing_price: row.single_sharing_price ?? null,
    quad_sharing_price: row.quad_sharing_price ?? null,
    infant_price: childBands.infant_price ?? null,
    child_price: childBands.child_price ?? null,
    youth_price: childBands.youth_price ?? null,
    sales_price: row.sales_price ?? null,
    discounted_price: row.discounted_price ?? null,
    market_audience: (() => {
      const meta = parseTourCmsMeta(row.overview);
      return normalizeTourMarketAudience(meta.market_audience);
    })(),
    currency: (() => {
      const meta = parseTourCmsMeta(row.overview);
      const audience = meta.market_audience;
      if (audience === 'global') return 'USD';
      if (audience === 'both') return 'INR/USD';
      return 'INR';
    })(),
    max_travellers: row.max_travellers ?? null,
    min_age: row.min_age ?? null,
    visibility_status: parseTourVisibility(row),
    hero_image_url: row.hero_image_url ?? null,
    gallery_image_urls: parseStringList(row.gallery_image_urls),
    overview: row.overview ?? null,
    tour_includes: parseStringList(row.tour_includes),
    tour_exclusions: parseStringList(row.tour_exclusions),
    itinerary_days: parseItineraryDays(row.itinerary_days),
    trip_code: slug,
    created_at: row.created_at ?? undefined,
    destinations: embed,
  };
}

async function resolveTourDestinationName(input: Partial<CmsTour>): Promise<string> {
  const explicit = String(input.destination || '').trim();
  const ids = readTourDestinationIds({
    destination_id: input.destination_id,
    overview: input.overview,
  });
  if (!ids.length && input.destination_ids?.length) {
    ids.push(...input.destination_ids.filter((id) => Number(id) > 0));
  }

  const names: string[] = [];
  const seen = new Set<number>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const dest = await getDestination(id);
    const name = String(dest?.name || '').trim();
    if (name) names.push(name);
  }
  if (names.length) return names.join(', ');

  if (explicit) return explicit;
  const fromEmbed = String(input.destinations?.name || '').trim();
  if (fromEmbed) return fromEmbed;
  throw new Error('At least one destination is required.');
}

function tourInputToDb(input: Partial<CmsTour>, destinationName: string): Record<string, unknown> {
  const slug = input.slug?.trim() || null;
  const priceFrom = input.price_from ?? input.twin_sharing_price ?? null;
  return {
    title: input.title != null ? String(input.title).trim() : undefined,
    slug,
    destination: destinationName,
    destination_id: input.destination_id,
    duration_days: input.duration_days,
    flow_type: input.flow_type,
    tour_region: input.tour_region?.trim() || null,
    starting_city: input.starting_city?.trim() || null,
    twin_sharing_price: priceFrom,
    triple_sharing_price: input.triple_sharing_price,
    single_sharing_price: input.single_sharing_price,
    quad_sharing_price: input.quad_sharing_price,
    ...childPricesToDb({
      infant_price: input.infant_price,
      child_price: input.child_price,
      youth_price: input.youth_price,
    }),
    sales_price: input.sales_price,
    discounted_price: input.discounted_price,
    max_travellers: input.max_travellers,
    min_age: input.min_age,
    visibility_status: input.visibility_status,
    hero_image_url: input.hero_image_url?.trim() || null,
    gallery_image_urls: input.gallery_image_urls,
    overview: input.overview?.trim() || null,
    tour_includes: input.tour_includes,
    tour_exclusions: input.tour_exclusions,
    itinerary_days: input.itinerary_days,
  };
}

function cleanPayload(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).filter(([, v]) => v !== undefined && v !== '' && v !== null)
  );
}

const TOUR_EMBEDS = [
  'destination_ref:destinations(name,slug)',
  'destinations(name,slug)',
] as const;

const TOUR_LIST_BASE = [
  'id,title,slug,flow_type,visibility_status,destination_id,destination,tour_region,starting_city,duration_days,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,sales_price,discounted_price,max_travellers,min_age,hero_image_url,gallery_image_urls,overview,tour_includes,tour_exclusions,itinerary_days,created_at',
  'id,title,slug,flow_type,destination_id,destination,tour_region,starting_city,duration_days,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,sales_price,discounted_price,max_travellers,min_age,hero_image_url,gallery_image_urls,overview,tour_includes,tour_exclusions,itinerary_days,created_at',
  'id,title,slug,flow_type,destination_id,destination,tour_region,starting_city,duration_days,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,sales_price,discounted_price,hero_image_url,gallery_image_urls,overview,tour_includes,tour_exclusions,itinerary_days,created_at',
  'id,title,slug,flow_type,destination_id,destination,tour_region,starting_city,duration_days,twin_sharing_price,triple_sharing_price,single_sharing_price,child_price,youth_price,sales_price,discounted_price,hero_image_url,gallery_image_urls,overview,tour_includes,tour_exclusions,itinerary_days,created_at',
  'id,title,slug,destination_id,destination,duration_days,twin_sharing_price,sales_price,discounted_price,hero_image_url,gallery_image_urls,overview,tour_includes,tour_exclusions,itinerary_days,created_at',
  'id,title,slug,destination_id,destination,duration_days,twin_sharing_price,hero_image_url,overview,tour_includes,tour_exclusions,created_at',
  'id,title,slug,destination_id,destination,duration_days,twin_sharing_price,hero_image_url,overview',
  'id,title,slug,destination_id,destination,duration_days,hero_image_url',
  'id,title,slug,destination,duration_days',
  'id,title,destination',
] as const;

async function selectToursList(): Promise<CmsTour[]> {
  let lastErr = '';
  for (const base of TOUR_LIST_BASE) {
    for (const embed of TOUR_EMBEDS) {
      const sel = `${base},${embed}`;
      const { data, error } = await supabase.from('tours').select(sel).order('id', { ascending: false });
      if (!error && data) {
        return (data as unknown as TourRaw[]).map(mapTourRow);
      }
      lastErr = String(error?.message || '');
      if (!isSchemaColumnMismatch(lastErr) && !/relationship/i.test(lastErr)) {
        break;
      }
    }
    for (const embed of TOUR_EMBEDS) {
      if (!isSchemaColumnMismatch(lastErr)) break;
    }
  }
  for (const base of TOUR_LIST_BASE) {
    const { data, error } = await supabase.from('tours').select(base).order('id', { ascending: false });
    if (!error && data) {
      return (data as unknown as TourRaw[]).map(mapTourRow);
    }
    lastErr = String(error?.message || '');
    if (!isSchemaColumnMismatch(lastErr)) break;
  }
  throw new Error(`Failed to list tours: ${lastErr}`);
}

/** Fast path after writes — avoids nested embed retries that slow CMS saves. */
async function selectTourByIdQuick(id: number): Promise<TourRaw | null> {
  let lastErr = '';
  for (const base of TOUR_LIST_BASE) {
    const { data, error } = await supabase.from('tours').select(base).eq('id', id).maybeSingle();
    if (!error && data) return data as unknown as TourRaw;
    lastErr = String(error?.message || '');
    // maybeSingle → data:null, error:null when the row is gone
    if (!error && !data) return null;
    if (!isSchemaColumnMismatch(lastErr)) break;
  }
  if (!lastErr || lastErr.includes('0 rows') || lastErr.includes('JSON object requested')) return null;
  return null;
}

async function selectTourById(id: number): Promise<TourRaw | null> {
  let lastErr = '';
  for (const base of TOUR_LIST_BASE) {
    for (const embed of TOUR_EMBEDS) {
      const sel = `${base},${embed}`;
      const { data, error } = await supabase.from('tours').select(sel).eq('id', id).maybeSingle();
      if (!error && data) return data as unknown as TourRaw;
      lastErr = String(error?.message || '');
      // maybeSingle → data:null, error:null when the row is gone (deleted / missing)
      if (!error && !data) return null;
      if (!isSchemaColumnMismatch(lastErr) && !/relationship/i.test(lastErr)) break;
    }
  }
  const quick = await selectTourByIdQuick(id);
  if (quick) return quick;
  // Prefer 404 over 500 when the tour simply does not exist.
  if (!lastErr || lastErr.includes('0 rows') || lastErr.includes('JSON object requested')) return null;
  requestSupabaseRecoveryOnCatalogStale(`cms tour ${id} fetch failed`);
  throw new Error(`Failed to fetch tour: ${lastErr}`);
}

export async function listTours(): Promise<CmsTour[]> {
  return selectToursList();
}

export async function getTour(id: number): Promise<CmsTour | null> {
  const row = await selectTourById(id);
  return row ? mapTourRow(row) : null;
}

async function insertTourWithFallback(payload: Record<string, unknown>): Promise<CmsTour> {
  const keys = Object.keys(payload);
  const insertTries: Record<string, unknown>[] = [];
  for (let i = 0; i <= keys.length; i += 1) {
    const slice = keys.slice(0, Math.max(1, keys.length - i));
    const row: Record<string, unknown> = {};
    for (const key of slice) {
      if (payload[key] !== undefined) row[key] = payload[key];
    }
    if (row.title) insertTries.push(row);
  }
  if (!insertTries.some((r) => r.title)) {
    insertTries.push({ title: payload.title });
  }

  let lastErr = '';
  for (const row of insertTries) {
    const cleaned = cleanPayload(row);
    const { data, error } = await supabase.from('tours').insert(cleaned).select('id').single();
    if (!error && data?.id) {
      const tour = await getTour(Number(data.id));
      if (tour) return tour;
    }
    lastErr = String(error?.message || '');
    if (!isSchemaColumnMismatch(lastErr)) break;
  }
  throw new Error(`Failed to create tour: ${lastErr}`);
}

async function maybeEnsureTourTaxonomyFromOverview(overview: unknown): Promise<void> {
  if (typeof overview !== 'string' || !overview.trim()) return;
  const { meta } = splitOverviewWithMeta(overview);
  await ensureTourTaxonomyFromMeta({
    tour_type: typeof meta.tour_type === 'string' ? meta.tour_type : null,
    tour_experience: typeof meta.tour_experience === 'string' ? meta.tour_experience : null,
  });
}

export async function createTour(input: Partial<CmsTour>): Promise<CmsTour> {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('Tour title is required.');
  const slug =
    (input.slug || title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')).trim() || null;
  const destinationName = await resolveTourDestinationName(input);
  const db = tourInputToDb({ ...input, title, slug }, destinationName);
  const created = await insertTourWithFallback(db);
  await maybeEnsureTourTaxonomyFromOverview(db.overview);
  invalidatePublicCatalogCaches();
  return created;
}

export async function updateTour(id: number, input: Partial<CmsTour>): Promise<CmsTour> {
  const existing = await getTour(id);
  if (!existing) throw new Error('Tour not found.');
  const destinationName = await resolveTourDestinationName({
    ...existing,
    ...input,
    destinations: input.destinations ?? existing.destinations,
  });
  const db = tourInputToDb(input, destinationName);
  const keys = Object.keys(db);
  const patchTries: Record<string, unknown>[] = [];
  for (let i = 0; i <= keys.length; i += 1) {
    const slice = keys.slice(0, Math.max(0, keys.length - i));
    const row: Record<string, unknown> = {};
    for (const key of slice) {
      if (db[key] !== undefined) row[key] = db[key];
    }
    if (Object.keys(row).length) patchTries.push(row);
  }
  if (!patchTries.length) {
    const existing = await getTour(id);
    if (!existing) throw new Error('Tour not found.');
    return existing;
  }

  let lastErr = '';
  for (const patch of patchTries) {
    const cleaned = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const { error } = await supabase.from('tours').update(cleaned).eq('id', id);
    if (!error) {
      const row = await selectTourByIdQuick(id);
      if (!row) throw new Error('Tour not found after update.');
      if (db.overview !== undefined) {
        await maybeEnsureTourTaxonomyFromOverview(db.overview);
      }
      invalidatePublicCatalogCaches();
      return mapTourRow(row);
    }
    lastErr = String(error?.message || '');
    if (!isSchemaColumnMismatch(lastErr)) break;
  }
  throw new Error(`Failed to update tour: ${lastErr}`);
}

export async function deleteTour(id: number): Promise<void> {
  const { error } = await supabase.from('tours').delete().eq('id', id);
  if (!error) {
    invalidatePublicCatalogCaches();
    return;
  }

  const message = String(error.message || '');
  const blockedByBookings =
    /bookings_tour_id_fkey/i.test(message) ||
    /foreign key constraint/i.test(message);

  // Keep booking history intact: if a tour is referenced by bookings,
  // archive it instead of hard-deleting.
  if (blockedByBookings) {
    const archiveTries: Record<string, unknown>[] = [
      { visibility_status: 'inactive', is_active: false },
      { visibility_status: 'inactive' },
      { is_active: false },
    ];
    let archiveError = '';
    for (const patch of archiveTries) {
      const { error: updErr } = await supabase.from('tours').update(patch).eq('id', id);
      if (!updErr) {
        invalidatePublicCatalogCaches();
        return;
      }
      archiveError = String(updErr.message || '');
      if (!isSchemaColumnMismatch(archiveError)) break;
    }
    throw new Error(
      archiveError
        ? `Tour has bookings and could not be archived: ${archiveError}`
        : 'Tour has bookings and could not be archived.'
    );
  }

  throw new Error(message);
}

function uniqueCopySlug(base: string | null, suffix: string): string | null {
  const root = (base || 'tour').trim().toLowerCase().replace(/-copy(-\d+)?$/i, '');
  return `${root}-${suffix}`.replace(/-+/g, '-');
}

export async function duplicateDestination(id: number): Promise<CmsDestination> {
  const src = await getDestination(id);
  if (!src) throw new Error('Destination not found.');
  const stamp = Date.now().toString(36);
  return createDestination({
    name: `${src.name} (Copy)`,
    slug: uniqueCopySlug(src.slug, `copy-${stamp}`),
    country: src.country,
    destination_type: src.destination_type,
    country_id: src.country_id,
    state_id: src.state_id,
    parent_id: src.parent_id,
    description: src.description,
    flag_image_url: src.flag_image_url,
    is_active: false,
  });
}

export async function duplicateTour(id: number): Promise<CmsTour> {
  const src = await getTour(id);
  if (!src) throw new Error('Tour not found.');
  const departures = await listTourDepartures(id);
  const stamp = Date.now().toString(36);
  const created = await createTour({
    title: `${src.title} (Copy)`,
    slug: uniqueCopySlug(src.slug, `copy-${stamp}`),
    destination: src.destination ?? src.destinations?.name ?? undefined,
    destination_id: src.destination_id,
    destinations: src.destinations,
    duration_days: src.duration_days,
    flow_type: src.flow_type,
    tour_region: src.tour_region,
    starting_city: src.starting_city,
    price_from: src.price_from,
    twin_sharing_price: src.twin_sharing_price,
    triple_sharing_price: src.triple_sharing_price,
    single_sharing_price: src.single_sharing_price,
    quad_sharing_price: src.quad_sharing_price,
    infant_price: src.infant_price,
    child_price: src.child_price,
    youth_price: src.youth_price,
    sales_price: src.sales_price,
    discounted_price: src.discounted_price,
    max_travellers: src.max_travellers,
    min_age: src.min_age,
    visibility_status: 'unlisted',
    hero_image_url: src.hero_image_url,
    gallery_image_urls: src.gallery_image_urls,
    overview: src.overview,
    tour_includes: src.tour_includes,
    tour_exclusions: src.tour_exclusions,
    itinerary_days: src.itinerary_days,
  });
  if (departures.length) {
    await replaceTourDepartures(
      created.id,
      departures.map((d) => ({
        ...d,
        id: undefined,
      }))
    );
  }
  const fresh = await getTour(created.id);
  if (!fresh) throw new Error('Tour duplicated but could not be loaded.');
  return fresh;
}
