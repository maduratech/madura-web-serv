import type { MarketCountryCode } from './market-country';
import { normalizeMarketCountry } from './market-country';

/** Chennai HQ (MAA) — branch 1 in CRM. */
export const HQ_BRANCH_ID = 1;

/** Sydney / regional (SYD) — branch 2 in CRM. */
export const REGIONAL_BRANCH_ID = 2;

const MARKET_BRANCH: Record<MarketCountryCode, number> = {
  in: HQ_BRANCH_ID,
  gb: HQ_BRANCH_ID,
  au: Number(process.env.MARKET_BRANCH_AU || process.env.WEB_MARKET_BRANCH_AU || REGIONAL_BRANCH_ID) || REGIONAL_BRANCH_ID,
};

export function branchIdForMarket(market: string | null | undefined): number {
  const slug = normalizeMarketCountry(market);
  return MARKET_BRANCH[slug];
}

export function inferMarketFromPageUrl(pageUrl: string | null | undefined): MarketCountryCode | null {
  const url = String(pageUrl || '').toLowerCase();
  if (!url) return null;
  if (url.includes('/in/')) return 'in';
  if (url.includes('/au/')) return 'au';
  if (url.includes('/gb/')) return 'gb';
  return null;
}

export function resolveMarketForLead(input: {
  market?: string | null;
  page_url?: string | null;
  departure_city?: string | null;
  display_currency?: string | null;
}): MarketCountryCode {
  if (input.market) return normalizeMarketCountry(input.market);
  const fromUrl = inferMarketFromPageUrl(input.page_url);
  if (fromUrl) return fromUrl;

  const cur = String(input.display_currency || '').toUpperCase();
  if (cur === 'INR') return 'in';
  if (cur === 'AUD') return 'au';
  if (cur === 'USD') return 'gb';

  const dep = String(input.departure_city || '').toLowerCase();
  if (dep.includes('australia')) return 'au';
  if (dep.includes('india')) return 'in';

  return 'gb';
}

export function resolveBranchIdForLead(input: {
  market?: string | null;
  page_url?: string | null;
  departure_city?: string | null;
  display_currency?: string | null;
  branch_id?: number | null;
}): number {
  if (input.branch_id != null && Number.isFinite(Number(input.branch_id)) && Number(input.branch_id) > 0) {
    return Number(input.branch_id);
  }
  return branchIdForMarket(resolveMarketForLead(input));
}
