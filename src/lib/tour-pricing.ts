import { defaultChildAgeYears, resolveTravellerAgeBand, type TravellerAgeBand } from './tour-age-bands';

export type TourPriceSheet = {
  twin_sharing_price?: number | null;
  triple_sharing_price?: number | null;
  single_sharing_price?: number | null;
  child_with_bed_price?: number | null;
  child_without_bed_price?: number | null;
  infant_price?: number | null;
  price?: number | null;
};

export const DEFAULT_CHILD_BED_AGE_MIN = 6;

export function resolveChildBedAgeMin(value: number | null | undefined): number {
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0 && n <= 17) return Math.floor(n);
  return DEFAULT_CHILD_BED_AGE_MIN;
}

export function normalizePriceSheet(sheet: TourPriceSheet): {
  twin_sharing_price: number;
  triple_sharing_price: number;
  single_sharing_price: number;
  child_with_bed_price: number;
  child_without_bed_price: number;
  infant_price: number;
} {
  const legacyTwin = Number(sheet.price) || 0;
  const twin = Number(sheet.twin_sharing_price) || legacyTwin || 0;
  const triple = Number(sheet.triple_sharing_price) || 0;
  const single = Number(sheet.single_sharing_price) || 0;
  const youth = Number(sheet.child_with_bed_price) || 0;
  const child = Number(sheet.child_without_bed_price) || 0;
  const infant = Number(sheet.infant_price) || 0;
  return {
    twin_sharing_price: twin,
    triple_sharing_price: triple,
    single_sharing_price: single,
    child_with_bed_price: youth,
    child_without_bed_price: child,
    infant_price: infant,
  };
}

export function applyDiscountPercent(amount: number, discountPercent: number | null | undefined): number {
  const base = Number(amount) || 0;
  const pct = Number(discountPercent);
  if (!Number.isFinite(pct) || pct <= 0) return Math.round(base);
  return Math.round(base * (1 - pct / 100));
}

export function lowestPerPersonDisplay(
  sheet: TourPriceSheet,
  discountPercent: number | null | undefined
): number {
  const s = normalizePriceSheet(sheet);
  const candidates = [
    s.twin_sharing_price,
    s.triple_sharing_price,
    s.single_sharing_price,
    s.infant_price,
    s.child_without_bed_price,
    s.child_with_bed_price,
  ].filter((n) => n > 0);
  if (!candidates.length) return 0;
  return Math.min(...candidates.map((n) => applyDiscountPercent(n, discountPercent)));
}

export function adultPerPersonRate(adults: number, sheet: TourPriceSheet): number {
  const n = Math.max(0, Math.floor(Number(adults) || 0));
  const s = normalizePriceSheet(sheet);
  if (n <= 0) return 0;
  if (n === 1) return s.single_sharing_price || s.twin_sharing_price || 0;
  if (n === 2) return s.twin_sharing_price || 0;
  if (n === 3) return s.triple_sharing_price || s.twin_sharing_price || 0;
  return s.triple_sharing_price || s.twin_sharing_price || 0;
}

function rateForAgeBand(band: TravellerAgeBand, s: ReturnType<typeof normalizePriceSheet>): number {
  switch (band) {
    case 'infant':
      return s.infant_price || s.child_without_bed_price || 0;
    case 'child':
      return s.child_without_bed_price || s.infant_price || 0;
    case 'youth':
      return s.child_with_bed_price || s.child_without_bed_price || 0;
    default:
      return 0;
  }
}

export function travellerPerPersonRate(ageYears: number, sheet: TourPriceSheet): number {
  return rateForAgeBand(resolveTravellerAgeBand(ageYears), normalizePriceSheet(sheet));
}

export function childPerPersonRate(
  age: number,
  sheet: TourPriceSheet,
  _childBedAgeMin = DEFAULT_CHILD_BED_AGE_MIN
): number {
  const band = resolveTravellerAgeBand(age);
  if (band === 'adult') return adultPerPersonRate(1, sheet);
  return travellerPerPersonRate(age, sheet);
}

export type RoomPricingInput = {
  adults: number;
  children: number;
  child_ages?: number[];
};

export function computeBookingTotalInr(input: {
  sheet: TourPriceSheet;
  discountPercent?: number | null;
  childBedAgeMin?: number;
  room_details?: RoomPricingInput[];
  adults?: number;
  children?: number;
  child_ages?: number[];
}): number {
  const discount = input.discountPercent;
  const rooms = input.room_details?.length
    ? input.room_details
    : [
        {
          adults: Number(input.adults) || 0,
          children: Number(input.children) || 0,
          child_ages: input.child_ages,
        },
      ];

  let total = 0;
  for (const room of rooms) {
    const adultRate = applyDiscountPercent(adultPerPersonRate(room.adults, input.sheet), discount);
    total += adultRate * Math.max(0, room.adults);
    const ages = Array.isArray(room.child_ages) ? room.child_ages : [];
    for (let i = 0; i < room.children; i += 1) {
      const age = ages[i] ?? defaultChildAgeYears();
      const band = resolveTravellerAgeBand(age);
      const rate =
        band === 'adult'
          ? adultPerPersonRate(1, input.sheet)
          : travellerPerPersonRate(age, input.sheet);
      total += applyDiscountPercent(rate, discount);
    }
  }
  return Math.round(total);
}

export function inferDiscountPercent(
  twinPrice: number | null | undefined,
  discountedPrice: number | null | undefined,
  metaPercent: number | null | undefined
): number | null {
  if (metaPercent != null && Number.isFinite(metaPercent) && metaPercent > 0) {
    return Math.min(100, Math.max(0, metaPercent));
  }
  const twin = Number(twinPrice) || 0;
  const disc = Number(discountedPrice);
  if (twin > 0 && Number.isFinite(disc) && disc > 0 && disc < twin) {
    return Math.round((1 - disc / twin) * 1000) / 10;
  }
  return null;
}
