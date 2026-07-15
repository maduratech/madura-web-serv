import { type NextFunction, type Request, type Response } from 'express';

/** 404s that are normal app flow (frontend fallback, bots) — skip PM2 error-log noise. */
function isExpectedNotFound(req: Request, status: number): boolean {
  if (status !== 404) return false;
  const path = String(req.path || '').split('?')[0];
  const url = String(req.originalUrl || '').split('?')[0];
  const candidate = `${path} ${url}`;

  if (req.method === 'GET' && (path === '/' || url === '/')) return true;
  if (req.method === 'GET' && /\/favicon\.ico$/i.test(candidate)) return true;
  // Destination package pages always probe taxonomy first; most destinations have no CMS taxonomy row.
  if (req.method === 'GET' && candidate.includes('/tour-taxonomy-slug/')) return true;
  return false;
}

const loggerMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const { method, originalUrl } = req;

  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    if (status >= 400 && !isExpectedNotFound(req, status)) {
      console.warn(`[HTTP] ${method} ${originalUrl} ${status} ${ms}ms`);
    } else if (ms > 3000) {
      console.warn(`[HTTP-SLOW] ${method} ${originalUrl} ${status} ${ms}ms`);
    }
  });

  next();
};

export { loggerMiddleware };
