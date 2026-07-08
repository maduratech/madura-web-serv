import type { NextFunction, Request, Response } from 'express';
import { extractTurnstileToken, verifyTurnstileToken } from '../lib/turnstile';

function clientIp(req: Request): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    ?.trim();
  return forwarded || req.ip || 'unknown';
}

/** Require a valid Cloudflare Turnstile token in the JSON body (skipped when secret is unset). */
export function requireTurnstile(req: Request, _res: Response, next: NextFunction) {
  void verifyTurnstileToken(extractTurnstileToken(req.body), clientIp(req))
    .then(() => next())
    .catch(next);
}
