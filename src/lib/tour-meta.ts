import type { TourMarketAudience, TourMarketPricing } from './tour-market-audience';
import { splitOverviewWithMeta } from './tour-overview-meta';

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
  market_audience?: TourMarketAudience;
  pricing_aud?: TourMarketPricing;
};

export function parseTourCmsMeta(raw: string | null | undefined): TourCmsMeta {
  return splitOverviewWithMeta(raw).meta as TourCmsMeta;
}

export function defaultTaxPercentsForMarket(marketCountry: string): { gst: number; tds: number } {
  if (marketCountry === 'in') return { gst: 5, tds: 2 };
  return { gst: 0, tds: 0 };
}
