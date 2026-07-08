import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { HttpError } from '../lib/http-error';

export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return next(new HttpError(400, 'Invalid request. Please check your input and try again.'));
    }
    req.body = parsed.data;
    return next();
  };
}
