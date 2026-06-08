import crypto from 'crypto';
import { env } from '../config/env';

function cookieSecret(): string {
  const secret = String(env.CRM_WEB_INTEGRATION_SECRET || '').trim();
  if (!secret) throw new Error('CRM_WEB_INTEGRATION_SECRET is not configured.');
  return secret;
}

function signSessionToken(
  itineraryId: number,
  sessionId: string,
  accessCodeVersion: number
): string {
  const payload = `${itineraryId}:${sessionId}:${accessCodeVersion}`;
  return crypto.createHmac('sha256', cookieSecret()).update(payload).digest('hex');
}

export function buildSessionCookieValue(
  itineraryId: number,
  sessionId: string,
  accessCodeVersion: number
): string {
  const sig = signSessionToken(itineraryId, sessionId, accessCodeVersion);
  return `${sessionId}.${sig}`;
}

export function parseSessionCookieValue(raw: string): { sessionId: string; sig: string } | null {
  const text = String(raw || '').trim();
  const dot = text.lastIndexOf('.');
  if (dot <= 0) return null;
  return {
    sessionId: text.slice(0, dot),
    sig: text.slice(dot + 1),
  };
}

export function verifySessionCookie(
  itineraryId: number,
  sessionId: string,
  sig: string,
  accessCodeVersion: number
): boolean {
  try {
    const expected = signSessionToken(itineraryId, sessionId, accessCodeVersion);
    return crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
