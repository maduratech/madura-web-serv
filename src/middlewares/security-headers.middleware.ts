import type { NextFunction, Request, Response } from 'express';

/** Lightweight security headers (no helmet dependency). */
export function securityHeadersMiddleware(_req: Request, res: Response, next: NextFunction) {
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.removeHeader('X-Powered-By');
  next();
}
