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
    'id,name,slug,country_region,flag_image_url,description,created_at',
    'id,name,slug,flag_image_url,description,created_at',
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
    'id,name,slug,country_region,flag_image_url,description,created_at',
    'id,name,slug,flag_image_url,description,created_at',
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
    { name: payload.name, slug: payload.slug, country_region: payload.country, flag_image_url: payload.flag_image_url, description: payload.description },
    { name: payload.name, slug: payload.slug, flag_image_url: payload.flag_image_url, description: payload.description },
    { name: payload.name, slug: payload.slug, description: payload.description },
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
    description: input.description?.trim() || null,
  });
}

export async function updateDestination(id: number, input: Partial<CmsDestination>): Promise<CmsDestination> {
  if (!Number.isFinite(id) || id <= 0) {
    throw new Error('Invalid destination id.');
  }

  const basePatch: Record<string, unknown> = {};
  if (input.name !== undefined) basePatch.name = String(input.name).trim();
  if (input.slug !== undefined) {
    basePatch.slug = String(input.slug).trim() || slugify(String(input.name || ''));
  }
  if (input.country !== undefined) basePatch.country_region = input.country?.trim() || null;
  if (input.flag_image_url !== undefined) basePatch.flag_image_url = input.flag_image_url?.trim() || null;
  if (input.description !== undefined) basePatch.description = input.description?.trim() || null;
  if (input.is_active !== undefined) basePatch.is_active = Boolean(input.is_active);

  const patchVariants: Record<string, unknown>[] = [
    basePatch,
    Object.fromEntries(
      Object.entries(basePatch).filter(([key]) => key !== 'country_region' && key !== 'is_active')
    ),
    Object.fromEntries(
      Object.entries(basePatch).filter(([key]) => key !== 'description' && key !== 'is_active')
    ),
    Object.fromEntries(
      Object.entries(basePatch).filter(
        ([key]) => !['country_region', 'description', 'flag_image_url', 'is_active'].includes(key)
      )
    ),
  ];

  const selectTries = [
    'id,name,slug,country_region,flag_image_url,description,is_active,created_at',
    'id,name,slug,country_region,flag_image_url,description,created_at',
    'id,name,slug,flag_image_url,description,created_at',
    'id,name,slug,flag_image_url,created_at',
    'id,name,slug,created_at',
    'id,name,slug',
  ];

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

export async function deleteDestination(id: number): Promise<void> {
  const { count } = await supabase.from('tours').select('id', { count: 'exact', head: true }).eq('destination_id', id);
  if (count && count > 0) {
    throw new Error('Cannot delete: tours are linked to this destination. Remove or reassign tours first.');
  }
  const { error } = await supabase.from('destinations').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export type CmsTourItineraryDay = {
  day: string;
  title: string;
  details: string;
};

export type CmsTour = {
  id: number;
  title: string;
  slug: string | null;
  destination_id: number | null;
  duration_days: number | null;
  flow_type: 'enquiry' | 'booking' | 'both' | null;
  tour_region: string | null;
  starting_city: string | null;
  price_from: number | null;
  twin_sharing_price: number | null;
  triple_sharing_price: number | null;
  single_sharing_price: number | null;
  child_with_bed_price: number | null;
  child_without_bed_price: number | null;
  infant_price: number | null;
  sales_price: number | null;
  discounted_price: number | null;
  currency: string | null;
  max_travellers: number | null;
  min_age: number | null;
  is_active: boolean | null;
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
  child_with_bed_price?: number | null;
  child_without_bed_price?: number | null;
  infant_price?: number | null;
  sales_price?: number | null;
  discounted_price?: number | null;
  max_travellers?: number | null;
  min_age?: number | null;
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
      const row = entry as { day?: string; title?: string; details?: string };
      return {
        day: String(row?.day || '').trim(),
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
  return {
    id: Number(row.id),
    title: String(row.title || '').trim(),
    slug,
    destination_id: row.destination_id ?? null,
    duration_days: row.duration_days ?? null,
    flow_type: row.flow_type ?? null,
    tour_region: row.tour_region ?? null,
    starting_city: row.starting_city ?? null,
    price_from: price != null ? Number(price) : null,
    twin_sharing_price: twin != null ? Number(twin) : null,
    triple_sharing_price: row.triple_sharing_price ?? null,
    single_sharing_price: row.single_sharing_price ?? null,
    child_with_bed_price: row.child_with_bed_price ?? null,
    child_without_bed_price: row.child_without_bed_price ?? null,
    infant_price: row.infant_price ?? null,
    sales_price: row.sales_price ?? null,
    discounted_price: row.discounted_price ?? null,
    currency: 'INR',
    max_travellers: row.max_travellers ?? null,
    min_age: row.min_age ?? null,
    is_active: true,
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

function tourInputToDb(input: Partial<CmsTour>): Record<string, unknown> {
  const slug = input.slug?.trim() || null;
  const priceFrom = input.price_from ?? input.twin_sharing_price ?? null;
  return {
    title: input.title != null ? String(input.title).trim() : undefined,
    slug,
    destination_id: input.destination_id,
    duration_days: input.duration_days,
    flow_type: input.flow_type,
    tour_region: input.tour_region?.trim() || null,
    starting_city: input.starting_city?.trim() || null,
    twin_sharing_price: priceFrom,
    triple_sharing_price: input.triple_sharing_price,
    single_sharing_price: input.single_sharing_price,
    child_with_bed_price: input.child_with_bed_price,
    child_without_bed_price: input.child_without_bed_price,
    infant_price: input.infant_price,
    sales_price: input.sales_price,
    discounted_price: input.discounted_price,
    max_travellers: input.max_travellers,
    min_age: input.min_age,
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
  'id,title,slug,flow_type,destination_id,destination,tour_region,starting_city,duration_days,twin_sharing_price,triple_sharing_price,single_sharing_price,child_with_bed_price,child_without_bed_price,infant_price,sales_price,discounted_price,max_travellers,min_age,hero_image_url,gallery_image_urls,overview,tour_includes,tour_exclusions,itinerary_days,created_at',
  'id,title,slug,flow_type,destination_id,destination,tour_region,starting_city,duration_days,twin_sharing_price,triple_sharing_price,single_sharing_price,child_with_bed_price,child_without_bed_price,infant_price,sales_price,discounted_price,hero_image_url,gallery_image_urls,overview,tour_includes,tour_exclusions,itinerary_days,created_at',
  'id,title,slug,flow_type,destination_id,destination,tour_region,starting_city,duration_days,twin_sharing_price,triple_sharing_price,single_sharing_price,child_with_bed_price,child_without_bed_price,sales_price,discounted_price,hero_image_url,gallery_image_urls,overview,tour_includes,tour_exclusions,itinerary_days,created_at',
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

/** Fast path after writes — avoids nested embed retries that slow CMS saves. */
async function selectTourByIdQuick(id: number): Promise<TourRaw | null> {
  let lastErr = '';
  for (const base of TOUR_LIST_BASE) {
    const { data, error } = await supabase.from('tours').select(base).eq('id', id).maybeSingle();
    if (!error && data) return data as unknown as TourRaw;
    lastErr = String(error?.message || '');
    if (!/column .* does not exist/i.test(lastErr)) break;
  }
  if (lastErr.includes('0 rows') || lastErr.includes('JSON object requested')) return null;
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
      if (!/column .* does not exist|relationship|schema cache/i.test(lastErr)) break;
    }
  }
  const quick = await selectTourByIdQuick(id);
  if (quick) return quick;
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
    if (!/column .* does not exist/i.test(lastErr)) break;
  }
  throw new Error(`Failed to create tour: ${lastErr}`);
}

export async function createTour(input: Partial<CmsTour>): Promise<CmsTour> {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('Tour title is required.');
  const slug =
    (input.slug || title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')).trim() || null;
  const db = tourInputToDb({ ...input, title, slug });
  return insertTourWithFallback(db);
}

export async function updateTour(id: number, input: Partial<CmsTour>): Promise<CmsTour> {
  const db = tourInputToDb(input);
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
      return mapTourRow(row);
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
