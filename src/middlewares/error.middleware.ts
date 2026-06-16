import { type NextFunction, type Request, type Response } from 'express';
import { HttpError } from '../lib/http-error';

const errorMiddleware = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  const statusCode = err instanceof HttpError ? err.statusCode : 500;
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  res.status(statusCode).json({
    error: message,
    message,
  });
};

export { errorMiddleware };
