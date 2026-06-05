/** Storefront derived from booking display currency. */
export type PaymentStorefront = 'in' | 'au';

export type PaymentGateway = 'razorpay' | 'square';

export type ChargeCurrency = 'INR' | 'AUD';

export function resolveStorefront(displayCurrency: string | null | undefined): PaymentStorefront {
  return String(displayCurrency || '').toUpperCase().trim() === 'AUD' ? 'au' : 'in';
}

export function resolvePaymentGateway(displayCurrency: string | null | undefined): PaymentGateway {
  return resolveStorefront(displayCurrency) === 'au' ? 'square' : 'razorpay';
}

export function chargeCurrencyForStorefront(storefront: PaymentStorefront): ChargeCurrency {
  return storefront === 'au' ? 'AUD' : 'INR';
}

/** Charge amount in major units → minor units for the gateway. */
export function chargeAmountMinorUnits(
  amountMajor: number,
  storefront: PaymentStorefront
): { minorUnits: number; currency: ChargeCurrency; majorAmount: number } {
  const raw = Number(amountMajor) || 0;
  if (storefront === 'au') {
    const audMajor = Math.max(0.5, Math.round(raw * 100) / 100);
    return { minorUnits: Math.round(audMajor * 100), currency: 'AUD', majorAmount: audMajor };
  }
  const inrMajor = Math.max(0, Math.round(raw));
  return { minorUnits: inrMajor * 100, currency: 'INR', majorAmount: inrMajor };
}
