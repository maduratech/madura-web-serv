import { type NextFunction, type Request, type Response } from 'express';

const errorMiddleware = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
) => {
  res.status(500).json({
    error: err instanceof Error ? err.message : 'Internal Server Error',
  });
};

export { errorMiddleware };
