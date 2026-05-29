import { DEFAULT_INR_PER_USD } from './tour-market-audience';

export type FxRatesPayload = {
  base: 'INR';
  rates: { INR: number; USD: number };
  asOf: number;
  source: string;
};

let cached: { payload: FxRatesPayload; ts: number } | null = null;
const CACHE_MS = 60 * 60 * 1000;

type OpenErApiResponse = {
  result?: 'success' | 'error';
  time_last_update_unix?: number;
  rates?: Record<string, number>;
};

/** Live INR per 1 USD (e.g. 83). Cached ~1 hour. */
export async function getInrPerUsd(): Promise<number> {
  const payload = await getFxRatesPayload();
  return payload.rates.USD;
}

export async function getFxRatesPayload(): Promise<FxRatesPayload> {
  if (cached && Date.now() - cached.ts < CACHE_MS) {
    return cached.payload;
  }
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/INR');
    if (!res.ok) throw new Error(`upstream_status_${res.status}`);
    const json = (await res.json()) as OpenErApiResponse;
    if (json.result !== 'success' || !json.rates?.USD) {
      throw new Error('upstream_invalid_payload');
    }
    const inrPerUsd = 1 / Number(json.rates.USD);
    if (!Number.isFinite(inrPerUsd) || inrPerUsd <= 0) throw new Error('invalid_usd_rate');
    const payload: FxRatesPayload = {
      base: 'INR',
      rates: { INR: 1, USD: inrPerUsd },
      asOf: json.time_last_update_unix ? json.time_last_update_unix * 1000 : Date.now(),
      source: 'open.er-api.com',
    };
    cached = { payload, ts: Date.now() };
    return payload;
  } catch {
    const payload: FxRatesPayload = {
      base: 'INR',
      rates: { INR: 1, USD: DEFAULT_INR_PER_USD },
      asOf: Date.now(),
      source: 'fallback-static',
    };
    cached = { payload, ts: Date.now() };
    return payload;
  }
}
