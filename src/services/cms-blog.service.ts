import { sanitizeCmsHtml } from '../lib/html-sanitize';
import { supabase } from '../lib/supabase';
import {
  blogPublicSegment,
  normalizeBlogContentType,
  type BlogContentType,
} from '../lib/blog-cms-meta';
import {
  blogVisibleOnStorefront,
  normalizeBlogStorefronts,
  type TourStorefrontId,
} from '../lib/tour-storefront';

export type CmsBlogPost = {
  id: number;
  title: string;
  slug: string | null;
  content_type: BlogContentType;
  author_name: string | null;
  hero_image_url: string | null;
  body_html: string | null;
  is_published: boolean;
  published_at: string | null;
  related_tour_ids: number[];
  storefronts: TourStorefrontId[];
  created_at: string | null;
  updated_at: string | null;
};

type BlogRow = {
  id: number;
  title: string;
  slug: string | null;
  content_type?: string | null;
  author_name?: string | null;
  hero_image_url?: string | null;
  body_html?: string | null;
  is_published?: boolean | null;
  published_at?: string | null;
  related_tour_ids?: number[] | null;
  storefronts?: string[] | null;
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
    content_type: normalizeBlogContentType(row.content_type),
    author_name: row.author_name ?? null,
    hero_image_url: row.hero_image_url ?? null,
    body_html: row.body_html ?? null,
    is_published: row.is_published === true,
    published_at: row.published_at ?? null,
    related_tour_ids: normalizeRelatedTourIds(row.related_tour_ids),
    storefronts: normalizeBlogStorefronts(row.storefronts),
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

const SELECT_COLS =
  'id,title,slug,content_type,author_name,hero_image_url,body_html,is_published,published_at,related_tour_ids,storefronts,created_at,updated_at';

const SELECT_COLS_NO_STOREFRONTS =
  'id,title,slug,content_type,author_name,hero_image_url,body_html,is_published,published_at,related_tour_ids,created_at,updated_at';

const SELECT_COLS_LEGACY =
  'id,title,slug,author_name,hero_image_url,body_html,is_published,published_at,related_tour_ids,created_at,updated_at';

const SELECT_COLS_LEGACY_NO_TOURS =
  'id,title,slug,author_name,hero_image_url,body_html,is_published,published_at,created_at,updated_at';

function isMissingRelatedTourIdsColumn(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return m.includes('related_tour_ids') && (m.includes('does not exist') || m.includes('could not find'));
}

function isMissingContentTypeColumn(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return m.includes('content_type') && (m.includes('does not exist') || m.includes('could not find'));
}

function isMissingStorefrontsColumn(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return m.includes('storefronts') && (m.includes('does not exist') || m.includes('could not find'));
}

async function selectBlogPosts(opts?: {
  publishedOnly?: boolean;
  contentType?: BlogContentType;
}): Promise<BlogRow[]> {
  const run = async (cols: string) => {
    let query = supabase.from('cms_blog_posts').select(cols);
    if (opts?.publishedOnly) query = query.eq('is_published', true);
    if (opts?.contentType && cols.includes('content_type')) {
      query = query.eq('content_type', opts.contentType);
    }
    return query
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false });
  };

  let result = await run(SELECT_COLS);
  if (result.error && isMissingStorefrontsColumn(result.error.message)) {
    result = await run(SELECT_COLS_NO_STOREFRONTS);
  }
  if (result.error && isMissingContentTypeColumn(result.error.message)) {
    result = await run(SELECT_COLS_LEGACY);
  }
  if (result.error && isMissingRelatedTourIdsColumn(result.error.message)) {
    result = await run(SELECT_COLS_LEGACY_NO_TOURS);
  }
  if (result.error) {
    if (isMissingBlogTable(result.error.message)) {
      throw new Error('Blog table is missing. Run sql/cms_blog_posts.sql on Supabase.');
    }
    throw new Error(result.error.message);
  }
  let rows = ((result.data || []) as unknown) as BlogRow[];
  if (opts?.contentType) {
    rows = rows.filter((row) => normalizeBlogContentType(row.content_type) === opts.contentType);
  }
  return rows;
}

async function selectBlogPostById(id: number): Promise<BlogRow | null> {
  let result = await supabase.from('cms_blog_posts').select(SELECT_COLS).eq('id', id).maybeSingle();
  if (result.error && isMissingStorefrontsColumn(result.error.message)) {
    result = await supabase
      .from('cms_blog_posts')
      .select(SELECT_COLS_NO_STOREFRONTS)
      .eq('id', id)
      .maybeSingle();
  }
  if (result.error && isMissingContentTypeColumn(result.error.message)) {
    result = await supabase.from('cms_blog_posts').select(SELECT_COLS_LEGACY).eq('id', id).maybeSingle();
  }
  if (result.error && isMissingRelatedTourIdsColumn(result.error.message)) {
    result = await supabase
      .from('cms_blog_posts')
      .select(SELECT_COLS_LEGACY_NO_TOURS)
      .eq('id', id)
      .maybeSingle();
  }
  if (result.error) {
    if (isMissingBlogTable(result.error.message)) return null;
    throw new Error(result.error.message);
  }
  return (result.data as BlogRow | null) ?? null;
}

async function selectBlogPostBySlug(
  slug: string,
  contentType?: BlogContentType,
): Promise<BlogRow | null> {
  const run = async (cols: string) => {
    let query = supabase.from('cms_blog_posts').select(cols).eq('slug', slug);
    if (contentType && cols.includes('content_type')) {
      query = query.eq('content_type', contentType);
    }
    return query.maybeSingle();
  };

  let result = await run(SELECT_COLS);
  if (result.error && isMissingStorefrontsColumn(result.error.message)) {
    result = await run(SELECT_COLS_NO_STOREFRONTS);
  }
  if (result.error && isMissingContentTypeColumn(result.error.message)) {
    result = await run(SELECT_COLS_LEGACY);
  }
  if (result.error && isMissingRelatedTourIdsColumn(result.error.message)) {
    result = await run(SELECT_COLS_LEGACY_NO_TOURS);
  }
  if (result.error) {
    if (isMissingBlogTable(result.error.message)) return null;
    throw new Error(result.error.message);
  }
  const row = (result.data as BlogRow | null) ?? null;
  if (row && contentType && normalizeBlogContentType(row.content_type) !== contentType) {
    return null;
  }
  return row;
}

export async function listBlogPosts(opts?: {
  publishedOnly?: boolean;
  contentType?: BlogContentType;
  market?: string;
}): Promise<CmsBlogPost[]> {
  const rows = await selectBlogPosts(opts);
  let posts = rows.map((row) => mapBlogRow(row));
  if (opts?.market) {
    posts = posts.filter((post) => blogVisibleOnStorefront(post.storefronts, opts.market!));
  }
  return posts;
}

export async function getBlogPost(id: number): Promise<CmsBlogPost | null> {
  const row = await selectBlogPostById(id);
  return row ? mapBlogRow(row) : null;
}

export async function getBlogPostBySlug(
  slug: string,
  contentType?: BlogContentType,
): Promise<CmsBlogPost | null> {
  const normalized = normalizeBlogSlug(slug);
  if (!normalized) return null;
  const row = await selectBlogPostBySlug(normalized, contentType);
  return row ? mapBlogRow(row) : null;
}

export async function getPublishedBlogPostBySlug(
  slug: string,
  contentType: BlogContentType = 'blog',
  market?: string,
): Promise<CmsBlogPost | null> {
  const row = await getBlogPostBySlug(slug, contentType);
  if (!row || !row.is_published) return null;
  if (market && !blogVisibleOnStorefront(row.storefronts, market)) return null;
  return row;
}

export { blogPublicSegment };

async function ensureUniqueSlug(
  base: string,
  contentType: BlogContentType,
  excludeId?: number,
): Promise<string> {
  let slug = normalizeBlogSlug(base);
  if (!slug) slug = `post-${Date.now().toString(36)}`;
  let candidate = slug;
  let n = 2;
  while (true) {
    const existing = await getBlogPostBySlug(candidate, contentType);
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
  if (input.content_type !== undefined) {
    row.content_type = normalizeBlogContentType(input.content_type);
  }
  if (input.author_name !== undefined) row.author_name = input.author_name?.trim() || null;
  if (input.hero_image_url !== undefined) row.hero_image_url = input.hero_image_url?.trim() || null;
  if (input.body_html !== undefined) row.body_html = sanitizeCmsHtml(input.body_html);
  if (input.related_tour_ids !== undefined) {
    row.related_tour_ids = normalizeRelatedTourIds(input.related_tour_ids);
  }
  if (input.storefronts !== undefined) {
    row.storefronts = normalizeBlogStorefronts(input.storefronts);
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
  const contentType = normalizeBlogContentType(input.content_type);
  const slug = await ensureUniqueSlug(input.slug || title, contentType);
  const now = new Date().toISOString();
  const isPublished = input.is_published === true;
  const storefronts = normalizeBlogStorefronts(input.storefronts);
  const payload = {
    title,
    slug,
    content_type: contentType,
    author_name: input.author_name?.trim() || null,
    hero_image_url: input.hero_image_url?.trim() || null,
    body_html: sanitizeCmsHtml(input.body_html),
    related_tour_ids: normalizeRelatedTourIds(input.related_tour_ids),
    storefronts,
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
  if (
    error &&
    (isMissingContentTypeColumn(error.message) ||
      isMissingRelatedTourIdsColumn(error.message) ||
      isMissingStorefrontsColumn(error.message))
  ) {
    const {
      content_type: _contentType,
      related_tour_ids: _tours,
      storefronts: _storefronts,
      ...legacyPayload
    } = payload;
    let cols = SELECT_COLS_LEGACY;
    if (isMissingContentTypeColumn(error.message)) cols = SELECT_COLS_LEGACY_NO_TOURS;
    else if (isMissingRelatedTourIdsColumn(error.message)) cols = SELECT_COLS_LEGACY_NO_TOURS;
    else if (isMissingStorefrontsColumn(error.message)) cols = SELECT_COLS_NO_STOREFRONTS;
    const insertPayload =
      cols === SELECT_COLS_NO_STOREFRONTS
        ? (() => {
            const { storefronts: _sf, ...rest } = payload;
            return rest;
          })()
        : legacyPayload;
    const legacy = await supabase.from('cms_blog_posts').insert(insertPayload).select(cols).single();
    if (legacy.error) throw new Error(legacy.error.message);
    return mapBlogRow({
      ...(legacy.data as unknown as BlogRow),
      content_type: contentType,
      storefronts,
    });
  }
  if (error) {
    if (isMissingBlogTable(error.message)) {
      throw new Error(
        'Blog table is missing. Run sql/cms_blog_posts.sql on Supabase. For storefronts, also run sql/cms_blog_posts_storefronts.sql.',
      );
    }
    throw new Error(error.message);
  }
  return mapBlogRow(data as BlogRow);
}

export async function updateBlogPost(id: number, input: Partial<CmsBlogPost>): Promise<CmsBlogPost> {
  const existing = await getBlogPost(id);
  if (!existing) throw new Error('Blog post not found.');

  const patch = blogInputToDb(input);
  const contentType = normalizeBlogContentType(input.content_type ?? existing.content_type);
  if (input.title !== undefined && !String(input.title).trim()) {
    throw new Error('Blog title is required.');
  }
  if (input.slug !== undefined) {
    const nextSlug = await ensureUniqueSlug(String(input.slug || existing.title), contentType, id);
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
  if (
    error &&
    (isMissingContentTypeColumn(error.message) ||
      isMissingRelatedTourIdsColumn(error.message) ||
      isMissingStorefrontsColumn(error.message))
  ) {
    const {
      content_type: _contentType,
      related_tour_ids: _tours,
      storefronts: _storefronts,
      ...legacyPatch
    } = patch;
    let cols = SELECT_COLS_LEGACY;
    let updatePatch: Record<string, unknown> = legacyPatch;
    if (isMissingStorefrontsColumn(error.message)) {
      cols = SELECT_COLS_NO_STOREFRONTS;
      const { storefronts: _sf, ...rest } = patch;
      updatePatch = rest;
    } else if (isMissingContentTypeColumn(error.message) || isMissingRelatedTourIdsColumn(error.message)) {
      cols =
        patch.related_tour_ids !== undefined && isMissingRelatedTourIdsColumn(error.message)
          ? SELECT_COLS_LEGACY_NO_TOURS
          : SELECT_COLS_LEGACY;
    }
    const legacy = await supabase.from('cms_blog_posts').update(updatePatch).eq('id', id).select(cols).single();
    if (legacy.error) throw new Error(legacy.error.message);
    return mapBlogRow({
      ...(legacy.data as unknown as BlogRow),
      content_type: normalizeBlogContentType(input.content_type ?? existing.content_type),
      storefronts: input.storefronts !== undefined ? normalizeBlogStorefronts(input.storefronts) : existing.storefronts,
    });
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
    content_type: src.content_type,
    author_name: src.author_name ?? undefined,
    hero_image_url: src.hero_image_url ?? undefined,
    body_html: src.body_html ?? undefined,
    related_tour_ids: src.related_tour_ids,
    storefronts: src.storefronts,
    is_published: false,
  });
}
