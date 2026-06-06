export type DestinationNavBadgeId =
  | 'trending'
  | 'popular'
  | 'hot'
  | 'best-seller'
  | 'new'
  | 'coming-soon';

const NAV_BADGE_IDS: DestinationNavBadgeId[] = [
  'trending',
  'popular',
  'hot',
  'best-seller',
  'new',
  'coming-soon',
];

export function normalizeDestinationNavBadge(value: unknown): DestinationNavBadgeId | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'best seller') return 'best-seller';
  if (raw === 'coming soon') return 'coming-soon';
  return NAV_BADGE_IDS.includes(raw as DestinationNavBadgeId) ? (raw as DestinationNavBadgeId) : null;
}
