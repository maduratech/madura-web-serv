import { supabase } from '../lib/supabase';

export type CmsBlogPost = {
  id: number;
  title: string;
  slug: string | null;
  author_name: string | null;
  hero_image_url: string | null;
  body_html: string | null;
  is_published: boolean;
  published_at: string | null;
  related_tour_ids: number[];
  created_at: string | null;
  updated_at: string | null;
};

type BlogRow = {
  id: number;
  title: string;
  slug: string | null;
  author_name?: string | null;
  hero_image_url?: string | null;
  body_html?: string | null;
  is_published?: boolean | null;
  published_at?: string | null;
  related_tour_ids?: number[] | null;
  created_at?: string | null;
  updated_at?: string | null;
};

function isMissingBlogTable(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('cms_blog_posts') &&
    (m.includes('does not exist') || m.includes('could not find') || m.includes('schema cache'))
  );
}

export function normalizeBlogSlug(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeRelatedTourIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const ids: number[] = [];
  for (const item of raw) {
    const id = Number(item);
    if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function mapBlogRow(row: BlogRow): CmsBlogPost {
  return {
    id: row.id,
    title: row.title,
    slug: row.slug ?? null,
    author_name: row.author_name ?? null,
    hero_image_url: row.hero_image_url ?? null,
    body_html: row.body_html ?? null,
    is_published: row.is_published === true,
    published_at: row.published_at ?? null,
    related_tour_ids: normalizeRelatedTourIds(row.related_tour_ids),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

const SELECT_COLS =
  'id,title,slug,author_name,hero_image_url,body_html,is_published,published_at,related_tour_ids,created_at,updated_at';

const SELECT_COLS_LEGACY =
  'id,title,slug,author_name,hero_image_url,body_html,is_published,published_at,created_at,updated_at';

function isMissingRelatedTourIdsColumn(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return m.includes('related_tour_ids') && (m.includes('does not exist') || m.includes('could not find'));
}

async function selectBlogPosts(opts?: { publishedOnly?: boolean }): Promise<BlogRow[]> {
  const run = async (cols: string) => {
    let query = supabase.from('cms_blog_posts').select(cols);
    if (opts?.publishedOnly) query = query.eq('is_published', true);
    return query
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
  };

  let result = await run(SELECT_COLS);
  if (result.error && isMissingRelatedTourIdsColumn(result.error.message)) {
    result = await run(SELECT_COLS_LEGACY);
  }
  if (result.error) {
    if (isMissingBlogTable(result.error.message)) {
      throw new Error('Blog table is missing. Run sql/cms_blog_posts.sql on Supabase.');
    }
    throw new Error(result.error.message);
  }
  return ((result.data || []) as unknown) as BlogRow[];
}

async function selectBlogPostById(id: number): Promise<BlogRow | null> {
  let result = await supabase.from('cms_blog_posts').select(SELECT_COLS).eq('id', id).maybeSingle();
  if (result.error && isMissingRelatedTourIdsColumn(result.error.message)) {
    result = await supabase.from('cms_blog_posts').select(SELECT_COLS_LEGACY).eq('id', id).maybeSingle();
  }
  if (result.error) {
    if (isMissingBlogTable(result.error.message)) return null;
    throw new Error(result.error.message);
  }
  return (result.data as BlogRow | null) ?? null;
}

async function selectBlogPostBySlug(slug: string): Promise<BlogRow | null> {
  let result = await supabase.from('cms_blog_posts').select(SELECT_COLS).eq('slug', slug).maybeSingle();
  if (result.error && isMissingRelatedTourIdsColumn(result.error.message)) {
    result = await supabase
      .from('cms_blog_posts')
      .select(SELECT_COLS_LEGACY)
      .eq('slug', slug)
      .maybeSingle();
  }
  if (result.error) {
    if (isMissingBlogTable(result.error.message)) return null;
    throw new Error(result.error.message);
  }
  return (result.data as BlogRow | null) ?? null;
}

export async function listBlogPosts(opts?: { publishedOnly?: boolean }): Promise<CmsBlogPost[]> {
  const rows = await selectBlogPosts(opts);
  return rows.map((row) => mapBlogRow(row));
}

export async function getBlogPost(id: number): Promise<CmsBlogPost | null> {
  const row = await selectBlogPostById(id);
  return row ? mapBlogRow(row) : null;
}

export async function getBlogPostBySlug(slug: string): Promise<CmsBlogPost | null> {
  const normalized = normalizeBlogSlug(slug);
  if (!normalized) return null;
  const row = await selectBlogPostBySlug(normalized);
  return row ? mapBlogRow(row) : null;
}

export async function getPublishedBlogPostBySlug(slug: string): Promise<CmsBlogPost | null> {
  const row = await getBlogPostBySlug(slug);
  if (!row || !row.is_published) return null;
  return row;
}

async function ensureUniqueSlug(base: string, excludeId?: number): Promise<string> {
  let slug = normalizeBlogSlug(base);
  if (!slug) slug = `post-${Date.now().toString(36)}`;
  let candidate = slug;
  let n = 2;
  while (true) {
    const existing = await getBlogPostBySlug(candidate);
    if (!existing || (excludeId != null && existing.id === excludeId)) return candidate;
    candidate = `${slug}-${n}`;
    n += 1;
  }
}

function blogInputToDb(input: Partial<CmsBlogPost>): Record<string, unknown> {
  const now = new Date().toISOString();
  const isPublished = input.is_published === true;
  const row: Record<string, unknown> = {
    updated_at: now,
  };
  if (input.title !== undefined) row.title = String(input.title || '').trim();
  if (input.slug !== undefined) {
    row.slug = input.slug ? normalizeBlogSlug(input.slug) : null;
  }
  if (input.author_name !== undefined) row.author_name = input.author_name?.trim() || null;
  if (input.hero_image_url !== undefined) row.hero_image_url = input.hero_image_url?.trim() || null;
  if (input.body_html !== undefined) row.body_html = input.body_html || null;
  if (input.related_tour_ids !== undefined) {
    row.related_tour_ids = normalizeRelatedTourIds(input.related_tour_ids);
  }
  if (input.is_published !== undefined) {
    row.is_published = isPublished;
    if (isPublished) {
      row.published_at = input.published_at || now;
    } else {
      row.published_at = null;
    }
  }
  return row;
}

export async function createBlogPost(input: Partial<CmsBlogPost>): Promise<CmsBlogPost> {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('Blog title is required.');
  const slug = await ensureUniqueSlug(input.slug || title);
  const now = new Date().toISOString();
  const isPublished = input.is_published === true;
  const payload = {
    title,
    slug,
    author_name: input.author_name?.trim() || null,
    hero_image_url: input.hero_image_url?.trim() || null,
    body_html: input.body_html || null,
    related_tour_ids: normalizeRelatedTourIds(input.related_tour_ids),
    is_published: isPublished,
    published_at: isPublished ? now : null,
    created_at: now,
    updated_at: now,
  };
  const { data, error } = await supabase
    .from('cms_blog_posts')
    .insert(payload)
    .select(SELECT_COLS)
    .single();
  if (error && isMissingRelatedTourIdsColumn(error.message)) {
    const { related_tour_ids: _omit, ...legacyPayload } = payload;
    const legacy = await supabase
      .from('cms_blog_posts')
      .insert(legacyPayload)
      .select(SELECT_COLS_LEGACY)
      .single();
    if (legacy.error) throw new Error(legacy.error.message);
    return mapBlogRow(legacy.data as BlogRow);
  }
  if (error) {
    if (isMissingBlogTable(error.message)) {
      throw new Error('Blog table is missing. Run sql/cms_blog_posts.sql on Supabase.');
    }
    throw new Error(error.message);
  }
  return mapBlogRow(data as BlogRow);
}

export async function updateBlogPost(id: number, input: Partial<CmsBlogPost>): Promise<CmsBlogPost> {
  const existing = await getBlogPost(id);
  if (!existing) throw new Error('Blog post not found.');

  const patch = blogInputToDb(input);
  if (input.title !== undefined && !String(input.title).trim()) {
    throw new Error('Blog title is required.');
  }
  if (input.slug !== undefined) {
    const nextSlug = await ensureUniqueSlug(String(input.slug || existing.title), id);
    patch.slug = nextSlug;
  }
  if (input.is_published === true && !existing.published_at) {
    patch.published_at = new Date().toISOString();
  }
  if (input.is_published === false) {
    patch.published_at = null;
  }

  const { data, error } = await supabase
    .from('cms_blog_posts')
    .update(patch)
    .eq('id', id)
    .select(SELECT_COLS)
    .single();
  if (error && isMissingRelatedTourIdsColumn(error.message) && patch.related_tour_ids !== undefined) {
    const { related_tour_ids: _omit, ...legacyPatch } = patch;
    const legacy = await supabase
      .from('cms_blog_posts')
      .update(legacyPatch)
      .eq('id', id)
      .select(SELECT_COLS_LEGACY)
      .single();
    if (legacy.error) throw new Error(legacy.error.message);
    return mapBlogRow(legacy.data as BlogRow);
  }
  if (error) throw new Error(error.message);
  return mapBlogRow(data as BlogRow);
}

export async function deleteBlogPost(id: number): Promise<void> {
  const { error } = await supabase.from('cms_blog_posts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function duplicateBlogPost(id: number): Promise<CmsBlogPost> {
  const src = await getBlogPost(id);
  if (!src) throw new Error('Blog post not found.');
  const stamp = Date.now().toString(36);
  return createBlogPost({
    title: `${src.title} (Copy)`,
    slug: `${src.slug || 'post'}-copy-${stamp}`,
    author_name: src.author_name ?? undefined,
    hero_image_url: src.hero_image_url ?? undefined,
    body_html: src.body_html ?? undefined,
    related_tour_ids: src.related_tour_ids,
    is_published: false,
  });
}
