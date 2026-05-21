import type { NextFunction, Request, Response } from 'express';
import { loadAuthFromHeader } from './auth.middleware';
import { getCmsStaffByUserId } from '../services/cms.service';

export type CmsAuthContext = {
  userId: string;
  email: string;
  fullName: string | null;
  role: 'staff' | 'super_admin';
};

declare module 'express-serve-static-core' {
  interface Request {
    cmsAuth?: CmsAuthContext;
  }
}

export async function requireCmsAuth(req: Request, res: Response, next: NextFunction) {
  const base = await loadAuthFromHeader(req);
  if (!base) {
    res.status(401).json({ message: 'Sign in required.' });
    return;
  }
  const staff = await getCmsStaffByUserId(base.userId);
  if (!staff || !staff.is_active) {
    res.status(403).json({ message: 'CMS access not granted for this account.' });
    return;
  }
  req.cmsAuth = {
    userId: base.userId,
    email: staff.email,
    fullName: staff.full_name,
    role: staff.role,
  };
  next();
}

export function requireSuperAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.cmsAuth || req.cmsAuth.role !== 'super_admin') {
    res.status(403).json({ message: 'Super Admin access required.' });
    return;
  }
  next();
}
