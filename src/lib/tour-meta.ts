export type TourCmsMeta = {
  promo_badge?: string;
  gst_percent?: number | null;
  tds_percent?: number | null;
  price_tax_note?: string;
  page_inclusions?: string[];
  tour_category?: 'Family' | 'Honeymoon' | 'Friends' | 'Group Tour';
  tour_program_type?: 'group_scheduled' | 'flexible';
  /** Checkout / display discount (0–100). */
  discount_percent?: number | null;
  child_bed_age_min?: number | null;
  flight_cost_inr?: number | null;
  flights?: Array<{ cost_inr?: number | null }>;
};

const META_RE = /^<!--cms-meta:([\s\S]*?)-->\s*/;

export function parseTourCmsMeta(raw: string | null | undefined): TourCmsMeta {
  const text = String(raw || '').trim();
  if (!text) return {};
  const match = text.match(META_RE);
  if (!match) return {};
  try {
    return (JSON.parse(match[1]) as TourCmsMeta) || {};
  } catch {
    return {};
  }
}

export function defaultTaxPercentsForMarket(marketCountry: string): { gst: number; tds: number } {
  if (marketCountry === 'in') return { gst: 5, tds: 2 };
  return { gst: 0, tds: 0 };
}
