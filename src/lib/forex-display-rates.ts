const FOREX_CODES = ['USD', 'EUR', 'GBP', 'AUD', 'AED', 'SGD', 'THB', 'CAD', 'CHF', 'JPY'] as const;

export type ForexCurrencyCode = (typeof FOREX_CODES)[number];

export type ForexCurrencyRate = {
  code: ForexCurrencyCode;
  name: string;
  symbol: string;
  inr_per_unit: number;
};

export type ForexRatesPayload = {
  base: 'INR';
  asOf: number;
  source: string;
  currencies: ForexCurrencyRate[];
};

const LABELS: Record<ForexCurrencyCode, { name: string; symbol: string }> = {
  USD: { name: 'US Dollar', symbol: '$' },
  EUR: { name: 'Euro', symbol: '€' },
  GBP: { name: 'British Pound', symbol: '£' },
  AUD: { name: 'Australian Dollar', symbol: 'A$' },
  AED: { name: 'UAE Dirham', symbol: 'د.إ' },
  SGD: { name: 'Singapore Dollar', symbol: 'S$' },
  THB: { name: 'Thai Baht', symbol: '฿' },
  CAD: { name: 'Canadian Dollar', symbol: 'C$' },
  CHF: { name: 'Swiss Franc', symbol: 'CHF' },
  JPY: { name: 'Japanese Yen', symbol: '¥' },
};

const FALLBACK_INR_PER_UNIT: Record<ForexCurrencyCode, number> = {
  USD: 86.5,
  EUR: 94,
  GBP: 109,
  AUD: 56,
  AED: 23.5,
  SGD: 64,
  THB: 2.45,
  CAD: 62,
  CHF: 97,
  JPY: 0.58,
};

let cached: { payload: ForexRatesPayload; ts: number } | null = null;
const CACHE_MS = 60 * 60 * 1000;

function buildPayload(
  rates: Partial<Record<ForexCurrencyCode, number>>,
  source: string,
  asOf: number
): ForexRatesPayload {
  const currencies = FOREX_CODES.map((code) => {
    const inr = rates[code] ?? FALLBACK_INR_PER_UNIT[code];
    return {
      code,
      name: LABELS[code].name,
      symbol: LABELS[code].symbol,
      inr_per_unit: Math.round(inr * 100) / 100,
    };
  });
  return { base: 'INR', asOf, source, currencies };
}

export async function getForexDisplayRates(): Promise<ForexRatesPayload> {
  if (cached && Date.now() - cached.ts < CACHE_MS) {
    return cached.payload;
  }
  try {
    const res = await fetch('https://open.er-api.com/v6/latest/INR');
    if (!res.ok) throw new Error(`upstream_status_${res.status}`);
    const json = (await res.json()) as {
      result?: string;
      time_last_update_unix?: number;
      rates?: Record<string, number>;
    };
    if (json.result !== 'success' || !json.rates) {
      throw new Error('upstream_invalid_payload');
    }
    const mapped: Partial<Record<ForexCurrencyCode, number>> = {};
    for (const code of FOREX_CODES) {
      const foreignPerInr = Number(json.rates[code]);
      if (Number.isFinite(foreignPerInr) && foreignPerInr > 0) {
        mapped[code] = 1 / foreignPerInr;
      }
    }
    const payload = buildPayload(
      mapped,
      'open.er-api.com',
      json.time_last_update_unix ? json.time_last_update_unix * 1000 : Date.now()
    );
    cached = { payload, ts: Date.now() };
    return payload;
  } catch {
    const payload = buildPayload(FALLBACK_INR_PER_UNIT, 'fallback-static', Date.now());
    cached = { payload, ts: Date.now() };
    return payload;
  }
}
