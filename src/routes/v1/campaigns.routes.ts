import { Router } from 'express';
import { attachAuthIfPresent, requireAuth } from '../../middlewares/auth.middleware';
import {
  proxyStellaMarisCampaign,
  proxyStellaMarisCampaignTrusted,
} from '../../services/stella-maris-campaign.service';
import { HttpError } from '../../lib/http-error';

const campaignsRouter = Router();

function normalizeIndiaPhone(raw: string | null | undefined): string | null {
  const digits = String(raw || '').replace(/\D/g, '');
  let d = digits;
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  if (!/^[6-9]\d{9}$/.test(d)) return null;
  return `+91${d}`;
}

/** Guest OTP — forwarded to CRM as-is. */
campaignsRouter.post('/campaigns/stella-maris/otp/send', async (req, res, next) => {
  try {
    const result = await proxyStellaMarisCampaign('/api/campaign/stella-maris/otp/send', req.body || {});
    return res.status(result.status).json(result.data);
  } catch (err) {
    return next(err);
  }
});

campaignsRouter.post('/campaigns/stella-maris/otp/verify', async (req, res, next) => {
  try {
    const result = await proxyStellaMarisCampaign('/api/campaign/stella-maris/otp/verify', req.body || {});
    return res.status(result.status).json(result.data);
  } catch (err) {
    return next(err);
  }
});

/**
 * Logged-in check (same auth as /account/me).
 * If already spun (CRM customer tag), returns 409.
 */
campaignsRouter.post('/campaigns/stella-maris/check', requireAuth, async (req, res, next) => {
  try {
    const phone =
      normalizeIndiaPhone(req.body?.phone) ||
      normalizeIndiaPhone(req.auth?.phone) ||
      null;
    if (!phone) {
      return res.status(400).json({
        message: 'Your account has no Indian mobile number. Please verify with OTP.',
        needs_otp: true,
      });
    }
    const result = await proxyStellaMarisCampaignTrusted('/api/campaign/stella-maris/check', {
      phone,
    });
    if (result.status === 200) {
      return res.status(200).json({
        ...result.data,
        phone,
        full_name: req.auth?.fullName || null,
      });
    }
    return res.status(result.status).json(result.data);
  } catch (err) {
    return next(err);
  }
});

/**
 * Spin — guests send session_token; logged-in users send Bearer auth (like the rest of the site).
 */
campaignsRouter.post(
  '/campaigns/stella-maris/spin',
  attachAuthIfPresent,
  async (req, res, next) => {
    try {
      const name = String(req.body?.name || '').trim();
      if (!name || name.length < 2) {
        throw new HttpError(400, 'Please enter your full name.');
      }

      if (req.auth) {
        const phone =
          normalizeIndiaPhone(req.body?.phone) ||
          normalizeIndiaPhone(req.auth.phone) ||
          null;
        if (!phone) {
          throw new HttpError(
            400,
            'Your account has no Indian mobile number. Please verify with OTP.'
          );
        }
        const result = await proxyStellaMarisCampaignTrusted('/api/campaign/stella-maris/spin', {
          phone,
          name,
          trusted: true,
        });
        return res.status(result.status).json(result.data);
      }

      const sessionToken = String(req.body?.session_token || '').trim();
      const phone = String(req.body?.phone || '').trim();
      if (!sessionToken || !phone) {
        throw new HttpError(401, 'Please verify your mobile OTP first.');
      }
      const result = await proxyStellaMarisCampaign('/api/campaign/stella-maris/spin', {
        session_token: sessionToken,
        phone,
        name,
      });
      return res.status(result.status).json(result.data);
    } catch (err) {
      return next(err);
    }
  }
);

export { campaignsRouter };
