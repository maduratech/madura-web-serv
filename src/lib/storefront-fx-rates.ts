import { fetchFxRatesToInr, STATIC_RATES_TO_INR } from './fx-rates-to-inr';

export type StorefrontFxPayload = {
  base: 'INR';
  /** INR per 1 unit of foreign currency (booking `display_fx_rate`). */
  rates: Record<string, number>;
  asOf: number;
  source: string;
};

let cached: { payload: StorefrontFxPayload; at: number } | null = null;
/** Daily index — open.er-api.com / Frankfurter rates cached for storefront display. */
const CACHE_MS = 24 * 60 * 60 * 1000;

const STOREFRONT_CURRENCIES = ['INR', 'USD', 'AUD'] as const;

function buildPayload(toInr: Record<string, number>, source: string): StorefrontFxPayload {
  const rates: Record<string, number> = { INR: 1 };
  for (const code of STOREFRONT_CURRENCIES) {
    if (code === 'INR') continue;
    const live = Number(toInr[code]);
    rates[code] = live > 0 ? live : STATIC_RATES_TO_INR[code] ?? 1;
  }
  return { base: 'INR', rates, asOf: Date.now(), source };
}

/** Live INR-per-unit rates for tour storefront + payment gateways (Supabase → Frankfurter → static). */
export async function getStorefrontFxRates(): Promise<StorefrontFxPayload> {
  if (cached && Date.now() - cached.at < CACHE_MS) {
    return cached.payload;
  }
  const toInr = await fetchFxRatesToInr();
  const payload = buildPayload(toInr, 'fx_rates+frankfurter');
  cached = { payload, at: Date.now() };
  return payload;
}

/** INR per 1 unit of `currency` (e.g. ~65 for AUD). Used for Razorpay AU conversion and booking snapshots. */
export async function getInrPerDisplayCurrency(currency: string): Promise<number> {
  const code = String(currency || 'INR').toUpperCase().trim() || 'INR';
  if (code === 'INR') return 1;
  const { rates } = await getStorefrontFxRates();
  const live = Number(rates[code]);
  if (live > 0) return live;
  const fallback = Number(STATIC_RATES_TO_INR[code as keyof typeof STATIC_RATES_TO_INR]);
  return fallback > 0 ? fallback : 1;
}

/**
 * Live rate for payment collection; optional booking snapshot is ignored for charge amount
 * so AU/IN gateways always use current FX (snapshot remains for CRM/display notes).
 */
export async function getInrPerUnitForPayment(
  currency: string,
  _bookingSnapshot?: number | null
): Promise<number> {
  return getInrPerDisplayCurrency(currency);
}
