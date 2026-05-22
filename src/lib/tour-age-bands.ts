export const AGE_INFANT_MAX = 2;
export const AGE_CHILD_MAX = 6;
export const AGE_YOUTH_MAX = 12;

export type TravellerAgeBand = 'infant' | 'child' | 'youth' | 'adult';

export function resolveTravellerAgeBand(ageYears: number): TravellerAgeBand {
  const a = Number(ageYears);
  if (!Number.isFinite(a) || a < 0) return 'adult';
  if (a < AGE_INFANT_MAX) return 'infant';
  if (a < AGE_CHILD_MAX) return 'child';
  if (a < AGE_YOUTH_MAX) return 'youth';
  return 'adult';
}

export function defaultChildAgeYears(): number {
  return 5;
}
