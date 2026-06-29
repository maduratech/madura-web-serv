import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'crypto';
import { env } from '../config/env';
import { HttpError } from '../lib/http-error';
import { normalizeIndianMobile, phoneLast10, phonesMatchLast10 } from '../lib/indian-phone';
import { supabase } from '../lib/supabase';
import { fetchCrmHistoryForProfile } from './account.service';
import { sendOtpSms } from './otp-sms-gateway.service';

const OTP_TTL_MS = 10 * 60 * 1000;
const RESEND_COOLDOWN_MS = 30 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
const SEND_LIMIT_PER_PHONE = 3;
const SEND_LIMIT_PER_IP = 10;
const SEND_WINDOW_MS = 15 * 60 * 1000;

const sendByPhoneStore = new Map<string, number[]>();
const sendByIpStore = new Map<string, number[]>();

type PhoneOtpChallenge = {
  id: string;
  phone_e164: string;
  otp_hash: string;
  expires_at: string;
  attempt_count: number;
  consumed_at: string | null;
  created_at: string;
  purpose?: string | null;
  user_id?: string | null;
};

type OtpPurpose = 'login' | 'profile' | 'form_submit';

type ProfileMatch = {
  id: string;
  phone: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

function requireOtpPepper(): string {
  const pepper = String(env.PHONE_OTP_PEPPER || '').trim();
  if (!pepper) {
    throw new HttpError(503, 'SMS login is not configured yet. Try email login or try again later.');
  }
  return pepper;
}

function hashOtp(challengeId: string, phoneE164: string, otp: string): string {
  return createHmac('sha256', requireOtpPepper())
    .update(`${challengeId}:${phoneE164}:${otp}`)
    .digest('hex');
}

function verifyOtpHash(challengeId: string, phoneE164: string, otp: string, expectedHex: string): boolean {
  const actual = hashOtp(challengeId, phoneE164, otp);
  try {
    return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHex, 'hex'));
  } catch {
    return false;
  }
}

function consumeRateLimit(
  store: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number
): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const hits = (store.get(key) || []).filter((ts) => now - ts < windowMs);
  if (hits.length >= limit) {
    const retryAfterMs = Math.max(0, windowMs - (now - hits[0]));
    store.set(key, hits);
    return { allowed: false, retryAfterMs };
  }
  hits.push(now);
  store.set(key, hits);
  return { allowed: true, retryAfterMs: 0 };
}

async function invalidateOpenChallenges(phoneE164: string, purpose: OtpPurpose = 'login'): Promise<void> {
  const nowIso = new Date().toISOString();
  let query = supabase
    .from('phone_otp_challenges')
    .update({ consumed_at: nowIso })
    .eq('phone_e164', phoneE164)
    .is('consumed_at', null);
  query = query.eq('purpose', purpose);
  await query;
}

async function getRecentChallenge(phoneE164: string, purpose: OtpPurpose = 'login'): Promise<PhoneOtpChallenge | null> {
  const { data, error } = await supabase
    .from('phone_otp_challenges')
    .select('id,phone_e164,otp_hash,expires_at,attempt_count,consumed_at,created_at,purpose,user_id')
    .eq('phone_e164', phoneE164)
    .eq('purpose', purpose)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    const fallback = await supabase
      .from('phone_otp_challenges')
      .select('id,phone_e164,otp_hash,expires_at,attempt_count,consumed_at,created_at')
      .eq('phone_e164', phoneE164)
      .is('consumed_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (fallback.error) {
      // eslint-disable-next-line no-console
      console.error('[phone-auth] challenge lookup failed:', fallback.error.message);
      throw new HttpError(500, 'Could not send the verification code. Please try again.');
    }
    return (fallback.data as PhoneOtpChallenge | null) ?? null;
  }
  return (data as PhoneOtpChallenge | null) ?? null;
}

async function insertChallenge(row: {
  id: string;
  phone_e164: string;
  otp_hash: string;
  expires_at: string;
  purpose: OtpPurpose;
  user_id?: string | null;
}): Promise<void> {
  const fullRow = {
    id: row.id,
    phone_e164: row.phone_e164,
    otp_hash: row.otp_hash,
    expires_at: row.expires_at,
    attempt_count: 0,
    purpose: row.purpose,
    user_id: row.user_id ?? null,
  };
  let insertError = (await supabase.from('phone_otp_challenges').insert(fullRow)).error;
  if (insertError) {
    insertError = (
      await supabase.from('phone_otp_challenges').insert({
        id: row.id,
        phone_e164: row.phone_e164,
        otp_hash: row.otp_hash,
        expires_at: row.expires_at,
        attempt_count: 0,
      })
    ).error;
  }
  if (insertError) {
    // eslint-disable-next-line no-console
    console.error('[phone-auth] challenge insert failed:', insertError.message);
    throw new HttpError(500, 'Could not send the verification code. Please try again.');
  }
}

async function assertPhoneAvailableForUser(userId: string, last10: string): Promise<void> {
  const matches = await findProfilesByPhone(last10);
  const taken = matches.find((row) => row.id !== userId);
  if (taken) {
    throw new HttpError(409, 'This mobile number is already linked to another account.');
  }
}

async function verifyChallengeOtp(
  normalized: NonNullable<ReturnType<typeof normalizeIndianMobile>>,
  otp: string,
  purpose: OtpPurpose,
  userId?: string
): Promise<void> {
  let query = supabase
    .from('phone_otp_challenges')
    .select('id,phone_e164,otp_hash,expires_at,attempt_count,consumed_at,purpose,user_id')
    .eq('phone_e164', normalized.e164)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1);

  if (purpose) {
    query = query.eq('purpose', purpose);
  }

  const { data: challenge, error } = await query.maybeSingle();

  if (error || !challenge) {
    throw new HttpError(400, 'Invalid or expired code.');
  }

  const row = challenge as PhoneOtpChallenge;

  if (purpose === 'profile' && userId && row.user_id && row.user_id !== userId) {
    throw new HttpError(400, 'Invalid or expired code.');
  }

  if (row.attempt_count >= MAX_VERIFY_ATTEMPTS) {
    throw new HttpError(400, 'Invalid or expired code.');
  }

  if (new Date(row.expires_at).getTime() < Date.now()) {
    throw new HttpError(400, 'Invalid or expired code.');
  }

  const valid = verifyOtpHash(row.id, row.phone_e164, otp, row.otp_hash);

  await supabase
    .from('phone_otp_challenges')
    .update({ attempt_count: row.attempt_count + 1 })
    .eq('id', row.id);

  if (!valid) {
    throw new HttpError(400, 'Invalid or expired code.');
  }

  await supabase
    .from('phone_otp_challenges')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', row.id);
}

async function sendOtpCore(
  rawPhone: string,
  clientIp: string,
  purpose: OtpPurpose,
  userId?: string
): Promise<SendPhoneOtpResult> {
  const normalized = normalizeIndianMobile(rawPhone);
  if (!normalized) {
    throw new HttpError(400, 'Enter a valid 10-digit Indian mobile number.');
  }

  requireOtpPepper();

  if (purpose === 'profile' && userId) {
    await assertPhoneAvailableForUser(userId, normalized.last10);
  }

  const rateKey = purpose === 'profile' && userId ? `${purpose}:${userId}` : normalized.e164;
  const phoneRate = consumeRateLimit(sendByPhoneStore, rateKey, SEND_LIMIT_PER_PHONE, SEND_WINDOW_MS);
  if (!phoneRate.allowed) {
    throw new HttpError(
      429,
      `Too many code requests. Try again in ${Math.ceil(phoneRate.retryAfterMs / 1000)} seconds.`
    );
  }

  const ipKey = clientIp || 'unknown';
  const ipRate = consumeRateLimit(sendByIpStore, ipKey, SEND_LIMIT_PER_IP, SEND_WINDOW_MS);
  if (!ipRate.allowed) {
    throw new HttpError(
      429,
      `Too many code requests. Try again in ${Math.ceil(ipRate.retryAfterMs / 1000)} seconds.`
    );
  }

  const recent = await getRecentChallenge(normalized.e164, purpose);
  if (recent?.created_at) {
    const ageMs = Date.now() - new Date(recent.created_at).getTime();
    if (ageMs < RESEND_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((RESEND_COOLDOWN_MS - ageMs) / 1000);
      throw new HttpError(429, `Please wait ${retryAfterSec} seconds before requesting a new code.`);
    }
  }

  await invalidateOpenChallenges(normalized.e164, purpose);

  const otp = String(randomInt(100000, 1000000));
  const challengeId = randomUUID();
  const otpHash = hashOtp(challengeId, normalized.e164, otp);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  await insertChallenge({
    id: challengeId,
    phone_e164: normalized.e164,
    otp_hash: otpHash,
    expires_at: expiresAt,
    purpose,
    user_id: userId ?? null,
  });

  await sendOtpSms(normalized.smsDigits, otp);

  return { ok: true };
}

async function findProfilesByPhone(last10: string): Promise<ProfileMatch[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('id,phone,created_at,updated_at')
    .or(`phone.eq.+91${last10},phone.eq.91${last10},phone.eq.${last10}`)
    .limit(20);

  if (error) {
    const fallback = await supabase
      .from('profiles')
      .select('id,phone,created_at')
      .or(`phone.eq.+91${last10},phone.eq.91${last10},phone.eq.${last10}`)
      .limit(20);
    if (fallback.error) {
      // eslint-disable-next-line no-console
      console.warn('[phone-auth] profile lookup failed:', fallback.error.message);
      return [];
    }
    return ((fallback.data as ProfileMatch[]) || []).filter((row) => phonesMatchLast10(row.phone || '', last10));
  }

  return ((data as ProfileMatch[]) || []).filter((row) => phonesMatchLast10(row.phone || '', last10));
}

function pickBestProfile(matches: ProfileMatch[]): ProfileMatch | null {
  if (!matches.length) return null;
  return [...matches].sort((a, b) => {
    const aTs = new Date(a.updated_at || a.created_at || 0).getTime();
    const bTs = new Date(b.updated_at || b.created_at || 0).getTime();
    return bTs - aTs;
  })[0];
}

async function ensureProfilePhone(userId: string, phoneE164: string): Promise<void> {
  await supabase.from('profiles').upsert({ id: userId, phone: phoneE164 }, { onConflict: 'id' });
}

async function resolveUserIdForPhone(phoneE164: string, last10: string): Promise<string> {
  const matches = await findProfilesByPhone(last10);
  const best = pickBestProfile(matches);
  if (best?.id) {
    await ensureProfilePhone(best.id, phoneE164);
    return best.id;
  }

  const crm = await fetchCrmHistoryForProfile(phoneE164, null);
  if (crm.customer?.id) {
    const { data: byCrm } = await supabase
      .from('profiles')
      .select('id')
      .eq('crm_customer_id', crm.customer.id)
      .maybeSingle();
    if (byCrm?.id) {
      await ensureProfilePhone(byCrm.id as string, phoneE164);
      return byCrm.id as string;
    }
  }

  const { data: created, error } = await supabase.auth.admin.createUser({
    phone: phoneE164,
    phone_confirm: true,
  });
  if (error || !created.user?.id) {
    // eslint-disable-next-line no-console
    console.error('[phone-auth] createUser failed:', error?.message);
    throw new HttpError(500, 'Could not sign you in. Please try again.');
  }

  await ensureProfilePhone(created.user.id, phoneE164);
  return created.user.id;
}

async function ensureSessionEmail(userId: string, phoneE164: string): Promise<string> {
  const { data: userData, error } = await supabase.auth.admin.getUserById(userId);
  if (error) {
    throw new HttpError(500, 'Could not sign you in. Please try again.');
  }
  const existing = String(userData.user?.email || '').trim();
  if (existing) return existing;

  const placeholder = `phone.${phoneLast10(phoneE164)}@phone.maduratravel.com`;
  const { error: updateError } = await supabase.auth.admin.updateUserById(userId, {
    email: placeholder,
    email_confirm: true,
  });
  if (updateError) {
    // eslint-disable-next-line no-console
    console.error('[phone-auth] placeholder email update failed:', updateError.message);
    throw new HttpError(500, 'Could not sign you in. Please try again.');
  }
  return placeholder;
}

async function createSessionForUser(userId: string, phoneE164: string) {
  const email = await ensureSessionEmail(userId, phoneE164);
  const { data: linkData, error: linkError } = await supabase.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  if (linkError || !linkData?.properties?.hashed_token) {
    // eslint-disable-next-line no-console
    console.error('[phone-auth] generateLink failed:', linkError?.message);
    throw new HttpError(500, 'Could not sign you in. Please try again.');
  }

  const { data: verifyData, error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'email',
  });
  if (verifyError || !verifyData.session) {
    // eslint-disable-next-line no-console
    console.error('[phone-auth] verifyOtp failed:', verifyError?.message);
    throw new HttpError(500, 'Could not sign you in. Please try again.');
  }

  return verifyData;
}

export type SendPhoneOtpResult = {
  ok: true;
  retryAfterSec?: number;
};

export async function sendPhoneOtp(rawPhone: string, clientIp: string): Promise<SendPhoneOtpResult> {
  const normalized = normalizeIndianMobile(rawPhone);
  if (!normalized) {
    throw new HttpError(
      400,
      'Enter a valid 10-digit Indian mobile number, or use email login for numbers outside India.'
    );
  }
  return sendOtpCore(rawPhone, clientIp, 'login');
}

export async function sendProfilePhoneOtp(
  userId: string,
  rawPhone: string,
  clientIp: string
): Promise<SendPhoneOtpResult> {
  return sendOtpCore(rawPhone, clientIp, 'profile', userId);
}

export async function sendFormSubmitPhoneOtp(rawPhone: string, clientIp: string): Promise<SendPhoneOtpResult> {
  return sendOtpCore(rawPhone, clientIp, 'form_submit');
}

export async function verifyFormSubmitPhoneOtp(rawPhone: string, rawOtp: string): Promise<{ phone: string }> {
  const normalized = normalizeIndianMobile(rawPhone);
  if (!normalized) {
    throw new HttpError(400, 'Invalid or expired code.');
  }

  const otp = String(rawOtp || '').trim();
  if (!/^\d{6}$/.test(otp)) {
    throw new HttpError(400, 'Invalid or expired code.');
  }

  requireOtpPepper();
  await verifyChallengeOtp(normalized, otp, 'form_submit');

  return { phone: normalized.e164 };
}

export async function saveVerifiedProfilePhone(userId: string, phoneE164: string): Promise<void> {
  await ensureProfilePhone(userId, phoneE164);
}

export async function verifyProfilePhoneOtp(
  userId: string,
  rawPhone: string,
  rawOtp: string
): Promise<{ phone: string }> {
  const normalized = normalizeIndianMobile(rawPhone);
  if (!normalized) {
    throw new HttpError(400, 'Invalid or expired code.');
  }

  const otp = String(rawOtp || '').trim();
  if (!/^\d{6}$/.test(otp)) {
    throw new HttpError(400, 'Invalid or expired code.');
  }

  requireOtpPepper();
  await assertPhoneAvailableForUser(userId, normalized.last10);
  await verifyChallengeOtp(normalized, otp, 'profile', userId);

  return { phone: normalized.e164 };
}

export type VerifyPhoneOtpResult = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  user: {
    id: string;
    phone: string | null;
    email: string | null;
  };
};

/** Find or create a customer by verified Indian mobile and return a Supabase session (no OTP step). */
export async function issueSessionForIndianPhone(rawPhone: string): Promise<VerifyPhoneOtpResult> {
  const normalized = normalizeIndianMobile(rawPhone);
  if (!normalized) {
    throw new HttpError(400, 'Enter a valid 10-digit Indian mobile number.');
  }

  const userId = await resolveUserIdForPhone(normalized.e164, normalized.last10);
  const sessionData = await createSessionForUser(userId, normalized.e164);
  const session = sessionData.session!;
  const user = sessionData.user ?? session.user;

  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in ?? 3600,
    token_type: session.token_type ?? 'bearer',
    user: {
      id: userId,
      phone: user?.phone ?? normalized.e164,
      email: user?.email ?? null,
    },
  };
}

export async function verifyPhoneOtp(rawPhone: string, rawOtp: string): Promise<VerifyPhoneOtpResult> {
  const normalized = normalizeIndianMobile(rawPhone);
  if (!normalized) {
    throw new HttpError(400, 'Invalid or expired code.');
  }

  const otp = String(rawOtp || '').trim();
  if (!/^\d{6}$/.test(otp)) {
    throw new HttpError(400, 'Invalid or expired code.');
  }

  requireOtpPepper();
  await verifyChallengeOtp(normalized, otp, 'login');

  const userId = await resolveUserIdForPhone(normalized.e164, normalized.last10);

  const sessionData = await createSessionForUser(userId, normalized.e164);
  const session = sessionData.session!;
  const user = sessionData.user ?? session.user;

  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in ?? 3600,
    token_type: session.token_type ?? 'bearer',
    user: {
      id: userId,
      phone: user?.phone ?? normalized.e164,
      email: user?.email ?? null,
    },
  };
}

export { phoneLast10 };