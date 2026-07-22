import type { GroupPaxSlab, TourPricingModel } from './group-pax-pricing';
import type { GroupPaxCollectionTier } from './tour-collection-tiers';
import type { TourMarketAudience, TourMarketPricing } from './tour-market-audience';
import { splitOverviewWithMeta } from './tour-overview-meta';

export type { GroupPaxSlab, TourPricingModel } from './group-pax-pricing';
export type { GroupPaxCollectionTier } from './tour-collection-tiers';

export type TourCmsMeta = {
  crm_itinerary_id?: number;
  /** Smart itinerary tracking enabled for CRM-published links. */
  crm_engagement_enabled?: boolean;
  /** When true, customer sees Confirm + payment (full or partial) instead of Approve only. */
  crm_show_payment_button?: boolean;
  /** CRM itinerary display currency (e.g. AUD). Drives storefront INR vs USD. */
  crm_source_currency?: string;
  crm_costing_snapshot?: {
    currency?: string;
    per_person?: number | null;
    total?: number | null;
    adults?: number | null;
    children?: number | null;
    sharing_label?: string | null;
  };
  crm_display_prices?: {
    currency?: string;
    twin_sharing_price?: number | null;
    triple_sharing_price?: number | null;
    single_sharing_price?: number | null;
    quad_sharing_price?: number | null;
    child_price?: number | null;
    infant_price?: number | null;
  };
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
  /** Currency staff enter costs in (CMS Basics). Storefront converts via daily FX. */
  cms_costing_currency?: string;
  market_audience?: TourMarketAudience;
  /** Multi-select storefronts (india / australia / global). */
  storefronts?: Array<'india' | 'australia' | 'global'>;
  pricing_usd?: TourMarketPricing;
  pricing_aud?: TourMarketPricing;
  /** Per-departure USD overrides (key = city|start_date). Group tours with scheduled departures. */
  departure_pricing_usd?: Record<string, TourMarketPricing>;
  departure_usd_manual?: string[];
  /** CMS multi-destination links (city/state/country). */
  destination_ids?: number[];
  pricing_model?: TourPricingModel;
  group_pax_slabs?: GroupPaxSlab[];
  group_pax_tiers?: GroupPaxCollectionTier[];
  group_pax_default_tier_id?: string;
  group_pax_min_adults?: number;
  tour_highlights?: Array<{ title: string; icon?: string; icon_url?: string }>;
  tour_summary_itinerary?: {
    header?: string;
    days: Array<{
      day: number;
      slots: Array<{
        period: 'morning' | 'noon_evening' | 'full_day' | 'leisure';
        title: string;
        description?: string;
        image_url?: string;
      }>;
    }>;
  };
  tour_faqs?: Array<{ question: string; answer: string }>;
};

export function parseTourCmsMeta(raw: string | null | undefined): TourCmsMeta {
  return splitOverviewWithMeta(raw).meta as TourCmsMeta;
}

export function defaultTaxPercentsForMarket(marketCountry: string): { gst: number; tds: number } {
  if (marketCountry === 'in') return { gst: 5, tds: 2 };
  return { gst: 0, tds: 0 };
}

/** GST / TCS (stored as tds_percent in CMS) — only when explicitly set on the tour and > 0. */
export function tourTaxPercentsFromMeta(
  meta: Pick<TourCmsMeta, 'gst_percent' | 'tds_percent'>
): { gst: number; tcs: number } {
  const gst =
    meta.gst_percent != null &&
    Number.isFinite(Number(meta.gst_percent)) &&
    Number(meta.gst_percent) > 0
      ? Number(meta.gst_percent)
      : 0;
  const tcs =
    meta.tds_percent != null &&
    Number.isFinite(Number(meta.tds_percent)) &&
    Number(meta.tds_percent) > 0
      ? Number(meta.tds_percent)
      : 0;
  return { gst, tcs };
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
