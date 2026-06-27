import { Router } from 'express';
import { phoneOtpSendRateLimit, phoneOtpVerifyRateLimit } from '../../middlewares/rate-limit.middleware';
import { sendPhoneOtp, verifyPhoneOtp } from '../../services/phone-auth.service';

const authRouter = Router();

function clientIp(req: { headers: Record<string, unknown>; ip?: string }): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    ?.trim();
  return forwarded || req.ip || 'unknown';
}

/** POST /api/v1/auth/phone/send-otp — send 6-digit SMS OTP (India +91 only). */
authRouter.post('/auth/phone/send-otp', phoneOtpSendRateLimit, async (req, res, next) => {
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

/** POST /api/v1/auth/phone/verify-otp — verify SMS OTP and return Supabase session tokens. */
authRouter.post('/auth/phone/verify-otp', phoneOtpVerifyRateLimit, async (req, res, next) => {
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
