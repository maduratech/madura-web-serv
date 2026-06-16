import express, { type Request } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { apiRouter } from './routes';
import { errorMiddleware } from './middlewares/error.middleware';
import { loggerMiddleware } from './middlewares/logger.middleware';
import { env } from './config/env';

const parseAllowedOrigins = (): string[] | null => {
  const raw = String(env.CORS_ORIGINS || '').trim();
  if (!raw) return null;
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
};

/**
 * Read-only public endpoints (catalog data). These are safe to expose to any
 * browser origin — no auth, no side effects — so we always send
 * `Access-Control-Allow-Origin: *` for GET on these paths.
 */
const PUBLIC_GET_PATHS = [
  '/api/v1/tours',
  '/api/v1/tours-listing',
  '/api/v1/destinations',
  '/api/v1/search-options',
  '/api/v1/destination-showcase',
  '/api/v1/blogs',
  '/api/v1/guides',
  '/api/v1/guide',
  '/api/v1/pricing',
  '/api/v1/pricing/forex-rates',
  '/api/v1/visas',
  '/api/v1/site',
];

const isPublicGet = (req: Request): boolean => {
  if (req.method !== 'GET' && req.method !== 'OPTIONS') return false;
  const path = req.path || '';
  return PUBLIC_GET_PATHS.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
};

const allowedOrigins = parseAllowedOrigins();

/** Mirror localhost/127.0.0.1 and bare vs www hostnames for CMS staff browsers. */
const expandCorsOrigins = (origins: string[]): string[] => {
  const out = new Set(origins);
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost') {
        out.add(`${url.protocol}//127.0.0.1${url.port ? `:${url.port}` : ''}`);
      }
      if (url.hostname === '127.0.0.1') {
        out.add(`${url.protocol}//localhost${url.port ? `:${url.port}` : ''}`);
      }
      if (url.hostname.startsWith('www.')) {
        const bareHost = url.hostname.slice(4);
        out.add(`${url.protocol}//${bareHost}${url.port ? `:${url.port}` : ''}`);
      } else if (!url.hostname.startsWith('www.')) {
        out.add(`${url.protocol}//www.${url.hostname}${url.port ? `:${url.port}` : ''}`);
      }
      if (url.protocol === 'https:') {
        out.add(`http://${url.host}`);
      }
    } catch {
      /* ignore invalid entries */
    }
  }
  return [...out];
};

const corsAllowList =
  allowedOrigins && allowedOrigins.length > 0 ? expandCorsOrigins(allowedOrigins) : null;

const strictCorsOptions: cors.CorsOptions =
  corsAllowList && corsAllowList.length > 0
    ? {
        origin: (reqOrigin, callback) => {
          if (!reqOrigin) {
            callback(null, true);
            return;
          }
          const normalized = reqOrigin.replace(/\/$/, '');
          if (corsAllowList.includes(normalized)) {
            callback(null, true);
            return;
          }
          callback(null, false);
        },
        credentials: true,
      }
    : {};

const publicCors = cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
});
const strictCors = cors(strictCorsOptions);

const app = express();

app.set('trust proxy', 1);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false,
  })
);

app.use((req, res, next) => {
  if (isPublicGet(req)) return publicCors(req, res, next);
  return strictCors(req, res, next);
});
app.use(express.json({ limit: '12mb' }));
app.use(loggerMiddleware);

app.use('/api/v1', apiRouter);

app.use(errorMiddleware);

export { app };
