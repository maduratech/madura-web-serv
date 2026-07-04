import { type NextFunction, type Request, type Response } from 'express';

const loggerMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const { method, originalUrl } = req;

  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    if (status >= 400) {
      console.warn(`[HTTP] ${method} ${originalUrl} ${status} ${ms}ms`);
    } else if (ms > 3000) {
      console.warn(`[HTTP-SLOW] ${method} ${originalUrl} ${status} ${ms}ms`);
    }
  });

  next();
};

export { loggerMiddleware };
