import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';

/** Server-to-server calls from madura-crm-25-serv (shared secret). */
export function requireCrmIntegrationSecret(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const expected = String(env.CRM_WEB_INTEGRATION_SECRET || '').trim();
  if (!expected) {
    res.status(503).json({
      message:
        'CRM web integration is not configured (set CRM_WEB_INTEGRATION_SECRET).',
    });
    return;
  }
  const provided = String(req.get('x-integration-secret') || '').trim();
  if (provided !== expected) {
    res.status(401).json({ message: 'Invalid integration secret.' });
    return;
  }
  next();
}
