import { Router } from 'express';
import {
  approveItineraryEngagement,
  fetchEngagementGateStatus,
  recordItineraryHeartbeat,
  recordItineraryView,
  requestItineraryChanges,
  verifyItineraryCode,
} from '../../services/itinerary-engagement.service';
import { requireAuth } from '../../middlewares/auth.middleware';
import {
  buildSessionCookieValue,
  parseSessionCookieValue,
  verifySessionCookie,
} from '../../lib/itinerary-access-cookie';

const itineraryEngagementRouter = Router();

const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function cookieName(itineraryId: number) {
  return `ia_${itineraryId}`;
}

function readSessionFromCookie(req: { cookies?: Record<string, string>; headers: { cookie?: string } }, itineraryId: number) {
  const fromParser = req.cookies?.[cookieName(itineraryId)];
  if (fromParser) return String(fromParser);
  const raw = String(req.headers.cookie || '');
  const prefix = `${cookieName(itineraryId)}=`;
  const part = raw
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(prefix));
  return part ? decodeURIComponent(part.slice(prefix.length)) : '';
}

function setAccessCookie(
  res: { cookie?: (name: string, value: string, opts: Record<string, unknown>) => void; setHeader: (k: string, v: string) => void },
  itineraryId: number,
  sessionId: string,
  accessCodeVersion: number
) {
  const value = buildSessionCookieValue(itineraryId, sessionId, accessCodeVersion);
  const opts = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`;
  if (typeof res.cookie === 'function') {
    res.cookie(cookieName(itineraryId), value, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: COOKIE_MAX_AGE_MS,
      path: '/',
    });
    return;
  }
  res.setHeader('Set-Cookie', `${cookieName(itineraryId)}=${encodeURIComponent(value)}; ${opts}`);
}

itineraryEngagementRouter.get('/itinerary-engagement/:itineraryId/gate-status', async (req, res, next) => {
  try {
    const itineraryId = Number(req.params.itineraryId);
    if (!itineraryId) {
      return res.status(400).json({ message: 'Invalid itinerary id.' });
    }
    const status = await fetchEngagementGateStatus(itineraryId);
    const cookieRaw = readSessionFromCookie(req, itineraryId);
    const parsed = parseSessionCookieValue(cookieRaw);
    const unlocked = Boolean(parsed?.sessionId);
    return res.json({ ...status, unlocked });
  } catch (err) {
    return next(err);
  }
});

itineraryEngagementRouter.post('/itinerary-engagement/verify-code', async (req, res, next) => {
  try {
    const itineraryId = Number(req.body?.itineraryId);
    if (!itineraryId) {
      return res.status(400).json({ message: 'itineraryId is required.' });
    }
    const result = (await verifyItineraryCode({
      itineraryId,
      code: req.body?.code,
      previewToken: req.body?.previewToken,
      userAgent: req.get('user-agent') || undefined,
      ip: String(req.ip || req.headers['x-forwarded-for'] || ''),
    })) as {
      ok: boolean;
      message?: string;
      sessionId?: string;
      accessCodeVersion?: number;
      isStaffPreview?: boolean;
      trackingEnabled?: boolean;
      retryAfterMs?: number;
    };

    if (!result.ok) {
      const status = result.retryAfterMs ? 429 : 401;
      return res.status(status).json(result);
    }

    if (result.sessionId && result.accessCodeVersion) {
      setAccessCookie(res, itineraryId, result.sessionId, result.accessCodeVersion);
    }

    return res.json({
      ok: true,
      isStaffPreview: result.isStaffPreview,
      trackingEnabled: result.trackingEnabled,
    });
  } catch (err) {
    return next(err);
  }
});

function resolveTrackingSessionId(
  req: { body?: { clientSessionId?: string; accessCodeVersion?: number }; cookies?: Record<string, string>; headers: { cookie?: string } },
  itineraryId: number
): string | null {
  const cookieRaw = readSessionFromCookie(req, itineraryId);
  const parsed = parseSessionCookieValue(cookieRaw);
  const accessCodeVersion = Number(req.body?.accessCodeVersion) || 1;
  if (
    parsed?.sessionId &&
    verifySessionCookie(itineraryId, parsed.sessionId, parsed.sig, accessCodeVersion)
  ) {
    return parsed.sessionId;
  }
  const clientSid = String(req.body?.clientSessionId || '').trim();
  if (clientSid.length >= 8) return clientSid;
  return null;
}

itineraryEngagementRouter.post('/itinerary-engagement/view', async (req, res, next) => {
  try {
    const itineraryId = Number(req.body?.itineraryId);
    if (!itineraryId) {
      return res.status(400).json({ message: 'itineraryId is required.' });
    }
    const sessionId = resolveTrackingSessionId(req, itineraryId);
    if (!sessionId) {
      return res.status(400).json({ message: 'clientSessionId is required.' });
    }

    const result = await recordItineraryView({
      itineraryId,
      sessionId,
      viewerUserId: req.body?.viewerUserId || null,
      userAgent: req.get('user-agent') || undefined,
      isStaffPreview: Boolean(req.body?.isStaffPreview),
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

itineraryEngagementRouter.post('/itinerary-engagement/heartbeat', async (req, res, next) => {
  try {
    const itineraryId = Number(req.body?.itineraryId);
    if (!itineraryId) {
      return res.status(400).json({ message: 'itineraryId is required.' });
    }
    const sessionId = resolveTrackingSessionId(req, itineraryId);
    if (!sessionId) {
      return res.status(400).json({ message: 'clientSessionId is required.' });
    }

    const result = await recordItineraryHeartbeat({
      itineraryId,
      sessionId,
      activeSeconds: Number(req.body?.activeSeconds) || 0,
      isStaffPreview: Boolean(req.body?.isStaffPreview),
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

itineraryEngagementRouter.post('/itinerary-engagement/approve', requireAuth, async (req, res, next) => {
  try {
    const itineraryId = Number(req.body?.itineraryId);
    if (!itineraryId) {
      return res.status(400).json({ message: 'itineraryId is required.' });
    }
    const result = await approveItineraryEngagement({
      itineraryId,
      userId: req.auth!.userId,
      crmCustomerId: req.auth!.crmCustomerId,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

itineraryEngagementRouter.post('/itinerary-engagement/request-changes', requireAuth, async (req, res, next) => {
  try {
    const itineraryId = Number(req.body?.itineraryId);
    const text = String(req.body?.text || '').trim();
    if (!itineraryId) {
      return res.status(400).json({ message: 'itineraryId is required.' });
    }
    if (!text) {
      return res.status(400).json({ message: 'Please describe the changes you need.' });
    }
    const result = await requestItineraryChanges({
      itineraryId,
      userId: req.auth!.userId,
      crmCustomerId: req.auth!.crmCustomerId,
      text,
    });
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

export { itineraryEngagementRouter };
