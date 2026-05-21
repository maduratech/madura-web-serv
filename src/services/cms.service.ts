import { supabase } from '../lib/supabase';

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

export async function listCmsStaff(): Promise<CmsStaffRow[]> {
  const { data, error } = await supabase
    .from('cms_staff')
    .select('id,email,full_name,role,is_active,created_at,updated_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []) as CmsStaffRow[];
}

export async function upsertCmsStaff(input: {
  email: string;
  full_name?: string | null;
  role: 'staff' | 'super_admin';
}): Promise<CmsStaffRow> {
  const email = input.email.trim().toLowerCase();
  const { data: authList, error: authErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (authErr) throw new Error(authErr.message);
  const authUser = authList.users.find((u) => (u.email || '').toLowerCase() === email);
  if (!authUser) {
    throw new Error(
      `No website account for ${email}. Ask them to sign up on the site first, then add them here.`
    );
  }
  const { data, error } = await supabase
    .from('cms_staff')
    .upsert(
      {
        id: authUser.id,
        email: authUser.email || email,
        full_name: input.full_name?.trim() || null,
        role: input.role,
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

export type CmsDestination = {
  id: number;
  name: string;
  slug: string | null;
  country: string | null;
  description: string | null;
  is_active: boolean | null;
  flag_image_url: string | null;
  created_at?: string;
};

type DestinationRaw = {
  id: number;
  name?: string | null;
  slug?: string | null;
  country?: string | null;
  country_region?: string | null;
  description?: string | null;
  is_active?: boolean | null;
  flag_image_url?: string | null;
  created_at?: string | null;
};

function mapDestinationRow(row: DestinationRaw): CmsDestination {
  return {
    id: Number(row.id),
    name: String(row.name || '').trim(),
    slug: row.slug != null ? String(row.slug).trim() || null : null,
    country: (row.country ?? row.country_region ?? null) as string | null,
    description: row.description ?? null,
    is_active: row.is_active ?? true,
    flag_image_url: row.flag_image_url ?? null,
    created_at: row.created_at ?? undefined,
  };
}

async function selectDestinations(cols: string) {
  return supabase.from('destinations').select(cols).order('name');
}

export async function listDestinations(): Promise<CmsDestination[]> {
  const tries = [
    'id,name,slug,country_region,flag_image_url,created_at',
    'id,name,slug,flag_image_url,created_at',
    'id,name,slug,country_region,flag_iso,created_at',
    'id,name,slug,created_at',
    'id,name,slug',
    'id,name',
  ];
  let lastErr = '';
  for (const cols of tries) {
    const { data, error } = await selectDestinations(cols);
    if (!error && data) {
      return (data as unknown as DestinationRaw[]).map(mapDestinationRow);
    }
    lastErr = String(error?.message || '');
    if (!/column .* does not exist/i.test(lastErr)) break;
  }
  throw new Error(`Failed to list destinations: ${lastErr}`);
}

export async function getDestination(id: number): Promise<CmsDestination | null> {
  const tries = [
    'id,name,slug,country_region,flag_image_url,created_at',
    'id,name,slug,flag_image_url,created_at',
    'id,name,slug,created_at',
    'id,name,slug',
    'id,name',
  ];
  let lastErr = '';
  for (const cols of tries) {
    const { data, error } = await supabase.from('destinations').select(cols).eq('id', id).maybeSingle();
    if (!error && data) return mapDestinationRow(data as unknown as DestinationRaw);
    lastErr = String(error?.message || '');
    if (!/column .* does not exist/i.test(lastErr)) break;
  }
  if (lastErr.includes('0 rows')) return null;
  throw new Error(`Failed to fetch destination: ${lastErr}`);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

async function insertDestinationWithFallback(payload: Record<string, unknown>): Promise<CmsDestination> {
  const insertTries = [
    { name: payload.name, slug: payload.slug, country_region: payload.country, flag_image_url: payload.flag_image_url },
    { name: payload.name, slug: payload.slug, flag_image_url: payload.flag_image_url },
    { name: payload.name, slug: payload.slug },
    { name: payload.name },
  ];
  let lastErr = '';
  for (const row of insertTries) {
    const cleaned = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined));
    const { data, error } = await supabase.from('destinations').insert(cleaned).select('id').single();
    if (!error && data?.id) return getDestination(Number(data.id)) as Promise<CmsDestination>;
    lastErr = String(error?.message || '');
    if (!/column .* does not exist/i.test(lastErr)) break;
  }
  throw new Error(`Failed to create destination: ${lastErr}`);
}

export async function createDestination(input: Partial<CmsDestination>): Promise<CmsDestination> {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Destination name is required.');
  const slug = (input.slug || slugify(name)).trim() || slugify(name);
  return insertDestinationWithFallback({
    name,
    slug,
    country: input.country?.trim() || null,
    flag_image_url: input.flag_image_url?.trim() || null,
  });
}

export async function updateDestination(id: number, input: Partial<CmsDestination>): Promise<CmsDestination> {
  const patchVariants: Record<string, unknown>[] = [
    {
      ...(input.name !== undefined ? { name: String(input.name).trim() } : {}),
      ...(input.slug !== undefined ? { slug: String(input.slug).trim() || slugify(String(input.name || '')) } : {}),
      ...(input.country !== undefined ? { country_region: input.country?.trim() || null } : {}),
      ...(input.flag_image_url !== undefined ? { flag_image_url: input.flag_image_url?.trim() || null } : {}),
    },
    {
      ...(input.name !== undefined ? { name: String(input.name).trim() } : {}),
      ...(input.slug !== undefined ? { slug: String(input.slug).trim() || slugify(String(input.name || '')) } : {}),
      ...(input.flag_image_url !== undefined ? { flag_image_url: input.flag_image_url?.trim() || null } : {}),
    },
    {
      ...(input.name !== undefined ? { name: String(input.name).trim() } : {}),
      ...(input.slug !== undefined ? { slug: String(input.slug).trim() || slugify(String(input.name || '')) } : {}),
    },
  ];
  let lastErr = '';
  for (const patch of patchVariants) {
    const cleaned = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(cleaned).length) return getDestination(id) as Promise<CmsDestination>;
    const { error } = await supabase.from('destinations').update(cleaned).eq('id', id);
    if (!error) return getDestination(id) as Promise<CmsDestination>;
    lastErr = String(error?.message || '');
    if (!/column .* does not exist/i.test(lastErr)) break;
  }
  throw new Error(`Failed to update destination: ${lastErr}`);
}

export async function deleteDestination(id: number): Promise<void> {
  const { count } = await supabase.from('tours').select('id', { count: 'exact', head: true }).eq('destination_id', id);
  if (count && count > 0) {
    throw new Error('Cannot delete: tours are linked to this destination. Remove or reassign tours first.');
  }
  const { error } = await supabase.from('destinations').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export type CmsTour = {
  id: number;
  title: string;
  slug: string | null;
  destination_id: number | null;
  duration_days: number | null;
  price_from: number | null;
  currency: string | null;
  is_active: boolean | null;
  hero_image_url: string | null;
  overview: string | null;
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
  duration_days?: number | null;
  twin_sharing_price?: number | null;
  sales_price?: number | null;
  discounted_price?: number | null;
  hero_image_url?: string | null;
  overview?: string | null;
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

function mapTourRow(row: TourRaw): CmsTour {
  const embed = pickEmbed(row);
  const price =
    row.twin_sharing_price ?? row.discounted_price ?? row.sales_price ?? null;
  return {
    id: Number(row.id),
    title: String(row.title || '').trim(),
    slug: row.slug != null ? String(row.slug).trim() || null : null,
    destination_id: row.destination_id ?? null,
    duration_days: row.duration_days ?? null,
    price_from: price != null ? Number(price) : null,
    currency: 'INR',
    is_active: true,
    hero_image_url: row.hero_image_url ?? null,
    overview: row.overview ?? null,
    trip_code: row.slug ? String(row.slug) : null,
    created_at: row.created_at ?? undefined,
    destinations: embed,
  };
}

const TOUR_EMBEDS = [
  'destination_ref:destinations(name,slug)',
  'destinations(name,slug)',
] as const;

const TOUR_LIST_BASE = [
  'id,title,slug,destination_id,destination,duration_days,twin_sharing_price,sales_price,discounted_price,hero_image_url,overview,created_at',
  'id,title,slug,destination_id,destination,duration_days,twin_sharing_price,hero_image_url,overview',
  'id,title,slug,destination_id,destination,duration_days,hero_image_url,overview',
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
      if (!/column .* does not exist|relationship|schema cache/i.test(lastErr)) {
        break;
      }
    }
    for (const embed of TOUR_EMBEDS) {
      if (!/column .* does not exist/i.test(lastErr)) break;
    }
  }
  for (const base of TOUR_LIST_BASE) {
    const { data, error } = await supabase.from('tours').select(base).order('id', { ascending: false });
    if (!error && data) {
      return (data as unknown as TourRaw[]).map(mapTourRow);
    }
    lastErr = String(error?.message || '');
    if (!/column .* does not exist/i.test(lastErr)) break;
  }
  throw new Error(`Failed to list tours: ${lastErr}`);
}

async function selectTourById(id: number): Promise<TourRaw | null> {
  let lastErr = '';
  for (const base of TOUR_LIST_BASE) {
    for (const embed of TOUR_EMBEDS) {
      const sel = `${base},${embed}`;
      const { data, error } = await supabase.from('tours').select(sel).eq('id', id).maybeSingle();
      if (!error && data) return data as unknown as TourRaw;
      lastErr = String(error?.message || '');
      if (!/column .* does not exist|relationship|schema cache/i.test(lastErr)) break;
    }
  }
  for (const base of TOUR_LIST_BASE) {
    const { data, error } = await supabase.from('tours').select(base).eq('id', id).maybeSingle();
    if (!error && data) return data as unknown as TourRaw;
    lastErr = String(error?.message || '');
    if (!/column .* does not exist/i.test(lastErr)) break;
  }
  if (lastErr.includes('0 rows') || lastErr.includes('JSON object requested')) return null;
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
  const insertTries: Record<string, unknown>[] = [
    {
      title: payload.title,
      slug: payload.slug,
      destination_id: payload.destination_id,
      duration_days: payload.duration_days,
      twin_sharing_price: payload.price_from,
      hero_image_url: payload.hero_image_url,
      overview: payload.overview,
    },
    {
      title: payload.title,
      slug: payload.slug,
      destination_id: payload.destination_id,
      duration_days: payload.duration_days,
      hero_image_url: payload.hero_image_url,
      overview: payload.overview,
    },
    {
      title: payload.title,
      destination_id: payload.destination_id,
      duration_days: payload.duration_days,
    },
    { title: payload.title },
  ];
  let lastErr = '';
  for (const row of insertTries) {
    const cleaned = Object.fromEntries(
      Object.entries(row).filter(([, v]) => v !== undefined && v !== null && v !== '')
    );
    const { data, error } = await supabase.from('tours').insert(cleaned).select('id').single();
    if (!error && data?.id) {
      const tour = await getTour(Number(data.id));
      if (tour) return tour;
    }
    lastErr = String(error?.message || '');
    if (!/column .* does not exist/i.test(lastErr)) break;
  }
  throw new Error(`Failed to create tour: ${lastErr}`);
}

export async function createTour(input: Partial<CmsTour>): Promise<CmsTour> {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('Tour title is required.');
  const slug =
    (input.slug || title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')).trim() || null;
  return insertTourWithFallback({
    title,
    slug,
    destination_id: input.destination_id ?? null,
    duration_days: input.duration_days ?? null,
    price_from: input.price_from ?? null,
    hero_image_url: input.hero_image_url?.trim() || null,
    overview: input.overview?.trim() || null,
  });
}

export async function updateTour(id: number, input: Partial<CmsTour>): Promise<CmsTour> {
  const patchVariants: Record<string, unknown>[] = [
    {
      ...(input.title !== undefined ? { title: String(input.title).trim() } : {}),
      ...(input.slug !== undefined ? { slug: input.slug?.trim() || null } : {}),
      ...(input.destination_id !== undefined ? { destination_id: input.destination_id } : {}),
      ...(input.duration_days !== undefined ? { duration_days: input.duration_days } : {}),
      ...(input.price_from !== undefined ? { twin_sharing_price: input.price_from } : {}),
      ...(input.hero_image_url !== undefined ? { hero_image_url: input.hero_image_url?.trim() || null } : {}),
      ...(input.overview !== undefined ? { overview: input.overview?.trim() || null } : {}),
    },
    {
      ...(input.title !== undefined ? { title: String(input.title).trim() } : {}),
      ...(input.slug !== undefined ? { slug: input.slug?.trim() || null } : {}),
      ...(input.destination_id !== undefined ? { destination_id: input.destination_id } : {}),
      ...(input.duration_days !== undefined ? { duration_days: input.duration_days } : {}),
      ...(input.hero_image_url !== undefined ? { hero_image_url: input.hero_image_url?.trim() || null } : {}),
      ...(input.overview !== undefined ? { overview: input.overview?.trim() || null } : {}),
    },
  ];
  let lastErr = '';
  for (const patch of patchVariants) {
    const cleaned = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (!Object.keys(cleaned).length) {
      const existing = await getTour(id);
      if (!existing) throw new Error('Tour not found.');
      return existing;
    }
    const { error } = await supabase.from('tours').update(cleaned).eq('id', id);
    if (!error) {
      const updated = await getTour(id);
      if (!updated) throw new Error('Tour not found after update.');
      return updated;
    }
    lastErr = String(error?.message || '');
    if (!/column .* does not exist/i.test(lastErr)) break;
  }
  throw new Error(`Failed to update tour: ${lastErr}`);
}

export async function deleteTour(id: number): Promise<void> {
  const { error } = await supabase.from('tours').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
