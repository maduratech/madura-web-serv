import { normalizeDestinationSlug } from './destination-slug';
import { parseTourCmsMeta } from './tour-meta';

export type DestinationHierarchyRow = {
  id: number;
  slug?: string | null;
  parent_id?: number | null;
};

export function readTourDestinationIds(tour: {
  destination_id?: number | null;
  overview?: string | null;
}): number[] {
  const meta = parseTourCmsMeta(tour.overview);
  const fromMeta = (Array.isArray(meta.destination_ids) ? meta.destination_ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (fromMeta.length) return [...new Set(fromMeta)];

  const primary = Number(tour.destination_id);
  if (Number.isFinite(primary) && primary > 0) return [primary];
  return [];
}

export function expandDestinationSlugs(
  ids: number[],
  destById: Map<number, DestinationHierarchyRow>
): string[] {
  const slugs = new Set<string>();
  for (const id of ids) {
    let current = destById.get(id);
    const seen = new Set<number>();
    while (current && !seen.has(Number(current.id))) {
      seen.add(Number(current.id));
      const slug = normalizeDestinationSlug(String(current.slug || ''));
      if (slug) slugs.add(slug);
      const parentId = current.parent_id;
      if (parentId == null) break;
      current = destById.get(Number(parentId));
    }
  }
  return [...slugs];
}

export function tourMatchesDestinationSlug(
  destinationSlugs: string[],
  pageSlug: string,
  primarySlug?: string | null
): boolean {
  const key = normalizeDestinationSlug(pageSlug);
  if (!key) return false;
  if (destinationSlugs.some((slug) => normalizeDestinationSlug(slug) === key)) return true;
  const primary = normalizeDestinationSlug(String(primarySlug || ''));
  return Boolean(primary && primary === key);
}

/** Mirrors madura-web `tourListingMatchesDestinationSlug` for package-page tour sets. */
export function tourListingMatchesDestinationSlug(
  tour: {
    destination: string;
    destination_slug: string;
    destination_slugs: string[];
  },
  pageSlug: string
): boolean {
  const key = normalizeDestinationSlug(pageSlug);
  if (!key) return false;

  const slugs = tour.destination_slugs || [];
  if (slugs.some((slug) => normalizeDestinationSlug(slug) === key)) return true;

  if (normalizeDestinationSlug(tour.destination_slug) === key) return true;
  if (normalizeDestinationSlug(tour.destination) === key) return true;

  return false;
}

export function filterToursForDestinationPage<
  T extends {
    id: number;
    destination: string;
    destination_slug: string;
    destination_slugs: string[];
  },
>(tours: T[], pageSlug: string): T[] {
  const seen = new Set<number>();
  const items: T[] = [];
  for (const tour of tours) {
    if (!tourListingMatchesDestinationSlug(tour, pageSlug)) continue;
    if (seen.has(tour.id)) continue;
    seen.add(tour.id);
    items.push(tour);
  }
  return items;
}
