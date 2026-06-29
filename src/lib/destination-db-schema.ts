/**
 * Website Supabase `destinations` columns (project icyvd…).
 * Keep selects aligned with this list to avoid PostgREST "column does not exist" error storms.
 */
export const DESTINATION_SELECT_TRIES = [
  'id,name,slug,destination_type,parent_id,continent,flag_iso,flag_image_url,description,is_active,created_at',
  'id,name,slug,destination_type,parent_id,flag_iso,flag_image_url,description,is_active,created_at',
  'id,name,slug,destination_type,parent_id,flag_image_url,description,is_active,created_at',
  'id,name,slug,flag_iso,flag_image_url,description,is_active,created_at',
  'id,name,slug,flag_image_url,description,is_active,created_at',
  'id,name,slug,flag_image_url,description,created_at',
  'id,name,slug,flag_image_url,created_at',
  'id,name,slug,created_at',
  'id,name,slug',
  'id,name',
] as const;

export const DESTINATION_DETAIL_SELECT_TRIES = [
  'id,name,slug,description,image_url,flag_image_url,flag_iso,is_active',
  'id,name,slug,description,image_url,flag_image_url,is_active',
  'id,name,slug,description,image_url,flag_image_url,flag_iso',
  'id,name,slug,description,image_url,flag_image_url',
  'id,name,slug,description,image_url',
  'id,name,slug,description',
  'id,name,slug,image_url',
  'id,name,slug',
] as const;

export const DESTINATION_SHOWCASE_SELECT_TRIES = [
  'id,name,slug,destination_type,parent_id,continent,image_url,description',
  'id,name,slug,destination_type,parent_id,continent,image_url',
  'id,name,slug,destination_type,parent_id,continent,description',
  'id,name,slug,destination_type,parent_id,continent',
  'id,name,slug,image_url,description',
  'id,name,slug,image_url',
  'id,name,slug,description',
  'id,name,slug',
] as const;

export const DESTINATION_LIST_SELECT_TRIES = [
  'id,name,slug,destination_type,parent_id,continent,flag_iso,flag_image_url,description',
  'id,name,slug,destination_type,parent_id,flag_iso,flag_image_url,description',
  'id,name,slug,flag_iso,flag_image_url,description',
  'id,name,slug,flag_iso,flag_image_url',
  'id,name,flag_iso',
  'id,name,flag_image_url',
  'id,name',
] as const;
