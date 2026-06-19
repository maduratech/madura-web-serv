export type TourCollectionTierId =
  | 'comfort_collection'
  | 'signature_tours'
  | 'royal_retreat';

export type TourCollectionTierPreset = {
  id: TourCollectionTierId;
  title: string;
  subtitle: string;
  sort_order: number;
};

export const BHUTAN_COLLECTION_TIER_PRESETS: TourCollectionTierPreset[] = [
  {
    id: 'comfort_collection',
    title: 'Comfort Collection',
    subtitle: '3★ hotels, AC vehicles, smooth tours',
    sort_order: 1,
  },
  {
    id: 'signature_tours',
    title: 'Signature Tours',
    subtitle: '4★ hotels, premium vehicles, relaxed tours',
    sort_order: 2,
  },
  {
    id: 'royal_retreat',
    title: 'Royal Retreat',
    subtitle: '5★ resorts, luxury vehicles, curated experiences',
    sort_order: 3,
  },
];

export type GroupPaxCollectionTier = {
  id: string;
  title: string;
  subtitle?: string;
  sort_order?: number;
};

export function normalizeCollectionTiers(
  tiers: GroupPaxCollectionTier[] | null | undefined
): GroupPaxCollectionTier[] {
  if (!Array.isArray(tiers) || !tiers.length) return [];
  return [...tiers]
    .map((t, i) => ({
      id: String(t.id || '').trim(),
      title: String(t.title || '').trim(),
      subtitle: String(t.subtitle || '').trim() || undefined,
      sort_order: Number.isFinite(Number(t.sort_order)) ? Number(t.sort_order) : i + 1,
    }))
    .filter((t) => t.id && t.title)
    .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
}

export function collectionTierLabel(
  tiers: GroupPaxCollectionTier[],
  tierId: string | null | undefined
): string | null {
  const id = String(tierId || '').trim();
  if (!id) return null;
  return tiers.find((t) => t.id === id)?.title ?? null;
}
