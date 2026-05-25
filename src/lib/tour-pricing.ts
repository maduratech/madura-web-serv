import { defaultChildAgeYears, resolveTravellerAgeBand, type TravellerAgeBand } from './tour-age-bands';
import { childPricesFromDb } from './tour-price-db';
import { sharingCapacity, type RoomSharingType } from './room-sharing';

export type TourPriceSheet = {
  twin_sharing_price?: number | null;
  triple_sharing_price?: number | null;
  single_sharing_price?: number | null;
  infant_price?: number | null;
  /** Child (2–6 yrs). */
  child_price?: number | null;
  /** Youth (6–12 yrs). */
  youth_price?: number | null;
  price?: number | null;
};

export function normalizePriceSheet(sheet: TourPriceSheet): {
  twin_sharing_price: number;
  triple_sharing_price: number;
  single_sharing_price: number;
  infant_price: number;
  child_price: number;
  youth_price: number;
} {
  const legacyTwin = Number(sheet.price) || 0;
  const twin = Number(sheet.twin_sharing_price) || legacyTwin || 0;
  const triple = Number(sheet.triple_sharing_price) || 0;
  const single = Number(sheet.single_sharing_price) || 0;
  const bands = childPricesFromDb(sheet);
  const youth = Number(bands.youth_price) || 0;
  const child = Number(bands.child_price) || 0;
  const infant = Number(bands.infant_price) || 0;
  return {
    twin_sharing_price: twin,
    triple_sharing_price: triple,
    single_sharing_price: single,
    infant_price: infant,
    child_price: child,
    youth_price: youth,
  };
}

export function applyDiscountPercent(amount: number, discountPercent: number | null | undefined): number {
  const base = Number(amount) || 0;
  const pct = Number(discountPercent);
  if (!Number.isFinite(pct) || pct <= 0) return Math.round(base);
  return Math.round(base * (1 - pct / 100));
}

/** Lowest twin / triple / single per-person rate after discount (hero & departure cards). */
export function lowestAdultSharingDisplay(
  sheet: TourPriceSheet,
  discountPercent: number | null | undefined
): number {
  const s = normalizePriceSheet(sheet);
  const candidates = [s.twin_sharing_price, s.triple_sharing_price, s.single_sharing_price].filter((n) => n > 0);
  if (!candidates.length) return 0;
  return Math.min(...candidates.map((n) => applyDiscountPercent(n, discountPercent)));
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
    s.child_price,
    s.youth_price,
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
      return s.infant_price || s.child_price || 0;
    case 'child':
      return s.child_price || s.infant_price || 0;
    case 'youth':
      return s.youth_price || s.child_price || 0;
    default:
      return 0;
  }
}

export function travellerPerPersonRate(ageYears: number, sheet: TourPriceSheet): number {
  return rateForAgeBand(resolveTravellerAgeBand(ageYears), normalizePriceSheet(sheet));
}

export type RoomPricingInput = {
  adults: number;
  children: number;
  child_ages?: number[];
  sharing_type?: RoomSharingType;
  billing_units?: number;
  stranger_slots?: number;
};

export function rateForSharingType(type: RoomSharingType, sheet: TourPriceSheet): number {
  const s = normalizePriceSheet(sheet);
  switch (type) {
    case 'single':
      return s.single_sharing_price || s.twin_sharing_price || 0;
    case 'twin':
      return s.twin_sharing_price || 0;
    case 'triple':
      return s.triple_sharing_price || s.twin_sharing_price || 0;
    default:
      return s.twin_sharing_price || 0;
  }
}

function inferSharingTypeForAdults(adults: number, sheet: TourPriceSheet): RoomSharingType {
  const n = Math.max(1, Math.floor(adults) || 1);
  const s = normalizePriceSheet(sheet);
  if (n === 1) return s.single_sharing_price > 0 ? 'single' : 'twin';
  if (n === 2) return 'twin';
  if (n >= 3) return s.triple_sharing_price > 0 ? 'triple' : 'twin';
  return 'twin';
}

export function computeBookingTotalInr(input: {
  sheet: TourPriceSheet;
  discountPercent?: number | null;
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
    const sharing =
      room.sharing_type ?? inferSharingTypeForAdults(room.adults, input.sheet);
    const capacity =
      room.billing_units != null && room.billing_units > 0
        ? room.billing_units
        : sharingCapacity(sharing);
    const adultRate = applyDiscountPercent(rateForSharingType(sharing, input.sheet), discount);
    total += adultRate * capacity;
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
