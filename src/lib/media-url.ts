const PLACEHOLDER_HOSTS = new Set(['your-public-url', 'example.com', 'www.example.com', 'placeholder.com']);

export function isUsableMediaUrl(value: string | null | undefined): boolean {
  return normalizeMediaUrl(value) != null;
}

export function normalizeMediaUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^your-public-url/i.test(trimmed)) return null;

  if (trimmed.startsWith('/')) return trimmed;

  try {
    const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : null;
    if (!withProtocol) return null;
    const url = new URL(withProtocol);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (PLACEHOLDER_HOSTS.has(url.hostname.toLowerCase())) return null;
    return withProtocol;
  } catch {
    return null;
  }
}

export function sanitizeRichHtmlMediaUrls(html: string): string {
  if (!html.trim()) return html;
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const srcMatch = tag.match(/\bsrc=(["'])(.*?)\1/i);
    if (!srcMatch) return tag;
    return isUsableMediaUrl(srcMatch[2]) ? tag : '';
  });
}
