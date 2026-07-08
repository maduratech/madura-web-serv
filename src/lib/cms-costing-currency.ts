import { foreignAmountToInr, STATIC_RATES_TO_INR } from './fx-rates-to-inr';
import { marketDisplayCurrency, type MarketCountryCode } from './market-country';

/** Currencies staff can pick when entering package costs in CMS. */
export const CMS_COSTING_CURRENCY_CODES = [
  'INR',
  'USD',
  'AUD',
  'EUR',
  'GBP',
  'THB',
  'SGD',
  'AED',
  'CAD',
  'NZD',
  'JPY',
  'CHF',
  'CNY',
] as const;

export type CmsCostingCurrency = (typeof CMS_COSTING_CURRENCY_CODES)[number];

export function normalizeCmsCostingCurrency(value: unknown): CmsCostingCurrency {
  const code = String(value || 'INR').toUpperCase().trim();
  if ((CMS_COSTING_CURRENCY_CODES as readonly string[]).includes(code)) {
    return code as CmsCostingCurrency;
  }
  return 'INR';
}

export function readCmsCostingCurrency(
  meta: { cms_costing_currency?: string | null; crm_source_currency?: string | null },
  rowCurrency?: string | null
): string {
  const fromMeta = String(meta.cms_costing_currency || '').toUpperCase().trim();
  if (fromMeta) return fromMeta;
  const fromRow = String(rowCurrency || '').toUpperCase().trim();
  if (fromRow) return fromRow;
  return 'INR';
}

/** Convert a CMS-entered amount from one currency to another (daily FX via INR hub). */
export function convertCostingAmountToCurrency(
  amount: number | null | undefined,
  costingCurrency: string,
  targetCurrency: string,
  ratesToInr: Record<string, number> = STATIC_RATES_TO_INR
): number | null {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const from = String(costingCurrency || 'INR').toUpperCase().trim() || 'INR';
  const to = String(targetCurrency || 'INR').toUpperCase().trim() || 'INR';
  if (from === to) return Math.round(n);
  const inr = foreignAmountToInr(n, from, ratesToInr);
  if (!inr) return null;
  if (to === 'INR') return inr;
  const toRate = Number(ratesToInr[to]);
  if (!Number.isFinite(toRate) || toRate <= 0) return null;
  return Math.round(inr / toRate);
}

/** Convert a CMS-entered amount to the visitor's storefront currency (daily FX via INR hub). */
export function convertCostingAmountToDisplay(
  amount: number | null | undefined,
  costingCurrency: string,
  marketCountry: MarketCountryCode,
  ratesToInr: Record<string, number> = STATIC_RATES_TO_INR
): number | null {
  return convertCostingAmountToCurrency(
    amount,
    costingCurrency,
    marketDisplayCurrency(marketCountry),
    ratesToInr
  );
}
