/** Normalize user input to Indian mobile E.164 (+91XXXXXXXXXX) and SMS digits (91XXXXXXXXXX). */
export type NormalizedIndianPhone = {
  e164: string;
  last10: string;
  smsDigits: string;
};

export function phoneLast10(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length >= 10) return digits.slice(-10);
  return digits;
}

export function phonesMatchLast10(a: string, b: string): boolean {
  const la = phoneLast10(a);
  const lb = phoneLast10(b);
  return la.length === 10 && lb.length === 10 && la === lb;
}

export function normalizeIndianMobile(input: string): NormalizedIndianPhone | null {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const digits = raw.replace(/\D/g, '');
  let last10 = '';

  if (raw.startsWith('+91')) {
    last10 = digits.slice(2);
  } else if (digits.startsWith('91') && digits.length >= 12) {
    last10 = digits.slice(-10);
  } else if (digits.length === 10) {
    last10 = digits;
  } else {
    return null;
  }

  if (!/^[6-9]\d{9}$/.test(last10)) return null;

  return {
    e164: `+91${last10}`,
    last10,
    smsDigits: `91${last10}`,
  };
}
