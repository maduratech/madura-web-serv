export type MarketCountryCode = 'in' | 'au' | 'gb';

/** Canonical storefront market from API path or geo (`us`/`ae` → `gb`). */
export function normalizeMarketCountry(value: string | null | undefined): MarketCountryCode {
  const code = String(value || 'in').toLowerCase().trim().split('-')[0];
  if (code === 'in') return 'in';
  if (code === 'au') return 'au';
  return 'gb';
}

export function marketDisplayCurrency(country: MarketCountryCode): 'INR' | 'AUD' | 'USD' {
  if (country === 'in') return 'INR';
  if (country === 'au') return 'AUD';
  return 'USD';
}

export type MarketFxSnapshot = {
  inrPerUsd: number;
  inrPerAud: number;
};
