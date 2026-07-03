import { supabase } from './supabase';

/** Multiply foreign-currency amounts by this to get INR (matches CRM `fx_rates.rate_to_inr`). */
export const STATIC_RATES_TO_INR: Record<string, number> = {
  INR: 1,
  USD: 92.39,
  EUR: 106.66,
  GBP: 123.58,
  AUD: 64.73,
  CAD: 61.6,
  SGD: 72.01,
  JPY: 0.5947,
  CHF: 103.21,
  CNY: 13.35,
  NZD: 50.92,
  THB: 2.45,
};

let cachedRates: { map: Record<string, number>; at: number } | null = null;
const CACHE_MS = 60 * 60 * 1000;

export async function fetchFxRatesToInr(): Promise<Record<string, number>> {
  if (cachedRates && Date.now() - cachedRates.at < CACHE_MS) {
    return cachedRates.map;
  }

  const map: Record<string, number> = { ...STATIC_RATES_TO_INR, INR: 1 };

  try {
    const { data, error } = await supabase
      .from('fx_rates')
      .select('currency, rate_to_inr')
      .eq('is_active', true);
    if (!error && data?.length) {
      for (const row of data) {
        const c = String(row.currency || '').toUpperCase();
        const n = Number(row.rate_to_inr);
        if (c && Number.isFinite(n) && n > 0) map[c] = n;
      }
      map.INR = 1;
      cachedRates = { map, at: Date.now() };
      return map;
    }
  } catch {
    /* table missing */
  }

  try {
    const res = await fetch('https://api.frankfurter.app/latest?from=INR');
    if (res.ok) {
      const fxData = (await res.json()) as { rates?: Record<string, number> };
      if (fxData.rates) {
        for (const [curr, rateFromInr] of Object.entries(fxData.rates)) {
          const r = Number(rateFromInr);
          if (!Number.isFinite(r) || r <= 0) continue;
          map[curr] = r < 1 ? 1 / r : r;
        }
      }
      map.INR = 1;
      cachedRates = { map, at: Date.now() };
      return map;
    }
  } catch {
    /* ignore */
  }

  cachedRates = { map, at: Date.now() };
  return map;
}

/** CRM manual costing amounts are stored in `display_currency`; convert to INR for web DB columns. */
export function foreignAmountToInr(
  amount: number | null | undefined,
  displayCurrency: string,
  rates: Record<string, number>
): number | null {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const c = String(displayCurrency || 'INR').toUpperCase().trim() || 'INR';
  if (c === 'INR') return Math.round(n);
  const rate = rates[c];
  if (!rate || rate <= 0) return Math.round(n);
  return Math.round(n * rate);
}
