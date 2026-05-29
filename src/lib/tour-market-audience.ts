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

/**
 * Round global shelf USD up to a clean price (e.g. 736.02 → 750).
 * Used for auto-suggest until staff override in CMS.
 */
export function roundUsdShelfPrice(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  if (usd < 50) return Math.ceil(usd);
  if (usd < 1000) return Math.ceil(usd / 50) * 50;
  return Math.ceil(usd / 100) * 100;
}

/** Convert INR → USD at FX, then ×1.5 (50% on top of converted USD), then shelf round-up. */
export function globalUsdDisplayFromInr(inr: number, inrPerUsdRate?: number | null): number {
  if (!Number.isFinite(inr) || inr <= 0) return 0;
  const rate = inrPerUsd(inrPerUsdRate);
  const usdBase = inr / rate;
  const withMarkup = usdBase * 1.5;
  return roundUsdShelfPrice(withMarkup);
}

export function suggestedUsdFromInr(inr: number, inrPerUsdRate?: number | null): number {
  return globalUsdDisplayFromInr(inr, inrPerUsdRate);
}

export function resolveGlobalUsdPrice(
  inr: number | null | undefined,
  storedUsd: number | null | undefined,
  inrPerUsdRate?: number | null
): number | null {
  if (storedUsd != null && storedUsd > 0) return Number(storedUsd);
  if (inr != null && inr > 0) return globalUsdDisplayFromInr(inr, inrPerUsdRate);
  return null;
}

export function inrFromGlobalUsdDisplay(usd: number, inrPerUsdRate?: number | null): number {
  if (!Number.isFinite(usd) || usd <= 0) return 0;
  const rate = inrPerUsd(inrPerUsdRate);
  return Math.round((usd * rate) / 1.5);
}

export function normalizeTourMarketAudience(value: unknown): TourMarketAudience {
  if (value === 'global' || value === 'both' || value === 'india') return value;
  return 'india';
}

export function tourVisibleForMarket(
  audience: TourMarketAudience | undefined | null,
  marketCountry: string
): boolean {
  const a = normalizeTourMarketAudience(audience);
  const isIndiaMarket = marketCountry.toLowerCase() === 'in';
  if (a === 'both') return true;
  if (a === 'india') return isIndiaMarket;
  return !isIndiaMarket;
}

export function readGlobalPricingFromMeta(meta: {
  pricing_usd?: TourMarketPricing;
  pricing_aud?: TourMarketPricing;
}): TourMarketPricing | undefined {
  return meta.pricing_usd ?? meta.pricing_aud;
}
