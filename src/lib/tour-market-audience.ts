import { normalizeTourStorefronts, tourVisibleOnStorefront } from './tour-storefront';

/** Fallback when live FX is unavailable (INR per 1 USD). Keep in sync with madura-web `market.ts`. */
export const DEFAULT_INR_PER_USD = 83;

export type TourMarketAudience = 'india' | 'global' | 'both';

export type TourMarketPricing = {
  price_from?: number | null;
  twin_sharing_price?: number | null;
  triple_sharing_price?: number | null;
  single_sharing_price?: number | null;
  quad_sharing_price?: number | null;
  infant_price?: number | null;
  child_price?: number | null;
  youth_price?: number | null;
  discount_percent?: number | null;
};

export function inrPerUsd(rate?: number | null): number {
  const r = rate ?? DEFAULT_INR_PER_USD;
  return Number.isFinite(r) && r > 0 ? r : DEFAULT_INR_PER_USD;
}

/** Convert INR → USD at live FX (no markup). */
export function globalUsdDisplayFromInr(inr: number, inrPerUsdRate?: number | null): number {
  if (!Number.isFinite(inr) || inr <= 0) return 0;
  const rate = inrPerUsd(inrPerUsdRate);
  return Math.round(inr / rate);
}

export function suggestedUsdFromInr(inr: number, inrPerUsdRate?: number | null): number {
  return globalUsdDisplayFromInr(inr, inrPerUsdRate);
}

/** Convert INR → AUD at live FX (INR per 1 AUD). */
export function audDisplayFromInr(inr: number, inrPerAudRate?: number | null): number {
  if (!Number.isFinite(inr) || inr <= 0) return 0;
  const rate = Number(inrPerAudRate);
  if (!Number.isFinite(rate) || rate <= 0) return 0;
  return Math.round(inr / rate);
}

/**
 * Storefront / API read path: CMS-saved USD only (overview meta).
 * Live FX conversion is CMS-only — use `globalUsdDisplayFromInr` in `/pricing/*` routes.
 */
export function resolveGlobalUsdPrice(
  _inr: number | null | undefined,
  storedUsd: number | null | undefined,
  _inrPerUsdRate?: number | null
): number | null {
  if (storedUsd != null && storedUsd > 0) return Number(storedUsd);
  return null;
}

export function inrFromGlobalUsdDisplay(usd: number, inrPerUsdRate?: number | null): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  const rate = inrPerUsd(inrPerUsdRate);
  return Math.round(usd * rate);
}

export function normalizeTourMarketAudience(value: unknown): TourMarketAudience {
  if (value === 'global' || value === 'both' || value === 'india') return value;
  return 'india';
}

export function tourVisibleForMarket(
  audience: TourMarketAudience | undefined | null,
  marketCountry: string,
  storefronts?: unknown
): boolean {
  return tourVisibleOnStorefront(
    normalizeTourStorefronts(storefronts, audience),
    marketCountry
  );
}

export function readGlobalPricingFromMeta(meta: {
  pricing_usd?: TourMarketPricing;
  pricing_aud?: TourMarketPricing;
}): TourMarketPricing | undefined {
  return meta.pricing_usd ?? meta.pricing_aud;
}
