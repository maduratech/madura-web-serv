export const SUPPORTED_DOCUMENT_FORMATS_LABEL = 'JPG, PNG, WebP, or PDF';

export const MAX_DOCUMENT_UPLOAD_BYTES = 5 * 1024 * 1024;

export const ALLOWED_DOCUMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const;

export type AllowedDocumentMime = (typeof ALLOWED_DOCUMENT_MIME_TYPES)[number];

const BLOCKED_EXTENSIONS = [
  '.html',
  '.htm',
  '.js',
  '.mjs',
  '.svg',
  '.exe',
  '.bat',
  '.cmd',
  '.php',
  '.zip',
  '.rar',
  '.7z',
  '.gz',
  '.tar',
];

type DetectedFormat = 'jpeg' | 'png' | 'webp' | 'pdf';

const FORMAT_TO_MIME: Record<DetectedFormat, AllowedDocumentMime> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

export type DocumentUploadValidationInput = {
  name: string;
  type: string;
  content: string;
};

export type DocumentUploadValidationResult =
  | { ok: true; mime: AllowedDocumentMime; buffer: Buffer }
  | { ok: false; message: string };

function normalizeMime(type: string): string {
  const mime = String(type || '')
    .trim()
    .toLowerCase();
  if (!mime) return '';
  if (mime === 'image/jpg' || mime === 'image/pjpeg') return 'image/jpeg';
  if (mime === 'application/x-pdf') return 'application/pdf';
  return mime;
}

function isAllowedMime(mime: string): mime is AllowedDocumentMime {
  return (ALLOWED_DOCUMENT_MIME_TYPES as readonly string[]).includes(mime);
}

function hasBlockedExtension(fileName: string): boolean {
  const lower = String(fileName || '').trim().toLowerCase();
  return BLOCKED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function parseDocumentDataUrl(
  dataUrl: string
): { mime: string; buffer: Buffer } | null {
  const raw = String(dataUrl || '');
  const match = /^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,([\s\S]*)$/i.exec(raw);
  if (!match) return null;
  const mime = normalizeMime(match[1] || 'application/octet-stream');
  const isBase64 = Boolean(match[2]);
  const payload = String(match[3] || '');
  try {
    const buffer = isBase64
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8');
    if (!buffer.length) return null;
    return { mime, buffer };
  } catch {
    return null;
  }
}

function detectFormat(buffer: Buffer): DetectedFormat | null {
  if (buffer.length < 4) return null;

  if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return 'pdf';

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';

  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return 'png';
  }

  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return 'webp';
  }

  return null;
}

function mimeMatchesFormat(mime: string, format: DetectedFormat): boolean {
  return mime === FORMAT_TO_MIME[format];
}

/**
 * Validates customer travel-document uploads: allowlisted MIME + magic-byte signature.
 * Returns friendly, customer-facing error copy when validation fails.
 */
export function validateCustomerDocumentUpload(
  input: DocumentUploadValidationInput
): DocumentUploadValidationResult {
  const name = String(input.name || '').trim();
  const declaredMime = normalizeMime(input.type);
  const content = String(input.content || '').trim();

  if (!name || !content) {
    return {
      ok: false,
      message: "We couldn't read that file. Please choose it again from your device.",
    };
  }

  if (hasBlockedExtension(name)) {
    return {
      ok: false,
      message: `This file type isn't supported. Please upload a travel document as ${SUPPORTED_DOCUMENT_FORMATS_LABEL}.`,
    };
  }

  if (/^https?:\/\//i.test(content)) {
    return {
      ok: false,
      message:
        'Please upload the file directly from your device. Web links are not accepted for document uploads.',
    };
  }

  if (!content.startsWith('data:')) {
    return {
      ok: false,
      message: "We couldn't read that file. Please choose it again from your device.",
    };
  }

  const parsed = parseDocumentDataUrl(content);
  if (!parsed?.buffer?.length) {
    return {
      ok: false,
      message: "We couldn't read that file. Please choose it again from your device.",
    };
  }

  if (parsed.buffer.length > MAX_DOCUMENT_UPLOAD_BYTES) {
    return {
      ok: false,
      message: 'This file is too large. Please upload a file up to 5 MB.',
    };
  }

  const detected = detectFormat(parsed.buffer);
  if (!detected) {
    return {
      ok: false,
      message: `This file doesn't look like a valid image or PDF. Please upload ${SUPPORTED_DOCUMENT_FORMATS_LABEL} only.`,
    };
  }

  const canonicalMime = FORMAT_TO_MIME[detected];
  const mimeFromClient = declaredMime || parsed.mime;
  const effectiveMime =
    mimeFromClient && mimeFromClient !== 'application/octet-stream'
      ? mimeFromClient
      : canonicalMime;

  if (!isAllowedMime(effectiveMime)) {
    return {
      ok: false,
      message: `This file type isn't supported. Please upload a passport, visa, or travel document as ${SUPPORTED_DOCUMENT_FORMATS_LABEL}.`,
    };
  }

  if (!mimeMatchesFormat(effectiveMime, detected)) {
    return {
      ok: false,
      message: `This file doesn't match its format. Please save or export it as ${SUPPORTED_DOCUMENT_FORMATS_LABEL}, then try again.`,
    };
  }

  return { ok: true, mime: canonicalMime, buffer: parsed.buffer };
}
