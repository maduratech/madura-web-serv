/** CMS meta prefix in tours.overview (matches madura-web). */

export type CrmDefaultRoom = {
  adults: number;
  children: number;
  child_ages?: number[];
};

export type TourCmsMeta = {
  crm_itinerary_id?: number;
  /** Room split from CRM lead — pre-fills website Guests & rooms. */
  default_rooms?: CrmDefaultRoom[];
  tour_program_type?: 'group_scheduled' | 'flexible';
  tour_category?: string;
  flights?: unknown[];
  flight_cost_inr?: number | null;
  hotels?: unknown[];
  page_inclusions?: string[];
  [key: string]: unknown;
};

const META_B64_RE = /^<!--cms-meta-b64:([A-Za-z0-9+/=]+)-->\s*/;

function encodeUtf8Base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

export function splitOverviewWithMeta(raw: string | null | undefined): {
  meta: TourCmsMeta;
  body: string;
} {
  const text = String(raw || '').trim();
  if (!text) return { meta: {}, body: '' };
  const match = text.match(META_B64_RE);
  if (!match) return { meta: {}, body: text };
  try {
    const parsed = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as TourCmsMeta;
    return { meta: parsed || {}, body: text.slice(match[0].length).trim() };
  } catch {
    return { meta: {}, body: text };
  }
}

export function joinOverviewWithMeta(body: string, meta: TourCmsMeta): string {
  const html = body.trim();
  const payload = Object.fromEntries(
    Object.entries(meta).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
  if (!Object.keys(payload).length) return html;
  const b64 = encodeUtf8Base64(JSON.stringify(payload));
  return `<!--cms-meta-b64:${b64}-->\n${html}`;
}
