import { type NextFunction, type Request, type Response } from 'express';

const loggerMiddleware = (_req: Request, _res: Response, next: NextFunction) => {
  next();
};

export { loggerMiddleware };
