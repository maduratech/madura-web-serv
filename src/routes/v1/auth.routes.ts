import { Router } from 'express';
import { phoneOtpSendRateLimit, phoneOtpVerifyRateLimit } from '../../middlewares/rate-limit.middleware';
import { requireTurnstile } from '../../middlewares/turnstile.middleware';
import { validateBody } from '../../validation/validate-body.middleware';
import { authPhoneBodySchema } from '../../validation/schemas';
import { sendPhoneOtp, verifyPhoneOtp } from '../../services/phone-auth.service';

const authRouter = Router();

function clientIp(req: { headers: Record<string, unknown>; ip?: string }): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    ?.trim();
  return forwarded || req.ip || 'unknown';
}

/** POST /api/v1/auth/mobile/send-code — send 6-digit mobile verification code (India +91). */
authRouter.post(
  '/auth/mobile/send-code',
  phoneOtpSendRateLimit,
  requireTurnstile,
  validateBody(authPhoneBodySchema),
  async (req, res, next) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    if (!phone) {
      return res.status(400).json({ message: 'Mobile number is required.' });
    }
    const result = await sendPhoneOtp(phone, clientIp(req));
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

/** POST /api/v1/auth/mobile/verify-code — verify mobile code and return session tokens. */
authRouter.post('/auth/mobile/verify-code', phoneOtpVerifyRateLimit, async (req, res, next) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    const otp = String(req.body?.otp || '').trim();
    if (!phone || !otp) {
      return res.status(400).json({ message: 'Invalid or expired code.' });
    }
    const result = await verifyPhoneOtp(phone, otp);
    return res.status(200).json({ data: result });
  } catch (err) {
    return next(err);
  }
});

export { authRouter };
