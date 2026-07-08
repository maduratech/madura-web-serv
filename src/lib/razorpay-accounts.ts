import crypto from 'crypto';
import Razorpay from 'razorpay';
import { env } from '../config/env';

export type RazorpayAccount = 'in';

export type RazorpayChargeCurrency = 'INR';

type RazorpayCredentials = {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
};

const clients = new Map<RazorpayAccount, Razorpay>();

function credentialsFor(_account: RazorpayAccount): RazorpayCredentials {
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

/** India Razorpay account — used for all storefronts (INR charges; international cards supported). */
export function resolveRazorpayAccountForCurrency(
  _displayCurrency: string | null | undefined
): RazorpayAccount {
  return 'in';
}

export function chargeCurrencyForAccount(_account: RazorpayAccount): RazorpayChargeCurrency {
  return 'INR';
}

export function getRazorpayClient(account: RazorpayAccount): Razorpay {
  if (!razorpayAccountConfigured(account)) {
    throw new Error('Razorpay credentials for India (INR) are not configured.');
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
  for (const account of ['in'] as const) {
    const { webhookSecret } = credentialsFor(account);
    if (!webhookSecret) continue;
    const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
    if (expected === signature) return account;
  }
  return null;
}
