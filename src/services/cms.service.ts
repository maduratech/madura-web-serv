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

export async function listDestinations(): Promise<CmsDestination[]> {
  const { data, error } = await supabase
    .from('destinations')
    .select('id,name,slug,country,description,is_active,flag_image_url,created_at')
    .order('name');
  if (error) throw new Error(error.message);
  return (data || []) as CmsDestination[];
}

export async function getDestination(id: number): Promise<CmsDestination | null> {
  const { data, error } = await supabase
    .from('destinations')
    .select('id,name,slug,country,description,is_active,flag_image_url,created_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as CmsDestination) || null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export async function createDestination(input: Partial<CmsDestination>): Promise<CmsDestination> {
  const name = String(input.name || '').trim();
  if (!name) throw new Error('Destination name is required.');
  const slug = (input.slug || slugify(name)).trim() || slugify(name);
  const { data, error } = await supabase
    .from('destinations')
    .insert({
      name,
      slug,
      country: input.country?.trim() || null,
      description: input.description?.trim() || null,
      is_active: input.is_active !== false,
      flag_image_url: input.flag_image_url?.trim() || null,
    })
    .select('id,name,slug,country,description,is_active,flag_image_url,created_at')
    .single();
  if (error) throw new Error(error.message);
  return data as CmsDestination;
}

export async function updateDestination(id: number, input: Partial<CmsDestination>): Promise<CmsDestination> {
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = String(input.name).trim();
  if (input.slug !== undefined) patch.slug = String(input.slug).trim() || slugify(String(input.name || ''));
  if (input.country !== undefined) patch.country = input.country?.trim() || null;
  if (input.description !== undefined) patch.description = input.description?.trim() || null;
  if (input.is_active !== undefined) patch.is_active = input.is_active;
  if (input.flag_image_url !== undefined) patch.flag_image_url = input.flag_image_url?.trim() || null;
  const { data, error } = await supabase
    .from('destinations')
    .update(patch)
    .eq('id', id)
    .select('id,name,slug,country,description,is_active,flag_image_url,created_at')
    .single();
  if (error) throw new Error(error.message);
  return data as CmsDestination;
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

export async function listTours(): Promise<CmsTour[]> {
  const { data, error } = await supabase
    .from('tours')
    .select(
      'id,title,slug,destination_id,duration_days,price_from,currency,is_active,hero_image_url,overview,trip_code,created_at,destinations(name,slug)'
    )
    .order('id', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []) as unknown as CmsTour[];
}

export async function getTour(id: number): Promise<CmsTour | null> {
  const { data, error } = await supabase
    .from('tours')
    .select(
      'id,title,slug,destination_id,duration_days,price_from,currency,is_active,hero_image_url,overview,trip_code,created_at,destinations(name,slug)'
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as unknown as CmsTour) || null;
}

export async function createTour(input: Partial<CmsTour>): Promise<CmsTour> {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('Tour title is required.');
  const slug =
    (input.slug || title.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-')).trim() || null;
  const { data, error } = await supabase
    .from('tours')
    .insert({
      title,
      slug,
      destination_id: input.destination_id ?? null,
      duration_days: input.duration_days ?? null,
      price_from: input.price_from ?? null,
      currency: input.currency?.trim() || 'INR',
      is_active: input.is_active !== false,
      hero_image_url: input.hero_image_url?.trim() || null,
      overview: input.overview?.trim() || null,
      trip_code: input.trip_code?.trim() || null,
    })
    .select(
      'id,title,slug,destination_id,duration_days,price_from,currency,is_active,hero_image_url,overview,trip_code,created_at,destinations(name,slug)'
    )
    .single();
  if (error) throw new Error(error.message);
  return data as unknown as CmsTour;
}

export async function updateTour(id: number, input: Partial<CmsTour>): Promise<CmsTour> {
  const patch: Record<string, unknown> = {};
  if (input.title !== undefined) patch.title = String(input.title).trim();
  if (input.slug !== undefined) patch.slug = input.slug?.trim() || null;
  if (input.destination_id !== undefined) patch.destination_id = input.destination_id;
  if (input.duration_days !== undefined) patch.duration_days = input.duration_days;
  if (input.price_from !== undefined) patch.price_from = input.price_from;
  if (input.currency !== undefined) patch.currency = input.currency?.trim() || 'INR';
  if (input.is_active !== undefined) patch.is_active = input.is_active;
  if (input.hero_image_url !== undefined) patch.hero_image_url = input.hero_image_url?.trim() || null;
  if (input.overview !== undefined) patch.overview = input.overview?.trim() || null;
  if (input.trip_code !== undefined) patch.trip_code = input.trip_code?.trim() || null;
  const { data, error } = await supabase
    .from('tours')
    .update(patch)
    .eq('id', id)
    .select(
      'id,title,slug,destination_id,duration_days,price_from,currency,is_active,hero_image_url,overview,trip_code,created_at,destinations(name,slug)'
    )
    .single();
  if (error) throw new Error(error.message);
  return data as unknown as CmsTour;
}

export async function deleteTour(id: number): Promise<void> {
  const { error } = await supabase.from('tours').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
