import { type NextFunction, type Request, type Response } from 'express';

/** 404s that are normal app flow (frontend fallback, bots) — skip PM2 error-log noise. */
function isExpectedNotFound(req: Request, status: number): boolean {
  if (status !== 404) return false;
  const path = (req.path || req.originalUrl || '').split('?')[0];
  if (req.method === 'GET' && path === '/') return true;
  if (req.method === 'GET' && path.startsWith('/api/v1/tour-taxonomy-slug/')) return true;
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
