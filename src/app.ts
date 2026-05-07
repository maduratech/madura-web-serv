import express from 'express';
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

const allowedOrigins = parseAllowedOrigins();
const corsOptions: cors.CorsOptions =
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

const app = express();

app.use(cors(corsOptions));
app.use(express.json());
app.use(loggerMiddleware);

app.use('/api/v1', apiRouter);

app.use(errorMiddleware);

export { app };
