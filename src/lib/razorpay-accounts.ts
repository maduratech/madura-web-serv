import crypto from 'crypto';
import Razorpay from 'razorpay';
import { env } from '../config/env';

export type RazorpayAccount = 'in' | 'au';

export type RazorpayChargeCurrency = 'INR' | 'AUD';

type RazorpayCredentials = {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
};

const clients = new Map<RazorpayAccount, Razorpay>();

function credentialsFor(account: RazorpayAccount): RazorpayCredentials {
  if (account === 'au') {
    return {
      keyId: env.RAZORPAY_AU_KEY_ID,
      keySecret: env.RAZORPAY_AU_KEY_SECRET,
      webhookSecret: env.RAZORPAY_AU_WEBHOOK_SECRET,
    };
  }
  return {
    keyId: env.RAZORPAY_IN_KEY_ID,
    keySecret: env.RAZORPAY_IN_KEY_SECRET,
    webhookSecret: env.RAZORPAY_IN_WEBHOOK_SECRET,
  };
}

export function razorpayAccountConfigured(account: RazorpayAccount): boolean {
  const { keyId, keySecret } = credentialsFor(account);
  return Boolean(keyId && keySecret);
}

/** AU storefront bookings (`display_currency` AUD) use the Australia Razorpay account. */
export function resolveRazorpayAccountForCurrency(
  displayCurrency: string | null | undefined
): RazorpayAccount {
  const cur = String(displayCurrency || '').toUpperCase().trim();
  if (cur === 'AUD') {
    if (!razorpayAccountConfigured('au')) {
      throw new Error(
        'Razorpay Australia (AUD) credentials are not configured. Set RAZORPAY_AU_KEY_ID and RAZORPAY_AU_KEY_SECRET.'
      );
    }
    return 'au';
  }
  return 'in';
}

export function chargeCurrencyForAccount(account: RazorpayAccount): RazorpayChargeCurrency {
  return account === 'au' ? 'AUD' : 'INR';
}

/** Charge amount already in the gateway currency (INR on `in`, AUD on `au`) — no FX conversion. */
export function chargeAmountMinorUnits(
  amountMajor: number,
  account: RazorpayAccount
): { minorUnits: number; currency: RazorpayChargeCurrency; majorAmount: number } {
  const raw = Number(amountMajor) || 0;
  if (account === 'au') {
    const audMajor = Math.max(0.5, Math.round(raw * 100) / 100);
    return { minorUnits: Math.round(audMajor * 100), currency: 'AUD', majorAmount: audMajor };
  }
  const inrMajor = Math.max(0, Math.round(raw));
  return { minorUnits: inrMajor * 100, currency: 'INR', majorAmount: inrMajor };
}

export function getRazorpayClient(account: RazorpayAccount): Razorpay {
  if (!razorpayAccountConfigured(account)) {
    const label = account === 'au' ? 'Australia (AUD)' : 'India (INR)';
    throw new Error(`Razorpay credentials for ${label} are not configured.`);
  }
  let client = clients.get(account);
  if (!client) {
    const { keyId, keySecret } = credentialsFor(account);
    client = new Razorpay({ key_id: keyId, key_secret: keySecret });
    clients.set(account, client);
  }
  return client;
}

export function getRazorpayKeyId(account: RazorpayAccount): string {
  return credentialsFor(account).keyId;
}

export function verifyPaymentSignature(
  account: RazorpayAccount,
  orderId: string,
  paymentId: string,
  signature: string
): boolean {
  const { keySecret } = credentialsFor(account);
  if (!keySecret) return false;
  const expected = crypto.createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex');
  return expected === signature;
}

export function resolveWebhookAccount(rawBody: string, signature: string | undefined): RazorpayAccount | null {
  if (!signature) return null;
  for (const account of ['in', 'au'] as const) {
    const { webhookSecret } = credentialsFor(account);
    if (!webhookSecret) continue;
    const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    if (expected === signature) return account;
  }
  return null;
}
