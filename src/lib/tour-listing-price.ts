import { filterToursForDestinationPage } from './tour-destinations';

export type TourListingPriceFields = {
  starting_from_twin: number | null;
  starting_from_triple: number | null;
  starting_from_quad: number | null;
  starting_from_single: number | null;
  pricing_model?: 'group_pax_slab' | 'room_sharing' | null;
  starting_from_sharing_note?: string | null;
};

function isGroupPaxListingItem(item: TourListingPriceFields): boolean {
  if (item.pricing_model === 'group_pax_slab') return true;
  return String(item.starting_from_sharing_note || '')
    .toLowerCase()
    .includes('group');
}

/** Same card price logic as madura-web `tourPriceForListing`. */
export function tourPriceForListing(item: TourListingPriceFields): number {
  const twin = Number(item.starting_from_twin) || 0;
  if (twin > 0 && isGroupPaxListingItem(item)) return twin;

  const candidates = [
    twin,
    item.starting_from_triple,
    item.starting_from_quad,
    item.starting_from_single,
  ]
    .map((v) => Number(v) || 0)
    .filter((v) => v > 0);
  if (!candidates.length) return 0;
  return Math.min(...candidates);
}

export type DestinationPageListingItem = TourListingPriceFields & {
  id: number;
  destination: string;
  destination_slug: string;
  destination_slugs: string[];
  image_url?: string | null;
};

export function computeDestinationPageListingStats(
  items: DestinationPageListingItem[],
  pageSlug: string
): { minPrice: number | null; packageCount: number; imageUrl: string | null } {
  const matched = filterToursForDestinationPage(items, pageSlug);
  let minPrice: number | null = null;
  for (const item of matched) {
    const price = tourPriceForListing(item);
    if (price <= 0) continue;
    if (minPrice === null || price < minPrice) minPrice = price;
  }
  const imageUrl = matched.find((item) => item.image_url)?.image_url ?? null;
  return { minPrice, packageCount: matched.length, imageUrl };
}
