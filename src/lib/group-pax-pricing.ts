import { defaultChildAgeYears, resolveTravellerAgeBand } from './tour-age-bands';
import type { GroupPaxCollectionTier } from './tour-collection-tiers';
import { normalizeCollectionTiers } from './tour-collection-tiers';
import { applyDiscountPercent, type TourPriceSheet } from './tour-pricing';

export type TourPricingModel = 'room_sharing' | 'group_pax_slab';

export type GroupPaxSlab = {
  min_pax: number;
  max_pax: number;
  label?: string;
  per_person_inr?: number | null;
  tier_rates_inr?: Record<string, number | null | undefined>;
};

export type GroupPaxPricingMeta = {
  pricing_model?: TourPricingModel;
  group_pax_slabs?: GroupPaxSlab[];
  group_pax_tiers?: GroupPaxCollectionTier[];
  group_pax_default_tier_id?: string;
  group_pax_min_adults?: number;
};

export function isGroupPaxSlabPricing(meta: GroupPaxPricingMeta | null | undefined): boolean {
  return (
    meta?.pricing_model === 'group_pax_slab' &&
    Array.isArray(meta.group_pax_slabs) &&
    meta.group_pax_slabs.length > 0
  );
}

export function normalizeGroupPaxSlabs(slabs: GroupPaxSlab[] | null | undefined): GroupPaxSlab[] {
  if (!Array.isArray(slabs)) return [];
  return slabs
    .map((s) => {
      const min = Math.max(0, Math.floor(Number(s.min_pax) || 0));
      const max = Math.max(min, Math.floor(Number(s.max_pax) || min));
      const per = Number(s.per_person_inr);
      const tierRates: Record<string, number> = {};
      if (s.tier_rates_inr && typeof s.tier_rates_inr === 'object') {
        for (const [k, v] of Object.entries(s.tier_rates_inr)) {
          const n = Number(v);
          if (k && Number.isFinite(n) && n > 0) tierRates[k] = n;
        }
      }
      return {
        min_pax: min,
        max_pax: max,
        label: String(s.label || '').trim() || undefined,
        per_person_inr: Number.isFinite(per) && per > 0 ? per : undefined,
        tier_rates_inr: Object.keys(tierRates).length ? tierRates : undefined,
      };
    })
    .filter((s) => s.min_pax > 0 && s.max_pax >= s.min_pax)
    .sort((a, b) => a.min_pax - b.min_pax);
}

export type ResolvedGroupPaxSlab = {
  slab: GroupPaxSlab;
  perPersonInr: number;
  label: string;
};

export function resolveGroupPaxSlab(
  adults: number,
  slabs: GroupPaxSlab[],
  tierId?: string | null
): ResolvedGroupPaxSlab | null {
  const count = Math.max(0, Math.floor(Number(adults) || 0));
  if (count <= 0 || !slabs.length) return null;
  const slab = slabs.find((s) => count >= s.min_pax && count <= s.max_pax);
  if (!slab) return null;

  const tier = String(tierId || '').trim();
  let perPerson = 0;
  if (tier && slab.tier_rates_inr?.[tier] != null) {
    perPerson = Number(slab.tier_rates_inr[tier]) || 0;
  } else if (slab.per_person_inr != null) {
    perPerson = Number(slab.per_person_inr) || 0;
  }
  if (perPerson <= 0) return null;

  const label =
    slab.label?.trim() ||
    (slab.min_pax === slab.max_pax
      ? `${slab.min_pax} Pax`
      : `${slab.min_pax} – ${slab.max_pax} Pax`);

  return { slab, perPersonInr: perPerson, label };
}

function childRateForSlabTour(
  ageYears: number,
  adultSlabRate: number,
  sheet: TourPriceSheet
): number {
  const band = resolveTravellerAgeBand(ageYears);
  if (band === 'adult') return adultSlabRate;
  const infant = Number(sheet.infant_price) || 0;
  const child = Number(sheet.child_price) || 0;
  const youth = Number(sheet.youth_price) || 0;
  if (band === 'infant') return infant || child || adultSlabRate;
  if (band === 'child') return child || infant || adultSlabRate;
  if (band === 'youth') return youth || child || adultSlabRate;
  return adultSlabRate;
}

export function computeGroupPaxBookingTotalInr(input: {
  adults: number;
  slabAdults?: number;
  children?: number;
  child_ages?: number[];
  slabs: GroupPaxSlab[];
  tierId?: string | null;
  discountPercent?: number | null;
  childSheet?: TourPriceSheet;
}): number {
  const adults = Math.max(0, Math.floor(Number(input.adults) || 0));
  const slabAdults = Math.max(
    0,
    Math.floor(Number(input.slabAdults ?? input.adults) || 0)
  );
  const resolved = resolveGroupPaxSlab(
    slabAdults > 0 ? slabAdults : adults,
    input.slabs,
    input.tierId
  );
  if (!resolved) return 0;

  const discount = input.discountPercent;
  const adultRate = applyDiscountPercent(resolved.perPersonInr, discount);
  let total = adultRate * adults;

  const children = Math.max(0, Math.floor(Number(input.children) || 0));
  const sheet = input.childSheet ?? {};
  const ages = Array.isArray(input.child_ages) ? input.child_ages : [];
  for (let i = 0; i < children; i += 1) {
    const age = ages[i] ?? defaultChildAgeYears();
    const raw = childRateForSlabTour(age, resolved.perPersonInr, sheet);
    total += applyDiscountPercent(raw, discount);
  }
  return Math.round(total);
}

export function lowestGroupPaxDisplayAcrossTiers(slabs: GroupPaxSlab[]): number {
  let lowest = Infinity;
  for (const slab of slabs) {
    const candidates: number[] = [];
    if (slab.per_person_inr != null && slab.per_person_inr > 0) {
      candidates.push(slab.per_person_inr);
    }
    if (slab.tier_rates_inr) {
      for (const v of Object.values(slab.tier_rates_inr)) {
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) candidates.push(n);
      }
    }
    if (candidates.length) lowest = Math.min(lowest, ...candidates);
  }
  return Number.isFinite(lowest) ? lowest : 0;
}

export function groupPaxMinAdults(meta: GroupPaxPricingMeta): number {
  const n = Number(meta.group_pax_min_adults);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
}

export function effectiveCollectionTiers(meta: GroupPaxPricingMeta): GroupPaxCollectionTier[] {
  return normalizeCollectionTiers(meta.group_pax_tiers);
}

export function defaultCollectionTierId(meta: GroupPaxPricingMeta): string | null {
  const tiers = effectiveCollectionTiers(meta);
  if (!tiers.length) return null;
  const preferred = String(meta.group_pax_default_tier_id || '').trim();
  if (preferred && tiers.some((t) => t.id === preferred)) return preferred;
  return tiers[0]?.id ?? null;
}

export function lowestGroupPaxDisplayInr(slabs: GroupPaxSlab[], tierId?: string | null): number {
  let lowest = Infinity;
  for (const slab of slabs) {
    const tier = String(tierId || '').trim();
    let rate = 0;
    if (tier && slab.tier_rates_inr?.[tier] != null) {
      rate = Number(slab.tier_rates_inr[tier]) || 0;
    } else if (slab.per_person_inr != null) {
      rate = Number(slab.per_person_inr) || 0;
    } else if (slab.tier_rates_inr) {
      const values = Object.values(slab.tier_rates_inr)
        .map((v) => Number(v))
        .filter((n) => Number.isFinite(n) && n > 0);
      rate = values.length ? Math.min(...values) : 0;
    }
    if (rate > 0) lowest = Math.min(lowest, rate);
  }
  return Number.isFinite(lowest) ? lowest : 0;
}

export function collectionTiersWithRatesForGroup(
  adults: number,
  slabs: GroupPaxSlab[],
  tiers: GroupPaxCollectionTier[]
): GroupPaxCollectionTier[] {
  if (!tiers.length) return [];
  const count = Math.max(0, Math.floor(Number(adults) || 0));
  const slab = count > 0 ? slabs.find((s) => count >= s.min_pax && count <= s.max_pax) : null;

  if (slab?.tier_rates_inr) {
    return tiers.filter((t) => {
      const rate = slab.tier_rates_inr?.[t.id];
      return rate != null && Number(rate) > 0;
    });
  }

  return tiers.filter((t) => lowestGroupPaxDisplayInr(slabs, t.id) > 0);
}

export function resolveCollectionTierId(
  selectedId: string | null | undefined,
  adults: number,
  slabs: GroupPaxSlab[],
  tiers: GroupPaxCollectionTier[],
  defaultTierId: string | null | undefined
): string | null {
  const available = collectionTiersWithRatesForGroup(adults, slabs, tiers);
  if (!available.length) return null;
  const selected = String(selectedId || '').trim();
  if (selected && available.some((t) => t.id === selected)) return selected;
  const preferred = String(defaultTierId || '').trim();
  if (preferred && available.some((t) => t.id === preferred)) return preferred;
  return available[0]?.id ?? null;
}

export function collectionTierLabel(
  tiers: GroupPaxCollectionTier[],
  tierId: string | null | undefined
): string | null {
  const id = String(tierId || '').trim();
  if (!id) return null;
  return tiers.find((t) => t.id === id)?.title ?? null;
}
