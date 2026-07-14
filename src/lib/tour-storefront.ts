import type { TourMarketAudience } from './tour-market-audience';

export type TourStorefrontId = 'india' | 'australia' | 'global';

const ORDER: TourStorefrontId[] = ['india', 'australia', 'global'];

export function normalizeTourStorefronts(
  value: unknown,
  legacyAudience?: TourMarketAudience | null
): TourStorefrontId[] {
  const fromArray = Array.isArray(value)
    ? value
        .map((v) => String(v || '').trim().toLowerCase())
        .filter((v): v is TourStorefrontId => v === 'india' || v === 'australia' || v === 'global')
    : [];
  if (fromArray.length) {
    return ORDER.filter((id) => fromArray.includes(id));
  }

  if (legacyAudience === 'both') return ['india', 'global'];
  if (legacyAudience === 'global') return ['global'];
  if (legacyAudience === 'india') return ['india'];
  return ['india'];
}

export function marketCountryToStorefront(marketCountry: string): TourStorefrontId {
  const code = String(marketCountry || '').toLowerCase().trim();
  if (code === 'in') return 'india';
  if (code === 'au') return 'australia';
  return 'global';
}

export function tourVisibleOnStorefront(
  storefronts: TourStorefrontId[] | undefined | null,
  marketCountry: string
): boolean {
  const selected = storefronts?.length ? storefronts : ['india'];
  return selected.includes(marketCountryToStorefront(marketCountry));
}

/** Legacy blogs with no storefronts column are treated as visible on every market. */
export function normalizeBlogStorefronts(value: unknown): TourStorefrontId[] {
  const fromArray = Array.isArray(value)
    ? value
        .map((v) => String(v || '').trim().toLowerCase())
        .filter((v): v is TourStorefrontId => v === 'india' || v === 'australia' || v === 'global')
    : [];
  if (fromArray.length) return ORDER.filter((id) => fromArray.includes(id));
  return [...ORDER];
}

export function blogVisibleOnStorefront(
  storefronts: TourStorefrontId[] | undefined | null,
  marketCountry: string
): boolean {
  return normalizeBlogStorefronts(storefronts).includes(marketCountryToStorefront(marketCountry));
}

export function tourVisibleForMarketFromAudience(
  audience: TourMarketAudience | undefined | null,
  marketCountry: string
): boolean {
  return tourVisibleOnStorefront(normalizeTourStorefronts(null, audience), marketCountry);
}

export function legacyAudienceFromStorefronts(storefronts: TourStorefrontId[]): TourMarketAudience {
  const hasIndia = storefronts.includes('india');
  const hasGlobal = storefronts.includes('global') || storefronts.includes('australia');
  if (hasIndia && hasGlobal) return 'both';
  if (hasGlobal && !hasIndia) return 'global';
  return 'india';
}
