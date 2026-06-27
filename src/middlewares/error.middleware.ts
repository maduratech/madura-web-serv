import { type NextFunction, type Request, type Response } from 'express';
import { HttpError } from '../lib/http-error';
import { sanitizePublicErrorMessage } from '../lib/sanitize-public-error';

const errorMiddleware = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  const statusCode = err instanceof HttpError ? err.statusCode : 500;
  const raw = err instanceof Error ? err.message : 'Internal Server Error';
  const fallback = statusCode >= 500 ? 'Something went wrong. Please try again.' : raw;
  const message = sanitizePublicErrorMessage(raw, fallback);
  res.status(statusCode).json({
    error: message,
    message,
  });
};

export { errorMiddleware };
