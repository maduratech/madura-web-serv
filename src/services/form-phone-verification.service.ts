import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { HttpError } from '../lib/http-error';
import { normalizeIndianMobile, phonesMatchLast10 } from '../lib/indian-phone';
import type { VerifyPhoneOtpResult } from './phone-auth.service';
import {
  issueSessionForIndianPhone,
  saveVerifiedProfilePhone,
  verifyFormSubmitPhoneOtp,
} from './phone-auth.service';

const FORM_TOKEN_TTL_MS = 15 * 60 * 1000;

type StoredFormToken = {
  phoneE164: string;
  expiresAt: number;
  consumed: boolean;
};

const formTokenStore = new Map<string, StoredFormToken>();

export function sweepFormTokenStore(now = Date.now()): void {
  for (const [jti, entry] of formTokenStore) {
    if (entry.consumed || now >= entry.expiresAt) {
      formTokenStore.delete(jti);
    }
  }
}

function requireTokenPepper(): string {
  const pepper = String(env.PHONE_OTP_PEPPER || '').trim();
  if (!pepper) {
    throw new HttpError(503, 'SMS verification is not configured yet. Please try again later.');
  }
  return pepper;
}

function signFormToken(jti: string, phoneE164: string, expiresAt: number): string {
  return createHmac('sha256', requireTokenPepper())
    .update(`${jti}:${phoneE164}:${expiresAt}`)
    .digest('hex');
}

export function isIndiaMarket(market?: string | null): boolean {
  const normalized = String(market || '')
    .trim()
    .toLowerCase()
    .replace(/^\//, '');
  if (!normalized) return false;
  const country = normalized.split(/[-/]/)[0];
  return country === 'in';
}

export function canSkipFormPhoneVerification(params: {
  market?: string | null;
  phone: string;
  userId?: string | null;
  profilePhone?: string | null;
}): boolean {
  if (!isIndiaMarket(params.market)) return true;

  const normalized = normalizeIndianMobile(params.phone);
  if (!normalized) return true;

  if (!params.userId) return false;

  const profilePhone = String(params.profilePhone || '').trim();
  if (!profilePhone) return false;

  return phonesMatchLast10(profilePhone, normalized.e164);
}

export function formPhoneVerificationRequired(params: {
  market?: string | null;
  phone: string;
  userId?: string | null;
  profilePhone?: string | null;
}): boolean {
  if (!isIndiaMarket(params.market)) return false;
  if (!normalizeIndianMobile(params.phone)) return false;
  return !canSkipFormPhoneVerification(params);
}

function issueFormVerificationToken(phoneE164: string): string {
  const jti = randomUUID();
  const expiresAt = Date.now() + FORM_TOKEN_TTL_MS;
  const signature = signFormToken(jti, phoneE164, expiresAt);
  formTokenStore.set(jti, { phoneE164, expiresAt, consumed: false });
  return `${jti}.${expiresAt}.${signature}`;
}

function consumeFormVerificationToken(token: string, phoneE164: string): boolean {
  const parts = String(token || '').trim().split('.');
  if (parts.length !== 3) return false;

  const [jti, expiresAtRaw, signature] = parts;
  const expiresAt = Number(expiresAtRaw);
  if (!jti || !Number.isFinite(expiresAt) || !signature) return false;

  const expected = signFormToken(jti, phoneE164, expiresAt);
  try {
    if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) {
      return false;
    }
  } catch {
    return false;
  }

  if (Date.now() > expiresAt) return false;

  const stored = formTokenStore.get(jti);
  if (!stored || stored.consumed || stored.phoneE164 !== phoneE164) return false;
  if (stored.expiresAt !== expiresAt) return false;

  stored.consumed = true;
  formTokenStore.set(jti, stored);
  return true;
}

export type ResolveFormPhoneVerificationInput = {
  market?: string | null;
  phone: string;
  userId?: string | null;
  profilePhone?: string | null;
  form_verification_token?: string | null;
  otp?: string | null;
};

export type ResolveFormPhoneVerificationResult = {
  phoneVerified: boolean;
  profilePhoneSaved: boolean;
  /** Session for guests who verified by SMS — auto sign-in after enquiry submit. */
  guestAuth?: VerifyPhoneOtpResult | null;
  guestUserId?: string | null;
};

async function guestSessionAfterPhoneVerify(
  phone: string,
  existingUserId?: string | null
): Promise<Pick<ResolveFormPhoneVerificationResult, 'guestAuth' | 'guestUserId' | 'profilePhoneSaved'>> {
  if (existingUserId) {
    const normalized = normalizeIndianMobile(phone);
    if (normalized) {
      await saveVerifiedProfilePhone(existingUserId, normalized.e164);
    }
    return { guestAuth: null, guestUserId: null, profilePhoneSaved: true };
  }

  const guestAuth = await issueSessionForIndianPhone(phone);
  return {
    guestAuth,
    guestUserId: guestAuth.user.id,
    profilePhoneSaved: true,
  };
}

export async function resolveFormPhoneVerification(
  input: ResolveFormPhoneVerificationInput
): Promise<ResolveFormPhoneVerificationResult> {
  if (canSkipFormPhoneVerification(input)) {
    const normalized = normalizeIndianMobile(input.phone);
    const phoneVerified = Boolean(
      isIndiaMarket(input.market) &&
        normalized &&
        input.userId &&
        phonesMatchLast10(String(input.profilePhone || ''), normalized.e164)
    );
    return { phoneVerified, profilePhoneSaved: false, guestAuth: null, guestUserId: null };
  }

  const normalized = normalizeIndianMobile(input.phone);
  if (!normalized) {
    throw new HttpError(400, 'Enter a valid 10-digit Indian mobile number.');
  }

  const token = String(input.form_verification_token || '').trim();
  if (token) {
    if (!consumeFormVerificationToken(token, normalized.e164)) {
      throw new HttpError(400, 'Phone verification required. Please verify your mobile number.');
    }
    const guest = await guestSessionAfterPhoneVerify(input.phone, input.userId);
    return { phoneVerified: true, ...guest };
  }

  const otp = String(input.otp || '').trim();
  if (otp) {
    await verifyFormSubmitPhoneOtp(input.phone, otp);
    const issued = issueFormVerificationToken(normalized.e164);
    consumeFormVerificationToken(issued, normalized.e164);

    const guest = await guestSessionAfterPhoneVerify(input.phone, input.userId);
    return { phoneVerified: true, ...guest };
  }

  throw new HttpError(400, 'Phone verification required. Please verify your mobile number.');
}
