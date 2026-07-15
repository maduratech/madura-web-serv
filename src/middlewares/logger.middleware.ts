import { type NextFunction, type Request, type Response } from 'express';

/**
 * 404s that are normal storefront resolution (pages probe several endpoints
 * and fall back) — do not write them to PM2 error logs.
 */
function isExpectedNotFound(req: Request, status: number): boolean {
  if (status !== 404 || req.method !== 'GET') return false;

  const path = String(req.path || '').split('?')[0];
  const url = String(req.originalUrl || '').split('?')[0];
  const full = `${path} ${url}`;

  // Bots / health probes
  if (path === '/' || url === '/' || url === '/api/v1' || url === '/api/v1/') return true;
  if (/\/favicon\.ico$/i.test(full)) return true;

  // Package pages: try taxonomy slug first; most destinations have no taxonomy row.
  if (/\/tour-taxonomy-slug\//i.test(full)) return true;

  // Destination package pages then fall back to destination-by-slug.
  if (/\/destinations\/[^/]+$/i.test(full) && !/\/destinations\/\d+$/i.test(full)) return true;

  // Public visa pages by country slug — missing country = empty state, not a server fault.
  if (/\/visas\/[^/]+$/i.test(full) && !/\/visas\/\d+$/i.test(full)) return true;

  // Tour detail by slug/id — deleted, draft, or wrong URL. Frontend shows not-found page.
  if (/\/tours\/[^/]+$/i.test(full) && !/\/tours\/[^/]+\/departures$/i.test(full)) return true;

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
