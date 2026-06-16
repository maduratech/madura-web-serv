import type { NextFunction, Request, Response } from 'express';

type RateLimitOptions = {
  windowMs: number;
  max: number;
  keyPrefix: string;
  message?: string;
};

const stores = new Map<string, Map<string, number[]>>();

function consumeSlidingWindow(
  store: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const hits = (store.get(key) || []).filter((ts) => now - ts < windowMs);
  if (hits.length >= limit) {
    const retryAfterMs = Math.max(0, windowMs - (now - hits[0]));
    store.set(key, hits);
    return { allowed: false, retryAfterMs };
  }
  hits.push(now);
  store.set(key, hits);
  return { allowed: true, retryAfterMs: 0 };
}

function clientKey(req: Request): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    ?.trim();
  return forwarded || req.ip || 'unknown';
}

export function createRateLimit(options: RateLimitOptions) {
  const storeKey = options.keyPrefix;
  if (!stores.has(storeKey)) stores.set(storeKey, new Map());
  const store = stores.get(storeKey)!;

  return (req: Request, res: Response, next: NextFunction) => {
    const authUser = req.auth?.userId;
    const key = authUser ? `user:${authUser}` : `ip:${clientKey(req)}`;
    const result = consumeSlidingWindow(store, key, options.max, options.windowMs);
    if (!result.allowed) {
      const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        message: options.message || 'Too many requests. Please try again shortly.',
      });
      return;
    }
    next();
  };
}

/** Payment order / verify — 20 requests per 10 minutes per user or IP. */
export const paymentRateLimit = createRateLimit({
  keyPrefix: 'payment',
  windowMs: 10 * 60 * 1000,
  max: 20,
  message: 'Too many payment attempts. Please wait a few minutes and try again.',
});

/** Booking creation — 8 per 10 minutes per user or IP. */
export const bookingCreateRateLimit = createRateLimit({
  keyPrefix: 'booking-create',
  windowMs: 10 * 60 * 1000,
  max: 8,
  message: 'Too many booking attempts. Please wait a few minutes and try again.',
});
