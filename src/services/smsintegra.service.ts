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

function isSmsConfigured(): boolean {
  return Boolean(env.SMSINTEGRA_UID && env.SMSINTEGRA_PWD);
}

/** POST OTP SMS via SMSIntegra (DLT template). */
export async function sendOtpSms(mobileDigits: string, otp: string): Promise<void> {
  if (!isSmsConfigured()) {
    throw new HttpError(503, 'SMS login is not configured yet. Try email login or try again later.');
  }

  const msg = buildOtpMessage(otp);
  const body = new URLSearchParams({
    uid: env.SMSINTEGRA_UID,
    pwd: env.SMSINTEGRA_PWD,
    mobile: mobileDigits,
    msg,
    sid: env.SMSINTEGRA_SID,
    type: '0',
    dtTimeNow: formatDtTimeNow(),
    entityid: env.SMSINTEGRA_ENTITY_ID,
    tempid: env.SMSINTEGRA_OTP_TEMPLATE_ID,
  });

  const url = env.SMSINTEGRA_API_URL || 'https://www.smsintegra.com/api/smsapi.aspx';

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[smsintegra] network error:', err);
    throw new HttpError(502, 'Could not send the verification code. Please try again.');
  }

  const text = (await response.text()).trim();
  // eslint-disable-next-line no-console
  console.info('[smsintegra] send response:', response.status, text.slice(0, 200));

  if (!response.ok) {
    throw new HttpError(502, 'Could not send the verification code. Please try again.');
  }

  const lower = text.toLowerCase();
  if (lower.includes('invalid') || lower.includes('fail') || lower.includes('error')) {
    throw new HttpError(502, 'Could not send the verification code. Please try again.');
  }
}
