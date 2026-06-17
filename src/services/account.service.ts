import { supabase } from '../lib/supabase';
import { env } from '../config/env';
import type { AuthContext } from '../middlewares/auth.middleware';

/** Lead-shaped record returned by CRM `/api/customer/by-phone/:phone`. */
export type CrmAssignedStaff = {
  name: string;
  phone: string;
  email: string;
  extension_no: number | string | null;
};

/** CRM lead row returned by `/api/customer/by-phone` / `by-email`. */
export type CrmHistoryLead = {
  lead_id: number;
  mts_id: string | null;
  destination: string | null;
  status: string | null;
  priority: string | null;
  lead_type: string | null;
  services: string[] | null;
  starting_point: string | null;
  tour_region: string | null;
  travel_date: string | null;
  return_date: string | null;
  duration: string | null;
  assigned_staff_name: string | null;
  assigned_staff?: CrmAssignedStaff | null;
  source: string | null;
  /** Legacy — CRM no longer sends raw enquiry summaries to the website. */
  summary?: string | null;
  booking_id_in_requirements: number | string | null;
  created_at: string;
  last_updated: string;
};

export type CrmHistoryCustomer = {
  id: number;
  salutation?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
  date_added: string | null;
  company?: string | null;
  nationality?: string | null;
  gst_number?: string | null;
  pan_number?: string | null;
  date_of_birth?: string | null;
  passport_number?: string | null;
  passport_expiry_date?: string | null;
  address_street?: string | null;
  address_city?: string | null;
  address_state?: string | null;
  address_country?: string | null;
  address_zip?: string | null;
};

export type CrmHistoryResult = {
  customer: CrmHistoryCustomer | null;
  leads: CrmHistoryLead[];
};

export type ProfileRow = {
  id: string;
  email?: string | null;
  full_name?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
  crm_customer_id?: number | null;
  salutation?: string | null;
  company?: string | null;
  nationality?: string | null;
  gst_number?: string | null;
  pan_number?: string | null;
  date_of_birth?: string | null;
  passport_number?: string | null;
  passport_expiry_date?: string | null;
  address_street?: string | null;
  address_city?: string | null;
  address_state?: string | null;
  address_country?: string | null;
  address_zip?: string | null;
};

const PROFILE_SELECT =
  'id,email,full_name,phone,avatar_url,crm_customer_id,salutation,company,nationality,gst_number,pan_number,date_of_birth,passport_number,passport_expiry_date,address_street,address_city,address_state,address_country,address_zip';

export type AccountMePayload = {
  user_id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
  avatar_url: string | null;
  crm_customer_id: number | null;
  salutation: string | null;
  company: string | null;
  nationality: string | null;
  gst_number: string | null;
  pan_number: string | null;
  date_of_birth: string | null;
  passport_number: string | null;
  passport_expiry_date: string | null;
  address_street: string | null;
  address_city: string | null;
  address_state: string | null;
  address_country: string | null;
  address_zip: string | null;
  /** Latest CRM snapshot for this login (phone/email match). */
  crm_customer: CrmHistoryCustomer | null;
};

function crmFullName(c: CrmHistoryCustomer | null | undefined): string | null {
  if (!c) return null;
  const direct = String(c.full_name || '').trim();
  if (direct) return direct;
  const joined = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return joined || null;
}

function isEmpty(v: unknown): boolean {
  return v == null || String(v).trim() === '';
}

function pickLocalOrCrm(local: unknown, crmVal: unknown): string | null {
  if (!isEmpty(local)) return String(local).trim();
  if (crmVal != null && !isEmpty(crmVal)) return String(crmVal).trim();
  return null;
}

/** Loads profiles row from DB (extended columns — falls back if migration not applied). */
export async function fetchProfileRowForUser(userId: string): Promise<ProfileRow | null> {
  const attempt = async (sel: string) =>
    supabase.from('profiles').select(sel).eq('id', userId).maybeSingle();

  const wide = await attempt(PROFILE_SELECT);
  if (!wide.error && wide.data)
    return wide.data as unknown as ProfileRow;

  const narrow = await attempt('id,email,full_name,phone,avatar_url,crm_customer_id');
  if (!narrow.error && narrow.data)
    return narrow.data as unknown as ProfileRow;

  return null;
}

/**
 * When the website profile row still has blank fields, copy values from the CRM
 * customer record so name / passport / address appear without manual re-entry.
 */
export async function persistProfileFieldsFromCrm(
  userId: string,
  crm: CrmHistoryResult
): Promise<void> {
  const c = crm.customer;
  if (!c?.id) return;

  const row = await fetchProfileRowForUser(userId);
  if (!row) return;

  const patch: Record<string, string | number | null> = {};

  const nm = crmFullName(c);
  if (isEmpty(row.full_name) && nm) patch.full_name = nm;
  if (!(row.crm_customer_id != null && row.crm_customer_id > 0)) patch.crm_customer_id = c.id;
  if (isEmpty(row.phone) && c.phone) patch.phone = String(c.phone).trim();

  const pairs: [keyof ProfileRow, keyof CrmHistoryCustomer][] = [
    ['salutation', 'salutation'],
    ['company', 'company'],
    ['nationality', 'nationality'],
    ['gst_number', 'gst_number'],
    ['pan_number', 'pan_number'],
    ['date_of_birth', 'date_of_birth'],
    ['passport_number', 'passport_number'],
    ['passport_expiry_date', 'passport_expiry_date'],
    ['address_street', 'address_street'],
    ['address_city', 'address_city'],
    ['address_state', 'address_state'],
    ['address_country', 'address_country'],
    ['address_zip', 'address_zip'],
  ];
  for (const [pk, ck] of pairs) {
    const cur = row[pk];
    const next = c[ck];
    if (isEmpty(cur) && next != null && !isEmpty(next)) {
      patch[pk as string] = String(next).trim();
    }
  }

  if (Object.keys(patch).length === 0) return;

  const { error } = await supabase.from('profiles').update(patch).eq('id', userId);
  if (error && /column/i.test(String(error.message))) {
    const minimal: Record<string, string | number> = {};
    if ('full_name' in patch && patch.full_name) minimal.full_name = String(patch.full_name);
    if ('crm_customer_id' in patch && patch.crm_customer_id != null) {
      minimal.crm_customer_id = patch.crm_customer_id as number;
    }
    if ('phone' in patch && patch.phone) minimal.phone = String(patch.phone);
    if (Object.keys(minimal).length === 0) return;
    const retry = await supabase.from('profiles').update(minimal).eq('id', userId);
    if (retry.error) {
      // eslint-disable-next-line no-console
      console.warn('[account] CRM→profile sync fallback failed:', retry.error.message);
    }
    return;
  }
  if (error) {
    // eslint-disable-next-line no-console
    console.warn('[account] CRM→profile sync failed:', error.message);
  }
}

export function buildAccountMePayload(
  ctx: AuthContext,
  profile: ProfileRow | null,
  crm: CrmHistoryResult
): AccountMePayload {
  const c = crm.customer;
  return {
    user_id: ctx.userId,
    email: ctx.email ?? profile?.email ?? null,
    full_name: pickLocalOrCrm(profile?.full_name ?? ctx.fullName, crmFullName(c)),
    phone: pickLocalOrCrm(profile?.phone ?? ctx.phone, c?.phone ?? null),
    avatar_url: pickLocalOrCrm(profile?.avatar_url ?? ctx.avatarUrl, c?.avatar_url ?? null),
    crm_customer_id:
      ctx.crmCustomerId ?? profile?.crm_customer_id ?? (c?.id != null ? c.id : null),
    salutation: pickLocalOrCrm(profile?.salutation, c?.salutation ?? null),
    company: pickLocalOrCrm(profile?.company, c?.company ?? null),
    nationality: pickLocalOrCrm(profile?.nationality, c?.nationality ?? null),
    gst_number: pickLocalOrCrm(profile?.gst_number, c?.gst_number ?? null),
    pan_number: pickLocalOrCrm(profile?.pan_number, c?.pan_number ?? null),
    date_of_birth: pickLocalOrCrm(profile?.date_of_birth, c?.date_of_birth ?? null),
    passport_number: pickLocalOrCrm(profile?.passport_number, c?.passport_number ?? null),
    passport_expiry_date: pickLocalOrCrm(
      profile?.passport_expiry_date,
      c?.passport_expiry_date ?? null
    ),
    address_street: pickLocalOrCrm(profile?.address_street, c?.address_street ?? null),
    address_city: pickLocalOrCrm(profile?.address_city, c?.address_city ?? null),
    address_state: pickLocalOrCrm(profile?.address_state, c?.address_state ?? null),
    address_country: pickLocalOrCrm(profile?.address_country, c?.address_country ?? null),
    address_zip: pickLocalOrCrm(profile?.address_zip, c?.address_zip ?? null),
    crm_customer: c,
  };
}

export async function buildAccountMeForUser(ctx: AuthContext): Promise<AccountMePayload> {
  let crm: CrmHistoryResult = { customer: null, leads: [] };
  try {
    crm = await fetchCrmHistoryForProfile(ctx.phone, ctx.email);
  } catch {
    crm = { customer: null, leads: [] };
  }
  await persistProfileFieldsFromCrm(ctx.userId, crm);
  const profile = await fetchProfileRowForUser(ctx.userId);
  return buildAccountMePayload(ctx, profile, crm);
}

function requireCrmIntegration(): { base: string; secret: string } {
  const base = String(env.CRM_API_URL || '').replace(/\/$/, '');
  const secret = String(env.CRM_WEB_INTEGRATION_SECRET || '').trim();
  if (!base || !secret) {
    throw new Error(
      'Travel account services are temporarily unavailable. Please try again later.'
    );
  }
  return { base, secret };
}

const CRM_FETCH_TIMEOUT_MS = 15000;

async function crmFetch(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), CRM_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

/**
 * Fetch CRM lead history: **phone first** (last 10 digits), then **login email**
 * when phone is missing or too short — matches CRM customers created with email only.
 */
export async function fetchCrmHistoryForProfile(
  phone: string | null | undefined,
  email: string | null | undefined
): Promise<CrmHistoryResult> {
  const { base, secret } = requireCrmIntegration();
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length >= 10) {
    const last10 = digits.slice(-10);
    try {
      const response = await crmFetch(`${base}/api/customer/by-phone/${encodeURIComponent(last10)}`, {
        method: 'GET',
        headers: { 'x-integration-secret': secret },
      });
      if (response.ok) {
        return (await response.json()) as CrmHistoryResult;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[account] CRM by-phone fetch failed:', err);
    }
  }

  const em = String(email || '')
    .trim()
    .toLowerCase();
  if (em.includes('@')) {
    try {
      const response = await crmFetch(
        `${base}/api/customer/by-email/${encodeURIComponent(em)}`,
        {
          method: 'GET',
          headers: { 'x-integration-secret': secret },
        }
      );
      if (response.ok) {
        return (await response.json()) as CrmHistoryResult;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[account] CRM by-email fetch failed:', err);
    }
  }

  return { customer: null, leads: [] };
}

/** @deprecated use fetchCrmHistoryForProfile — kept for direct callers */
export async function fetchCrmHistoryForPhone(phone: string): Promise<CrmHistoryResult> {
  return fetchCrmHistoryForProfile(phone, null);
}

/** Fields sent to CRM on profile save (phone match takes priority over email on the CRM side). */
export type ProfileCrmSnapshot = {
  full_name?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
  email?: string | null;
  salutation?: string | null;
  company?: string | null;
  nationality?: string | null;
  gst_number?: string | null;
  pan_number?: string | null;
  date_of_birth?: string | null;
  passport_number?: string | null;
  passport_expiry_date?: string | null;
  address_street?: string | null;
  address_city?: string | null;
  address_state?: string | null;
  address_country?: string | null;
  address_zip?: string | null;
};

function profilePatchHasCrmExtras(p: ProfileCrmSnapshot): boolean {
  const keys: (keyof ProfileCrmSnapshot)[] = [
    'salutation',
    'company',
    'nationality',
    'gst_number',
    'pan_number',
    'date_of_birth',
    'passport_number',
    'passport_expiry_date',
    'address_street',
    'address_city',
    'address_state',
    'address_country',
    'address_zip',
  ];
  return keys.some((k) => typeof p[k] === 'string' && String(p[k]).trim() !== '');
}

/**
 * Push a profile change to the CRM customers table. Persists the resolved
 * crm_customer_id on the local profile so subsequent syncs stay in lockstep.
 *
 * Pass a **full snapshot** after saving to Supabase (`profile` row + auth email)
 * so name, phone, avatar, and email are all pushed together — not only the
 * fields that changed in the last PATCH.
 */
export async function syncProfileToCrm(
  ctx: AuthContext,
  patch: ProfileCrmSnapshot
): Promise<{ crm_customer_id: number; action: 'created' | 'updated' } | null> {
  const { base, secret } = requireCrmIntegration();
  const fullName = String(patch.full_name ?? ctx.fullName ?? '').trim();
  const phone = String(patch.phone ?? ctx.phone ?? '').trim();
  const avatarUrl = String(patch.avatar_url ?? ctx.avatarUrl ?? '').trim();
  const email = String(patch.email ?? ctx.email ?? '').trim();

  const body: Record<string, unknown> = {
    crm_customer_id: ctx.crmCustomerId || undefined,
    full_name: fullName || undefined,
    email: email || undefined,
    phone: phone || undefined,
    avatar_url: avatarUrl || undefined,
    match_priority: 'phone_then_email',
  };

  const extras: (keyof ProfileCrmSnapshot)[] = [
    'salutation',
    'company',
    'nationality',
    'gst_number',
    'pan_number',
    'date_of_birth',
    'passport_number',
    'passport_expiry_date',
    'address_street',
    'address_city',
    'address_state',
    'address_country',
    'address_zip',
  ];
  for (const k of extras) {
    const v = patch[k];
    if (typeof v === 'string' && v.trim()) body[k] = v.trim();
  }

  if (
    !fullName &&
    !phone &&
    !email &&
    !profilePatchHasCrmExtras(patch) &&
    !(ctx.crmCustomerId && ctx.crmCustomerId > 0)
  ) {
    return null;
  }

  const response = await crmFetch(`${base}/api/customer/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-integration-secret': secret,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('Could not update your profile. Please try again.');
  }
  const payload = (await response.json()) as {
    customer_id?: number;
    action?: 'created' | 'updated';
  };
  if (!payload.customer_id) return null;

  // Persist crm_customer_id on profiles so future calls don't re-resolve.
  if (payload.customer_id !== ctx.crmCustomerId) {
    try {
      await supabase
        .from('profiles')
        .update({ crm_customer_id: payload.customer_id })
        .eq('id', ctx.userId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[account] crm_customer_id persist skipped:', err);
    }
  }
  return { crm_customer_id: payload.customer_id, action: payload.action || 'updated' };
}

export type DashboardBooking = {
  id: number;
  status: string | null;
  payment_status: string | null;
  total_price: number | null;
  payment_amount: number | null;
  payment_currency: string | null;
  display_currency: string | null;
  display_fx_rate: number | null;
  mts_id: string | null;
  crm_lead_id: number | null;
  rooms: number | null;
  room_details: unknown;
  created_at: string;
  payment_verified_at: string | null;
  tour: { id: number; title: string; destination: string | null } | null;
  departure: {
    id: number;
    city: string | null;
    start_date: string | null;
    end_date: string | null;
  } | null;
};

/** Bookings + tour/departure info for a given user. Service-role read so RLS doesn't matter here. */
export async function fetchBookingsForUser(userId: string): Promise<DashboardBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id,status,payment_status,total_price,payment_amount,payment_currency,display_currency,display_fx_rate,mts_id,crm_lead_id,rooms,room_details,created_at,payment_verified_at,tour:tours(id,title,destination),departure:departures(id,city,start_date,end_date)'
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`Failed to load bookings: ${error.message}`);
  return ((data || []) as unknown) as DashboardBooking[];
}

export type DashboardEnquiry = {
  id: number;
  destination: string | null;
  travel_date: string | null;
  duration: string | null;
  adults: number | null;
  children: number | null;
  rooms: number | null;
  tour_title: string | null;
  created_at: string;
};

export async function fetchEnquiriesForUser(userId: string): Promise<DashboardEnquiry[]> {
  // The enquiries table varies by deployment age — pick conservative columns.
  const select =
    'id,destination,travel_date,duration,adults,children,rooms,tour_title,created_at';
  const { data, error } = await supabase
    .from('enquiries')
    .select(select)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    const msg = String(error.message || '');
    // Table never created or not exposed to PostgREST — normal until you migrate.
    if (
      /relation .* does not exist/i.test(msg) ||
      /could not find the table/i.test(msg) ||
      /schema cache/i.test(msg) ||
      /column .*user_id/i.test(msg)
    ) {
      return [];
    }
    // Forward-compatible: drop unknown columns if any are missing.
    if (/column .* does not exist/i.test(msg)) {
      const fallback = await supabase
        .from('enquiries')
        .select('id,destination,travel_date,created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (fallback.error) {
        return [];
      }
      return ((fallback.data || []) as unknown) as DashboardEnquiry[];
    }
    // eslint-disable-next-line no-console
    console.warn('[account] enquiries query failed:', msg);
    return [];
  }
  return ((data || []) as unknown) as DashboardEnquiry[];
}

/** Update profile + push to CRM. Returns the patched profile. */
export async function updateProfileAndSyncToCrm(
  ctx: AuthContext,
  patch: Partial<ProfileCrmSnapshot>
) {
  const cleaned: Record<string, string | null> = {};
  const strKeys: (keyof ProfileCrmSnapshot)[] = [
    'full_name',
    'phone',
    'avatar_url',
    'salutation',
    'company',
    'nationality',
    'gst_number',
    'pan_number',
    'date_of_birth',
    'passport_number',
    'passport_expiry_date',
    'address_street',
    'address_city',
    'address_state',
    'address_country',
    'address_zip',
  ];
  for (const k of strKeys) {
    if (typeof patch[k] === 'string') cleaned[k as string] = String(patch[k]).trim() || null;
  }

  if (Object.keys(cleaned).length === 0) {
    throw new Error('Nothing to update.');
  }

  const { data: updated, error } = await supabase
    .from('profiles')
    .update(cleaned)
    .eq('id', ctx.userId)
    .select(PROFILE_SELECT)
    .single();
  if (error || !updated) {
    const fallback = await supabase
      .from('profiles')
      .update(cleaned)
      .eq('id', ctx.userId)
      .select('id,email,full_name,phone,avatar_url,crm_customer_id')
      .single();
    if (fallback.error || !fallback.data) {
      throw new Error(`Failed to update profile: ${error?.message || fallback.error?.message || 'unknown error'}`);
    }
    return finishProfileSync(ctx, fallback.data as ProfileRow);
  }

  return finishProfileSync(ctx, updated as ProfileRow);
}

export const CUSTOMER_DOCUMENT_TYPES = [
  'passports',
  'visas',
  'aadhaarCards',
  'panCards',
  'bankStatements',
  'otherDocuments',
] as const;

export type CustomerDocumentType = (typeof CUSTOMER_DOCUMENT_TYPES)[number];

export type AccountDocumentSummary = {
  id: number | null;
  doc_type: CustomerDocumentType;
  file_name: string;
  file_type: string;
  file_size: number;
  label: string;
  type_label: string;
  person_name: string | null;
  notes: string | null;
  uploaded_via: string | null;
  can_delete: boolean;
};

/** Ensure the signed-in user is linked to a CRM customer (sync profile if needed). */
export async function ensureCrmCustomerId(ctx: AuthContext): Promise<number> {
  if (ctx.crmCustomerId != null && ctx.crmCustomerId > 0) {
    return ctx.crmCustomerId;
  }
  const profile = await fetchProfileRowForUser(ctx.userId);
  const linkedId = profile?.crm_customer_id;
  if (linkedId != null && linkedId > 0) {
    return linkedId;
  }
  const sync = await syncProfileToCrm(
    {
      ...ctx,
      crmCustomerId: linkedId ?? ctx.crmCustomerId,
    },
    {
      full_name: profile?.full_name ?? ctx.fullName,
      phone: profile?.phone ?? ctx.phone,
      email: profile?.email ?? ctx.email,
      avatar_url: profile?.avatar_url ?? ctx.avatarUrl,
    }
  );
  if (!sync?.crm_customer_id) {
    throw new Error(
      'We could not match your account yet. Add your phone or email on your profile first.'
    );
  }
  return sync.crm_customer_id;
}

export async function fetchAccountDocuments(
  ctx: AuthContext
): Promise<AccountDocumentSummary[]> {
  const customerId = await ensureCrmCustomerId(ctx);
  const { base, secret } = requireCrmIntegration();
  const response = await crmFetch(`${base}/api/customer/${customerId}/documents`, {
    method: 'GET',
    headers: { 'x-integration-secret': secret },
  });
  if (!response.ok) {
    throw new Error('Could not load your documents. Please try again.');
  }
  const payload = (await response.json()) as { documents?: AccountDocumentSummary[] };
  return Array.isArray(payload.documents) ? payload.documents : [];
}

export async function uploadAccountDocument(
  ctx: AuthContext,
  input: {
    doc_type: CustomerDocumentType;
    file: { name: string; type: string; size: number; content: string };
    label?: string;
    notes?: string;
  }
): Promise<AccountDocumentSummary> {
  if (!CUSTOMER_DOCUMENT_TYPES.includes(input.doc_type)) {
    throw new Error('Invalid document type.');
  }
  const customerId = await ensureCrmCustomerId(ctx);
  const { base, secret } = requireCrmIntegration();
  const response = await crmFetch(`${base}/api/customer/${customerId}/documents`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-integration-secret': secret,
    },
    body: JSON.stringify({
      doc_type: input.doc_type,
      file: input.file,
      label: input.label,
      notes: input.notes,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      (payload as { message?: string })?.message ||
        `Failed to upload document (${response.status}).`
    );
  }
  const doc = (payload as { document?: AccountDocumentSummary }).document;
  if (!doc) {
    throw new Error('Document upload succeeded but no document was returned.');
  }
  return doc;
}

export async function fetchAccountDocumentFile(
  ctx: AuthContext,
  docType: CustomerDocumentType,
  docId: number | string
): Promise<{ buffer: Buffer; contentType: string; fileName: string }> {
  if (!CUSTOMER_DOCUMENT_TYPES.includes(docType)) {
    throw new Error('Invalid document type.');
  }
  const customerId = await ensureCrmCustomerId(ctx);
  const { base, secret } = requireCrmIntegration();
  const response = await crmFetch(
    `${base}/api/customer/${customerId}/documents/${encodeURIComponent(docType)}/${encodeURIComponent(String(docId))}/file`,
    {
      method: 'GET',
      headers: { 'x-integration-secret': secret },
    }
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(
      (payload as { message?: string })?.message || 'Could not open document.'
    );
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream';
  const disposition = response.headers.get('content-disposition') || '';
  const nameMatch = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const fileName = nameMatch?.[1] ? decodeURIComponent(nameMatch[1]) : 'document';
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer, contentType, fileName };
}

export async function deleteAccountDocument(
  ctx: AuthContext,
  docType: CustomerDocumentType,
  docId: number | string
): Promise<void> {
  if (!CUSTOMER_DOCUMENT_TYPES.includes(docType)) {
    throw new Error('Invalid document type.');
  }
  const customerId = await ensureCrmCustomerId(ctx);
  const { base, secret } = requireCrmIntegration();
  const response = await crmFetch(
    `${base}/api/customer/${customerId}/documents/${encodeURIComponent(docType)}/${encodeURIComponent(String(docId))}`,
    {
      method: 'DELETE',
      headers: { 'x-integration-secret': secret },
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      (payload as { message?: string })?.message || 'Could not delete document.'
    );
  }
}

async function finishProfileSync(ctx: AuthContext, u: ProfileRow) {
  const snapshotCtx: AuthContext = {
    ...ctx,
    fullName: u.full_name ?? null,
    phone: u.phone ?? null,
    avatarUrl: u.avatar_url ?? null,
    crmCustomerId: u.crm_customer_id ?? null,
  };
  const snapshot: ProfileCrmSnapshot = {
    full_name: u.full_name,
    phone: u.phone,
    avatar_url: u.avatar_url,
    email: u.email ?? ctx.email,
    salutation: u.salutation,
    company: u.company,
    nationality: u.nationality,
    gst_number: u.gst_number,
    pan_number: u.pan_number,
    date_of_birth: u.date_of_birth,
    passport_number: u.passport_number,
    passport_expiry_date: u.passport_expiry_date,
    address_street: u.address_street,
    address_city: u.address_city,
    address_state: u.address_state,
    address_country: u.address_country,
    address_zip: u.address_zip,
  };

  void syncProfileToCrm(snapshotCtx, snapshot).catch((err) => {
    // eslint-disable-next-line no-console
    console.warn('[account] background CRM profile sync failed:', err);
  });

  return {
    profile: u,
    crm: null,
    crm_sync_started: true as const,
  };
}
