import type { NextFunction, Request, Response } from 'express';
import { supabase } from '../lib/supabase';

/**
 * Authenticated user context populated by `requireAuth`. Attached to `req.auth`.
 * Profile fields fall back to auth.users metadata if the profiles row is missing.
 */
export type AuthContext = {
  userId: string;
  email: string | null;
  /** From `profiles` table, may be null if customer hasn't filled it in yet. */
  fullName: string | null;
  phone: string | null;
  avatarUrl: string | null;
  /** Numeric customers.id in the CRM database (after a sync). */
  crmCustomerId: number | null;
};

declare module 'express-serve-static-core' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface Request {
    auth?: AuthContext;
  }
}

/**
 * Verifies a Supabase access token from the Authorization header and loads the
 * matching profiles row. Use on any /account/** route. Failure returns 401.
 *
 * Routes that are user-aware but optional (e.g. `POST /bookings`) should use
 * `attachAuthIfPresent` instead so the request still proceeds for guests.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const ctx = await loadAuthFromHeader(req);
  if (!ctx) {
    res.status(401).json({ message: 'You must be signed in to access this resource.' });
    return;
  }
  req.auth = ctx;
  next();
}

export async function attachAuthIfPresent(req: Request, _res: Response, next: NextFunction) {
  const ctx = await loadAuthFromHeader(req);
  if (ctx) req.auth = ctx;
  next();
}

export async function loadAuthFromHeader(req: Request): Promise<AuthContext | null> {
  const header = String(req.headers.authorization || '').trim();
  const token = header.toLowerCase().startsWith('bearer ')
    ? header.slice(7).trim()
    : '';
  if (!token) return null;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) return null;
    const user = data.user;
    let fullName: string | null = null;
    let phone: string | null = null;
    let avatarUrl: string | null = null;
    let crmCustomerId: number | null = null;
    try {
      const { data: profile } = await supabase
        .from('profiles')
        .select('full_name,phone,avatar_url,crm_customer_id')
        .eq('id', user.id)
        .maybeSingle();
      if (profile) {
        fullName = (profile as { full_name?: string | null }).full_name ?? null;
        phone = (profile as { phone?: string | null }).phone ?? null;
        avatarUrl = (profile as { avatar_url?: string | null }).avatar_url ?? null;
        crmCustomerId =
          (profile as { crm_customer_id?: number | null }).crm_customer_id ?? null;
      }
    } catch {
      // Silently ignore — profile may not exist yet on first call.
    }
    return {
      userId: user.id,
      email: user.email ?? null,
      fullName,
      phone,
      avatarUrl,
      crmCustomerId,
    };
  } catch {
    return null;
  }
}
