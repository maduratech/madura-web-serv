/** Payment storefront: India (INR), Australia (AUD), global/international (USD). */
export type PaymentStorefront = 'in' | 'au' | 'gb';

export type PaymentGateway = 'razorpay' | 'square';

export type ChargeCurrency = 'INR' | 'AUD' | 'USD';

export function resolveStorefront(displayCurrency: string | null | undefined): PaymentStorefront {
  const cur = String(displayCurrency || '').toUpperCase().trim();
  if (!cur || cur === 'INR') return 'in';
  if (cur === 'AUD') return 'au';
  return 'gb';
}

/** Default gateway when customer does not choose (India / global → Razorpay). */
export function resolvePaymentGateway(_displayCurrency: string | null | undefined): PaymentGateway {
  return 'razorpay';
}

export function chargeCurrencyForStorefront(storefront: PaymentStorefront): ChargeCurrency {
  if (storefront === 'au') return 'AUD';
  if (storefront === 'gb') return 'USD';
  return 'INR';
}

/** Charge amount in major units → minor units for Razorpay. */
export function chargeAmountMinorUnits(
  amountMajor: number,
  storefront: PaymentStorefront
): { minorUnits: number; currency: ChargeCurrency; majorAmount: number } {
  const raw = Number(amountMajor) || 0;
  const currency = chargeCurrencyForStorefront(storefront);
  if (currency === 'AUD' || currency === 'USD') {
    const major = Math.max(0.5, Math.round(raw * 100) / 100);
    return { minorUnits: Math.round(major * 100), currency, majorAmount: major };
  }
  const inrMajor = Math.max(0, Math.round(raw));
  return { minorUnits: inrMajor * 100, currency: 'INR', majorAmount: inrMajor };
}
