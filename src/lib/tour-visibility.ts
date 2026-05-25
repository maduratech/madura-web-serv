export type TourVisibilityStatus = 'active' | 'inactive' | 'unlisted';

export const TOUR_VISIBILITY_OPTIONS: { value: TourVisibilityStatus; label: string; hint: string }[] = [
  {
    value: 'active',
    label: 'Active',
    hint: 'Listed on the website and discoverable in search.',
  },
  {
    value: 'unlisted',
    label: 'Unlisted',
    hint: 'Hidden from listings; direct link shows itinerary only until the visitor signs in.',
  },
  {
    value: 'inactive',
    label: 'Inactive',
    hint: 'Hidden everywhere; direct links return not found.',
  },
];

export function parseTourVisibility(row: {
  visibility_status?: string | null;
  is_active?: boolean | null;
}): TourVisibilityStatus {
  const raw = String(row.visibility_status || '')
    .trim()
    .toLowerCase();
  if (raw === 'active' || raw === 'inactive' || raw === 'unlisted') return raw;
  if (row.is_active === false) return 'inactive';
  return 'active';
}

export function isTourListedPublicly(status: TourVisibilityStatus): boolean {
  return status === 'active';
}

export function isTourReachableByLink(status: TourVisibilityStatus): boolean {
  return status === 'active' || status === 'unlisted';
}
