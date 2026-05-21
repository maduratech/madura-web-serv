import { type NextFunction, type Request, type Response } from 'express';

const errorMiddleware = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  const message = err instanceof Error ? err.message : 'Internal Server Error';
  res.status(500).json({
    error: message,
    message,
  });
};

export { errorMiddleware };
