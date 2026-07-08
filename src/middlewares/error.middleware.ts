import { type NextFunction, type Request, type Response } from 'express';
import { HttpError } from '../lib/http-error';
import { publicErrorMessageForStatus } from '../lib/sanitize-public-error';
import { captureServerException } from '../lib/sentry';

const errorMiddleware = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  const statusCode = err instanceof HttpError ? err.statusCode : 500;
  const raw = err instanceof Error ? err.message : 'Internal Server Error';
  const message = publicErrorMessageForStatus(statusCode, raw);

  if (statusCode >= 500) {
    console.error(
      `[ERROR] ${req.method} ${req.originalUrl} → ${statusCode}`,
      err instanceof Error ? err.stack || err.message : err
    );
    captureServerException(err, {
      method: req.method,
      url: req.originalUrl,
      statusCode,
    });
  } else {
    console.warn(`[WARN] ${req.method} ${req.originalUrl} → ${statusCode}: ${raw}`);
  }

  res.status(statusCode).json({
    error: message,
    message,
  });
};

export { errorMiddleware };
