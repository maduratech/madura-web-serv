import { Router } from 'express';
import { phoneOtpSendRateLimit } from '../../middlewares/rate-limit.middleware';
import { sendFormSubmitPhoneOtp } from '../../services/phone-auth.service';

const formsRouter = Router();

function clientIp(req: { headers: Record<string, unknown>; ip?: string }): string {
  const forwarded = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0]
    ?.trim();
  return forwarded || req.ip || 'unknown';
}

/** POST /api/v1/forms/mobile/send-code — send OTP for website enquiry forms (India +91, IN market). */
formsRouter.post('/forms/mobile/send-code', phoneOtpSendRateLimit, async (req, res, next) => {
  try {
    const phone = String(req.body?.phone || '').trim();
    if (!phone) {
      return res.status(400).json({ message: 'Mobile number is required.' });
    }
    const result = await sendFormSubmitPhoneOtp(phone, clientIp(req));
    return res.status(200).json(result);
  } catch (err) {
    return next(err);
  }
});

export { formsRouter };
