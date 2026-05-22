import express, { type Request } from 'express';
import cors from 'cors';
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
];

const isPublicGet = (req: Request): boolean => {
  if (req.method !== 'GET' && req.method !== 'OPTIONS') return false;
  const path = req.path || '';
  return PUBLIC_GET_PATHS.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );
};

const allowedOrigins = parseAllowedOrigins();
const strictCorsOptions: cors.CorsOptions =
  allowedOrigins && allowedOrigins.length > 0
    ? {
        origin: (reqOrigin, callback) => {
          if (!reqOrigin) {
            callback(null, true);
            return;
          }
          const normalized = reqOrigin.replace(/\/$/, '');
          if (allowedOrigins.includes(normalized)) {
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

app.use((req, res, next) => {
  if (isPublicGet(req)) return publicCors(req, res, next);
  return strictCors(req, res, next);
});
app.use(express.json({ limit: '12mb' }));
app.use(loggerMiddleware);

app.use('/api/v1', apiRouter);

app.use(errorMiddleware);

export { app };
