/** Canonical destination URL slug (no leading slash). */
export function normalizeDestinationSlug(slug: string): string {
  return slug
    .toLowerCase()
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

export function destinationSlugVariants(slug: string): string[] {
  const normalized = normalizeDestinationSlug(slug);
  if (!normalized) return [];
  return Array.from(new Set([normalized, `/${normalized}`]));
}
