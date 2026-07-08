/** Storefront derived from booking display currency. */
export type PaymentStorefront = 'in' | 'au';

export type PaymentGateway = 'razorpay';

export type ChargeCurrency = 'INR';

export function resolveStorefront(displayCurrency: string | null | undefined): PaymentStorefront {
  return String(displayCurrency || '').toUpperCase().trim() === 'AUD' ? 'au' : 'in';
}

/** All storefronts use Razorpay (India account; international cards accepted). */
export function resolvePaymentGateway(_displayCurrency: string | null | undefined): PaymentGateway {
  return 'razorpay';
}

export function chargeCurrencyForStorefront(_storefront: PaymentStorefront): ChargeCurrency {
  return 'INR';
}

/** Charge amount in major units → minor units for Razorpay (INR). */
export function chargeAmountMinorUnits(
  amountMajor: number,
  _storefront: PaymentStorefront
): { minorUnits: number; currency: ChargeCurrency; majorAmount: number } {
  const inrMajor = Math.max(0, Math.round(Number(amountMajor) || 0));
  return { minorUnits: inrMajor * 100, currency: 'INR', majorAmount: inrMajor };
}
