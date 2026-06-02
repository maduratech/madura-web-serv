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

const PACKAGES_SLUG_SUFFIX = '-tour-packages';

function toPackagesPageSlug(slug: string): string {
  const base = normalizeDestinationSlug(slug);
  if (!base) return '';
  if (base.endsWith(PACKAGES_SLUG_SUFFIX)) return base;
  return `${base}${PACKAGES_SLUG_SUFFIX}`;
}

function parsePackagesPageSlug(slug: string): string {
  const normalized = normalizeDestinationSlug(slug);
  if (!normalized) return '';
  if (normalized.endsWith(PACKAGES_SLUG_SUFFIX)) {
    const base = normalized.slice(0, -PACKAGES_SLUG_SUFFIX.length).replace(/-+$/g, '');
    return base || normalized;
  }
  return normalized;
}

export function destinationSlugVariants(slug: string): string[] {
  const normalized = normalizeDestinationSlug(slug);
  if (!normalized) return [];
  const base = parsePackagesPageSlug(normalized);
  const packages = toPackagesPageSlug(base);
  return Array.from(
    new Set([normalized, base, packages, `/${normalized}`, `/${base}`, `/${packages}`].filter(Boolean))
  );
}
