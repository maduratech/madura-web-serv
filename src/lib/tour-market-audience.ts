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

export function suggestedAudFromInr(inr: number): number {
  if (!Number.isFinite(inr) || inr <= 0) return 0;
  return Math.round(inr * 1.5);
}

export function suggestedInrFromAud(aud: number): number {
  if (!Number.isFinite(aud) || aud <= 0) return 0;
  return Math.round(aud / 1.5);
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
