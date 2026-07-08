import sanitizeHtml from 'sanitize-html';
import { sanitizeRichHtmlMediaUrls } from './media-url';

const CMS_HTML_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    ...(sanitizeHtml.defaults.allowedTags || []),
    'img',
    'h1',
    'h2',
    'h3',
    'span',
    'figure',
    'figcaption',
  ],
  allowedAttributes: {
    ...sanitizeHtml.defaults.allowedAttributes,
    img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'class'],
    a: ['href', 'name', 'target', 'rel', 'class'],
    '*': ['class'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowProtocolRelative: false,
};

/** Strip scripts, event handlers, and unsafe markup from CMS-authored HTML. */
export function sanitizeCmsHtml(html: string | null | undefined): string | null {
  if (html == null) return null;
  const trimmed = String(html).trim();
  if (!trimmed) return null;
  const cleaned = sanitizeHtml(trimmed, CMS_HTML_OPTIONS);
  return sanitizeRichHtmlMediaUrls(cleaned);
}
