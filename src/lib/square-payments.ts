import crypto from 'crypto';
import { env } from '../config/env';

const SQUARE_API_VERSION = '2024-10-17';

export type SquareEnvironment = 'sandbox' | 'production';

export function inferSquareEnvironment(applicationId: string): SquareEnvironment {
  return applicationId.startsWith('sandbox-') ? 'sandbox' : 'production';
}

export function squareConfigured(): boolean {
  return Boolean(env.SQUARE_APPLICATION_ID && env.SQUARE_ACCESS_TOKEN);
}

function squareApiBase(environment: SquareEnvironment): string {
  return environment === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
}

async function squareRequest<T>(
  path: string,
  options: { method?: string; body?: unknown; environment?: SquareEnvironment } = {}
): Promise<T> {
  if (!env.SQUARE_ACCESS_TOKEN) {
    throw new Error('Square access token is not configured.');
  }
  const environment =
    options.environment || inferSquareEnvironment(env.SQUARE_APPLICATION_ID || 'sandbox-');
  const response = await fetch(`${squareApiBase(environment)}${path}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${env.SQUARE_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_API_VERSION,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = (await response.json()) as T & { errors?: Array<{ detail?: string; code?: string }> };
  if (!response.ok) {
    const detail = data.errors?.[0]?.detail || data.errors?.[0]?.code || 'Square API request failed';
    throw new Error(detail);
  }
  return data;
}

let cachedLocationId: string | null = null;

export async function resolveSquareLocationId(): Promise<string> {
  if (env.SQUARE_LOCATION_ID) return env.SQUARE_LOCATION_ID;
  if (cachedLocationId) return cachedLocationId;

  const environment = inferSquareEnvironment(env.SQUARE_APPLICATION_ID || 'sandbox-');
  const data = await squareRequest<{
    locations?: Array<{ id?: string; status?: string }>;
  }>('/v2/locations', { environment });

  const active = (data.locations || []).find((loc) => loc.status === 'ACTIVE' && loc.id);
  if (!active?.id) {
    throw new Error(
      'Square location ID is not configured. Set SQUARE_LOCATION_ID in the server environment.'
    );
  }
  cachedLocationId = active.id;
  return active.id;
}

export type SquarePaymentResult = {
  id: string;
  status: string;
  amountMoney?: { amount?: number; currency?: string };
  createdAt?: string;
  orderId?: string;
  receiptUrl?: string;
};

export async function createSquarePayment(input: {
  sourceId: string;
  idempotencyKey: string;
  amountMinor: number;
  currency: 'AUD';
  referenceId?: string;
  note?: string;
}): Promise<SquarePaymentResult> {
  const locationId = await resolveSquareLocationId();
  const environment = inferSquareEnvironment(env.SQUARE_APPLICATION_ID || 'sandbox-');

  const data = await squareRequest<{ payment?: SquarePaymentResult }>('/v2/payments', {
    method: 'POST',
    environment,
    body: {
      source_id: input.sourceId,
      idempotency_key: input.idempotencyKey,
      amount_money: {
        amount: input.amountMinor,
        currency: input.currency,
      },
      location_id: locationId,
      reference_id: input.referenceId,
      note: input.note,
    },
  });

  const payment = data.payment;
  if (!payment?.id) {
    throw new Error('Square did not return a payment id.');
  }
  if (String(payment.status || '').toUpperCase() !== 'COMPLETED') {
    throw new Error(`Square payment status: ${payment.status || 'unknown'}`);
  }
  return payment;
}

export function newSquareIdempotencyKey(bookingId: number, purpose: 'advance' | 'balance'): string {
  return `sq_${bookingId}_${purpose}_${crypto.randomUUID()}`;
}

export function getSquareApplicationId(): string {
  if (!env.SQUARE_APPLICATION_ID) {
    throw new Error('SQUARE_APPLICATION_ID is not configured.');
  }
  return env.SQUARE_APPLICATION_ID;
}

export function getSquareEnvironment(): SquareEnvironment {
  return env.SQUARE_ENVIRONMENT === 'production'
    ? 'production'
    : inferSquareEnvironment(env.SQUARE_APPLICATION_ID || 'sandbox-');
}
