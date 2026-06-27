import { env } from '../config/env';
import { HttpError } from '../lib/http-error';

const OTP_TEMPLATE =
  'Hi, Your login OTP is {#var#}. Do not share with anyone. - Madura Travel Service (Pvt) Ltd.';

function formatDtTimeNow(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const hours = now.getHours();
  const h12 = hours % 12 || 12;
  const ampm = hours >= 12 ? 'PM' : 'AM';
  return `${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${now.getFullYear()} ${pad(h12)}:${pad(now.getMinutes())}:${pad(now.getSeconds())} ${ampm}`;
}

export function buildOtpMessage(otp: string): string {
  return OTP_TEMPLATE.replace('{#var#}', otp);
}

function isOtpSmsConfigured(): boolean {
  return Boolean(
    env.OTP_SMS_UID &&
      env.OTP_SMS_PWD &&
      env.OTP_SMS_SENDER_ID &&
      env.OTP_SMS_ENTITY_ID &&
      env.OTP_SMS_TEMPLATE_ID &&
      env.OTP_SMS_GATEWAY_URL
  );
}

/** Send OTP SMS via configured DLT gateway (server-only credentials). */
export async function sendOtpSms(mobileDigits: string, otp: string): Promise<void> {
  if (!isOtpSmsConfigured()) {
    throw new HttpError(503, 'SMS login is not configured yet. Try email login or try again later.');
  }

  const msg = buildOtpMessage(otp);
  const body = new URLSearchParams({
    uid: env.OTP_SMS_UID,
    pwd: env.OTP_SMS_PWD,
    mobile: mobileDigits,
    msg,
    sid: env.OTP_SMS_SENDER_ID,
    type: '0',
    dtTimeNow: formatDtTimeNow(),
    entityid: env.OTP_SMS_ENTITY_ID,
    tempid: env.OTP_SMS_TEMPLATE_ID,
  });

  const url = env.OTP_SMS_GATEWAY_URL;
  if (!url) {
    throw new HttpError(503, 'SMS login is not configured yet. Try email login or try again later.');
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[otp-sms] gateway network error:', err);
    throw new HttpError(502, 'Could not send the verification code. Please try again.');
  }

  const text = (await response.text()).trim();
  // eslint-disable-next-line no-console
  console.info('[otp-sms] gateway response status:', response.status);

  if (!response.ok) {
    throw new HttpError(502, 'Could not send the verification code. Please try again.');
  }

  const lower = text.toLowerCase();
  if (lower.includes('invalid') || lower.includes('fail') || lower.includes('error')) {
    throw new HttpError(502, 'Could not send the verification code. Please try again.');
  }
}
