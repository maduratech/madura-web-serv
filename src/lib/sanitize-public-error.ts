const VENDOR_PATTERNS = [
  /smsintegra/i,
  /smsintegra\.(com|net)/i,
  /SMSINTEGRA_[A-Z_]+/,
];

const TECHNICAL_PATTERNS = [
  /supabase|postgrest|postgres|pexels|ts-node/i,
  /\bCRM\b/i,
  /crm[_\s-]/i,
  /madura-web-serv/i,
  /CRM_API_URL|CRM_WEB_INTEGRATION/i,
  /integration secret|web integration/i,
  /jwt|anon[_\s-]?key|service[_\s-]?role/i,
  /relation .* does not exist/i,
  /column .* does not exist/i,
  /schema cache/i,
  /razorpay|square/i,
  /SUPABASE_|TURNSTILE_|SENTRY_/i,
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i,
  /PostgREST returned/i,
  /RLS/i,
];

const SAFE_CLIENT_PATTERNS = [
  /^you must be signed in/i,
  /^invalid document type/i,
  /^invalid document reference/i,
  /^booking id is required/i,
  /^mobile number is required/i,
  /^invalid or expired code/i,
  /^invalid request/i,
  /^security verification/i,
  /^too many/i,
  /^at least one traveller/i,
  /^name is required/i,
  /^phone is required/i,
  /^enter a valid/i,
  /^tour_id is required/i,
  /^departure_city is required/i,
  /^travel_date is required/i,
  /^destination is required/i,
  /^file name and content are required/i,
  /^customer uploads are temporarily unavailable/i,
  /^this tour requires at least \d+ adults/i,
  /^please select a collection tier/i,
  /^no group rate applies for this party size/i,
  /^traveller #\d+ is missing required fields/i,
  /^travellers count must match/i,
  /^tour not found/i,
  /^invalid departure selected/i,
  /^online booking is available when your travel date/i,
  /^AI request timed out/i,
  /^AI parse failed/i,
  /^Please paste more content/i,
  /^pastedText is required/i,
  /^Could not extract a tour/i,
  /^Content is too long/i,
  /^Please paste more detail/i,
];

function isSafeClientMessage(message: string): boolean {
  const trimmed = String(message || '').trim();
  if (!trimmed) return false;
  if (trimmed.length > 220) return false;
  return SAFE_CLIENT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** Strip vendor/provider names before returning errors to clients or logs shown to users. */
export function sanitizePublicErrorMessage(
  message: string,
  fallback = 'Something went wrong. Please try again.'
): string {
  const trimmed = String(message || '').trim();
  if (!trimmed) return fallback;
  if (VENDOR_PATTERNS.some((pattern) => pattern.test(trimmed))) return fallback;
  if (TECHNICAL_PATTERNS.some((pattern) => pattern.test(trimmed))) return fallback;
  return trimmed;
}

export function publicErrorMessageForStatus(statusCode: number, rawMessage: string): string {
  const generic500 = 'Something went wrong. Please try again.';
  const generic400 = 'Invalid request. Please check your input and try again.';
  const generic401 = 'You must be signed in to continue.';
  const generic403 = 'You do not have permission to perform this action.';
  const generic404 = 'The requested resource was not found.';
  const generic429 = 'Too many requests. Please wait a moment and try again.';

  if (statusCode >= 500) return generic500;
  if (statusCode === 429) return generic429;
  if (statusCode === 401) return generic401;
  if (statusCode === 403) return generic403;
  if (statusCode === 404) return generic404;
  if (statusCode === 400 && !isSafeClientMessage(rawMessage)) return generic400;

  const sanitized = sanitizePublicErrorMessage(rawMessage, generic400);
  if (statusCode === 400 && sanitized === generic400 && !isSafeClientMessage(rawMessage)) {
    return generic400;
  }
  return sanitized;
}
