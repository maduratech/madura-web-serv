const VENDOR_PATTERNS = [
  /smsintegra/i,
  /smsintegra\.(com|net)/i,
  /SMSINTEGRA_[A-Z_]+/,
];

/** Strip vendor/provider names before returning errors to clients or logs shown to users. */
export function sanitizePublicErrorMessage(message: string, fallback = 'Something went wrong. Please try again.'): string {
  const trimmed = String(message || '').trim();
  if (!trimmed) return fallback;
  if (VENDOR_PATTERNS.some((pattern) => pattern.test(trimmed))) return fallback;
  return trimmed;
}
