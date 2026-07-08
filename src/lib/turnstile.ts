import { env } from '../config/env';
import { HttpError } from './http-error';

type TurnstileVerifyResponse = {
  success: boolean;
  'error-codes'?: string[];
};

export function isTurnstileConfigured(): boolean {
  return Boolean(env.TURNSTILE_SECRET_KEY.trim());
}

export function extractTurnstileToken(body: Record<string, unknown> | null | undefined): string {
  const raw =
    body?.turnstile_token ??
    body?.['cf-turnstile-response'] ??
    body?.turnstileToken;
  return String(raw || '').trim();
}

/** Verify a Cloudflare Turnstile token. Skipped when TURNSTILE_SECRET_KEY is unset (local dev). */
export async function verifyTurnstileToken(
  token: string,
  remoteIp?: string | null
): Promise<void> {
  if (!isTurnstileConfigured()) return;

  const trimmed = String(token || '').trim();
  if (!trimmed) {
    throw new HttpError(400, 'Security verification is required. Please refresh and try again.');
  }

  const form = new URLSearchParams();
  form.set('secret', env.TURNSTILE_SECRET_KEY);
  form.set('response', trimmed);
  if (remoteIp) form.set('remoteip', remoteIp);

  let payload: TurnstileVerifyResponse;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    payload = (await response.json()) as TurnstileVerifyResponse;
  } catch {
    throw new HttpError(503, 'Security verification is temporarily unavailable. Please try again.');
  }

  if (!payload.success) {
    throw new HttpError(400, 'Security verification failed. Please refresh and try again.');
  }
}
