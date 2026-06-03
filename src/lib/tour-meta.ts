import type { TourMarketAudience, TourMarketPricing } from './tour-market-audience';
import { splitOverviewWithMeta } from './tour-overview-meta';

export type TourCmsMeta = {
  promo_badge_id?: number | null;
  promo_badge?: string;
  gst_percent?: number | null;
  tds_percent?: number | null;
  price_tax_note?: string;
  page_inclusions?: string[];
  tour_category?: 'Family' | 'Honeymoon' | 'Friends' | 'Group Tour';
  /** CMS tour type label (Family Holidays, Group Tours, etc.). */
  tour_type?: string;
  tour_program_type?: 'group_scheduled' | 'flexible';
  /** Checkout / display discount (0–100). */
  discount_percent?: number | null;
  child_bed_age_min?: number | null;
  flight_cost_inr?: number | null;
  flights?: Array<{ cost_inr?: number | null }>;
  market_audience?: TourMarketAudience;
  pricing_usd?: TourMarketPricing;
  pricing_aud?: TourMarketPricing;
  /** Per-departure USD overrides (key = city|start_date). Group tours with scheduled departures. */
  departure_pricing_usd?: Record<string, TourMarketPricing>;
  departure_usd_manual?: string[];
};

export function parseTourCmsMeta(raw: string | null | undefined): TourCmsMeta {
  return splitOverviewWithMeta(raw).meta as TourCmsMeta;
}

export function defaultTaxPercentsForMarket(marketCountry: string): { gst: number; tds: number } {
  if (marketCountry === 'in') return { gst: 5, tds: 2 };
  return { gst: 0, tds: 0 };
}

const LEGACY_TOUR_TYPE_MAP: Record<string, string> = {
  Family: 'Family Holidays',
  Honeymoon: 'Honeymoon Packages',
  Friends: 'Friends Getaway Tours',
  'Group Tour': 'Group Tours',
};

/** Display tour type from CMS meta (overview JSON). */
export function resolveTourTypeLabel(meta: Pick<TourCmsMeta, 'tour_type' | 'tour_category'>): string {
  const direct = String(meta.tour_type || '').trim();
  if (direct) return direct;
  const legacy = meta.tour_category;
  if (legacy && LEGACY_TOUR_TYPE_MAP[legacy]) return LEGACY_TOUR_TYPE_MAP[legacy];
  return legacy ? String(legacy).trim() : '';
}

/** Listing/detail pill label — CMS tour type first, then flow_type fallback. */
export function resolveListingTourType(
  meta: Pick<TourCmsMeta, 'tour_type' | 'tour_category'>,
  flowType: 'enquiry' | 'booking' | 'both'
): string {
  const fromMeta = resolveTourTypeLabel(meta);
  if (fromMeta) return fromMeta;
  return flowType === 'booking' ? 'Group Package' : 'Customizable';
}

export function isGroupStyleTourType(label: string): boolean {
  const t = label.trim().toLowerCase();
  return t.includes('group tour') || t === 'group package' || t === 'group tours';
}
