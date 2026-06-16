export type BlogContentType = 'blog' | 'guide';

export function normalizeBlogContentType(raw: unknown): BlogContentType {
  return String(raw || '').trim().toLowerCase() === 'guide' ? 'guide' : 'blog';
}

export function blogPublicSegment(contentType: BlogContentType): 'blogs' | 'guide' {
  return contentType === 'guide' ? 'guide' : 'blogs';
}

export function blogPublicPath(contentType: BlogContentType, slug: string, marketPrefix = ''): string {
  const safeSlug = String(slug || '').trim();
  const prefix = marketPrefix.replace(/\/$/, '');
  const segment = blogPublicSegment(contentType);
  return safeSlug ? `${prefix}/${segment}/${safeSlug}` : `${prefix}/${segment}`;
}
