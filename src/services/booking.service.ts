import { supabase } from '../lib/supabase';
import { parseTourCmsMeta, resolveListingTourType } from '../lib/tour-meta';
import { loadActiveSidebarBadgeMap, resolvePromoBadgeLabel } from '../lib/sidebar-badge';
import { lookupDeparturePricingUsd } from '../lib/departure-pricing-key';
import {
  bookingTotalWithFlightOption,
  countPayingTravellers,
  tourFlightCostPerPerson,
} from '../lib/tour-flights';
import { childPricesFromDb, childPricesToDb } from '../lib/tour-price-db';
import {
  computeBookingTotalInr,
  inferDiscountPercent,
  twinSharingDisplayPrice,
  twinSharingRateNote,
  type RoomPricingInput,
  type TourPriceSheet,
} from '../lib/tour-pricing';
import { enqueueCrmBookingSync } from '../jobs/crm.job';
import { env } from '../config/env';
import {
  chargeCurrencyForAccount,
  getRazorpayClient,
  getRazorpayKeyId,
  chargeAmountMinorUnits,
  type RazorpayAccount,
  razorpayAccountConfigured,
  resolveRazorpayAccountForCurrency,
  resolveWebhookAccount,
  verifyPaymentSignature,
} from '../lib/razorpay-accounts';
import crypto from 'node:crypto';
import {resolveIso2FromCountryHint} from '../lib/country-name-to-iso2';
import { destinationSlugVariants, normalizeDestinationSlug } from '../lib/destination-slug';
import {
  isTourListedPublicly,
  parseTourVisibility,
  type TourVisibilityStatus,
} from '../lib/tour-visibility';
import {
  globalUsdDisplayFromInr,
  inrPerUsd,
  resolveGlobalUsdPrice,
  readGlobalPricingFromMeta,
  tourVisibleForMarket,
  type TourMarketPricing,
} from '../lib/tour-market-audience';
import { foreignAmountToInr, STATIC_RATES_TO_INR } from '../lib/fx-rates-to-inr';
import type { TourCmsMeta } from '../lib/tour-meta';

export type TravellerInput = {
  type: 'adult' | 'child' | 'infant';
  salutation: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  pan?: string;
};

export type CreateBookingInput = {
  tour_id: number;
  /** Omitted for flexible / open-date tours without scheduled departures. */
  departure_id?: number | null;
  adults: number;
  children: number;
  infants: number;
  /** Optional: stored when `bookings.rooms` / `bookings.room_details` exist (for CRM payment notes). */
  rooms?: number;
  room_details?: Array<{
    adults: number;
    children: number;
    child_ages?: number[];
    sharing_type?: 'single' | 'twin' | 'triple' | 'quad';
    stranger_slots?: number;
    billing_units?: number;
    selected_seat_ids?: string[];
  }>;
  occupancy_notes?: string;
  /** Optional: ISO 4217 code (INR/USD/AED/AUD) the customer saw on the booking page. */
  display_currency?: string;
  /** Optional: INR-base FX rate (units of `display_currency` per 1 INR) snapshot at booking time. */
  display_fx_rate?: number;
  /** Optional: auth.users id when the booking is placed by a signed-in customer (P2). */
  user_id?: string;
  travellers: TravellerInput[];
  manual_cost_summary?: {
    currency: 'INR';
    single: { per_adult: number; adults: number; children: Array<{ age: number; price: number }> };
    double: { per_adult: number; adults: number; children: Array<{ age: number; price: number }> };
    triple: { per_adult: number; adults: number; children: Array<{ age: number; price: number }> };
    quad: { per_adult: number; adults: number; children: Array<{ age: number; price: number }> };
  } | null;
  /** When false, per-person flight supplement is deducted from total (tour meta `flight_cost_inr`). */
  include_flight?: boolean;
};

/** Server-side fallback INR → market rates (used when client didn't snapshot a rate). Keep in sync with `madura-web/src/config/market.ts`. */
const SERVER_INR_FX_FALLBACK: Record<string, number> = {
  INR: 1,
  USD: 83,
  AED: 22.6,
  AUD: 54,
};

/**
 * Format an INR amount with an optional secondary local-currency conversion.
 * Returns `"INR 1,76,999"` when the customer's market is INR/unknown,
 * or `"INR 1,76,999 (≈ AED 7,832)"` when a non-INR display currency is on the booking.
 */
function formatInrDual(
  amountInInr: number,
  displayCurrency: string | null | undefined,
  displayFxRate: number | null | undefined
): string {
  const safeAmount = Number.isFinite(amountInInr) ? amountInInr : 0;
  const inrPart = `INR ${Number(safeAmount || 0).toLocaleString('en-IN')}`;
  const cur = String(displayCurrency || '').toUpperCase().trim();
  if (!cur || cur === 'INR' || safeAmount <= 0) return inrPart;
  const rateRaw = Number(displayFxRate);
  const rate = rateRaw > 0 ? rateRaw : SERVER_INR_FX_FALLBACK[cur] || 0;
  if (!rate) return inrPart;
  const converted = safeAmount / rate;
  let display: string;
  if (cur === 'USD') {
    const usd = globalUsdDisplayFromInr(safeAmount, rate);
    display = `$${usd.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }
  else if (cur === 'AED') display = `AED ${converted.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  else if (cur === 'AUD') display = `AUD ${converted.toLocaleString('en-AU', { maximumFractionDigits: 0 })}`;
  else display = `${cur} ${converted.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  return `${inrPart} (≈ ${display})`;
}

export type CreateBookingPaymentOrderInput = {
  booking_id: number;
};

export type VerifyBookingPaymentInput = {
  booking_id: number;
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
  purpose?: 'advance' | 'balance';
};

export type UpdateBookingPaymentStatusInput = {
  booking_id: number;
  payment_status: 'cancelled' | 'failed' | 'pending';
  reason?: string;
  razorpay_order_id?: string;
  razorpay_payment_id?: string;
};

export type CreateEnquiryInput = {
  tour_id: number;
  departure_id?: number | null;
  name: string;
  phone: string;
  email?: string | null;
  departure_city: string;
  travel_date: string;
  destination?: string;
  duration?: string;
  adults: number;
  children: number;
  infants: number;
  rooms: number;
  room_details?: Array<{
    adults: number;
    children: number;
    child_ages?: number[];
    sharing_type?: 'single' | 'twin' | 'triple' | 'quad';
    stranger_slots?: number;
    billing_units?: number;
    selected_seat_ids?: string[];
  }>;
  occupancy_notes?: string;
  tour_title?: string;
  page_url?: string;
  enquiry_type?: string | null;
  /** CRM `lead_source_enum` value (defaults to website). */
  source?: string | null;
  /** CRM services array (defaults from enquiry_type). */
  services?: string[] | null;
  /** MICE lead fields (CRM Leads → MICE Details). */
  event_type?: string | null;
  event_date?: string | null;
  venue_location?: string | null;
  mice_requirements?: string | null;
  attendees?: number;
  tour_region?: string | null;
  budget?: string | number | null;
  is_flexible_dates?: boolean;
  return_date?: string | null;
  nationality?: string | null;
  ip_address?: string;
  user_agent?: string;
  forex_currency_have?: string | null;
  forex_currency_required?: string | null;
  /** Optional: auth.users id when the enquiry is filed by a signed-in customer (P2). */
  user_id?: string;
};

export type CreateWebsiteLeadInput = {
  name: string;
  phone: string;
  destination: string;
  tour_id?: number;
  email?: string | null;
  travel_date?: string | null;
  nationality?: string | null;
  enquiry_type?: string | null;
  /** CRM `services` array (e.g. `['MICE', 'Visa']`). */
  services?: string[] | null;
  adults?: number;
  event_type?: string | null;
  event_date?: string | null;
  venue_location?: string | null;
  mice_requirements?: string | null;
  message?: string | null;
  page_url?: string | null;
  market?: string | null;
  ip_address?: string;
  user_agent?: string;
  forex_mode?: 'buy' | 'sell' | null;
  forex_currency_have?: string | null;
  forex_currency_required?: string | null;
  forex_amount?: number | null;
};

export type CreatePlannerLeadInput = {
  destinations: string;
  when_mode: 'specific' | 'flexible';
  travel_date?: string | null;
  travel_end_date?: string | null;
  flexible_month?: number | null;
  flexible_year?: number | null;
  budget_tier_id?: string | null;
  budget_tier_label?: string | null;
  market?: string | null;
  rooms: Array<{ adults: number; children: number; child_ages?: number[]; childAges?: number[] }>;
  page_url?: string | null;
  user_id: string;
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  ip_address?: string;
  user_agent?: string;
};

const enquiryIpRateMap = new Map<string, number[]>();
const enquiryPhoneRateMap = new Map<string, number[]>();
const plannerLeadDedupeMap = new Map<string, number>();
const ENQUIRY_RATE_WINDOW_MS = 10 * 60 * 1000; // 10 min
const PLANNER_LEAD_DEDUPE_WINDOW_MS = 30 * 60 * 1000; // 30 min
const ENQUIRY_IP_RATE_MAX = 12;
const ENQUIRY_PHONE_RATE_MAX = 5;
type AdvanceRegion = 'domestic' | 'sea_middle_east' | 'international';

const ADVANCE_AMOUNTS: Record<'INR' | 'USD' | 'AUD', Record<AdvanceRegion, number>> = {
  INR: { domestic: 1000, sea_middle_east: 3000, international: 5000 },
  USD: { domestic: 15, sea_middle_east: 40, international: 60 },
  AUD: { domestic: 20, sea_middle_east: 50, international: 90 },
};

const seaAndMiddleEastDestinations = new Set(
  [
    'uae',
    'dubai',
    'abu dhabi',
    'qatar',
    'oman',
    'bahrain',
    'kuwait',
    'saudi arabia',
    'singapore',
    'malaysia',
    'thailand',
    'indonesia',
    'vietnam',
    'cambodia',
    'laos',
    'myanmar',
    'philippines',
    'sri lanka',
    'maldives',
  ].map((item) => item.toLowerCase())
);

/** One CRM payment-event per booking+gateway payment (verify + webhook often run together). */
const bookingPaymentCrmSyncInflight = new Map<string, Promise<unknown>>();

function normalizeText(value: string | null | undefined) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function resolveTourRegionFromData(tourRegion: string, destination: string, continent: string) {
  const region = normalizeText(tourRegion);
  const destinationName = normalizeText(destination);
  const continentName = normalizeText(continent);

  if (region.includes('domestic') || destinationName === 'india') {
    return 'domestic' as const;
  }
  if (
    region.includes('sea') ||
    region.includes('middle east') ||
    seaAndMiddleEastDestinations.has(destinationName) ||
    continentName === 'asia'
  ) {
    return 'sea_middle_east' as const;
  }
  return 'international' as const;
}

function getAdvanceAmountForCurrency(
  resolvedRegion: AdvanceRegion,
  currency: 'INR' | 'USD' | 'AUD'
): number {
  const table = ADVANCE_AMOUNTS[currency];
  if (resolvedRegion === 'domestic') return table.domestic;
  if (resolvedRegion === 'sea_middle_east') return table.sea_middle_east;
  return table.international;
}

function marketCountryForDisplayCurrency(currency: string): string {
  const c = String(currency || 'INR').toUpperCase().trim();
  if (c === 'INR') return 'in';
  if (c === 'AUD') return 'au';
  return 'us';
}

function priceSheetFromMarketBands(
  bands: ReturnType<typeof resolveMarketPriceBands>
): TourPriceSheet {
  return {
    twin_sharing_price: bands.twin,
    triple_sharing_price: bands.triple,
    single_sharing_price: bands.single,
    quad_sharing_price: bands.quad,
    infant_price: bands.infant,
    child_price: bands.child,
    youth_price: bands.youth,
  };
}

function tourPriceSheetForCurrency(
  row: {
    twin_sharing_price?: number | null;
    triple_sharing_price?: number | null;
    single_sharing_price?: number | null;
    quad_sharing_price?: number | null;
    infant_price?: number | null;
    child_price?: number | null;
    youth_price?: number | null;
  },
  cmsMeta: TourCmsMeta,
  currency: string
): TourPriceSheet {
  const cur = String(currency || 'INR').toUpperCase().trim() || 'INR';
  if (cur === 'INR') {
    return {
      twin_sharing_price: row.twin_sharing_price,
      triple_sharing_price: row.triple_sharing_price,
      single_sharing_price: row.single_sharing_price,
      quad_sharing_price: row.quad_sharing_price,
      ...childPricesFromDb(row),
    };
  }
  return priceSheetFromMarketBands(
    resolveMarketPriceBands(row, cmsMeta, marketCountryForDisplayCurrency(cur))
  );
}

function formatBookingAmount(amount: number, displayCurrency: string | null | undefined): string {
  const safe = Number.isFinite(amount) ? amount : 0;
  const cur = String(displayCurrency || 'INR').toUpperCase().trim() || 'INR';
  if (cur === 'INR') return `INR ${Number(safe || 0).toLocaleString('en-IN')}`;
  if (cur === 'AUD') {
    return `AUD ${Number(safe || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (cur === 'USD') {
    return `$${Number(safe || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }
  return `${cur} ${Number(safe || 0).toLocaleString('en-US')}`;
}

function chargeCurrencyForBooking(_displayCurrency: string | null | undefined, razorpayAccount: RazorpayAccount): 'INR' | 'AUD' {
  return razorpayAccount === 'au' ? 'AUD' : 'INR';
}

async function upsertBookingPaymentFields(bookingId: number, fields: Record<string, unknown>) {
  const tryKeys = [fields, Object.fromEntries(Object.entries(fields).filter(([k]) => k !== 'payment_notes'))];
  for (const payload of tryKeys) {
    const { error } = await supabase.from('bookings').update(payload).eq('id', bookingId);
    if (!error) return;
    if (!/column .* does not exist/i.test(String(error.message || ''))) {
      throw new Error(`Failed to update booking payment fields: ${error.message}`);
    }
  }
}

/** What the CRM `/api/booking/payment-event` route sends back to us. */
export type CrmPaymentEventResult = {
  lead_id: number | null;
  mts_id: string | null;
};

async function syncBookingPaymentToCrm(input: {
  booking_id: number;
  payment_status: string;
  amount: number;
  amount_slab?: number;
  full_amount?: number;
  remaining_amount?: number;
  payment_currency?: string;
  destination?: string;
  tour_title?: string;
  travel_date?: string;
  return_date?: string;
  duration?: string;
  starting_point?: string;
  tour_region?: string;
  departure_city?: string;
  razorpay_order_id?: string;
  razorpay_payment_id?: string;
  razorpay_bank_rrn?: string;
  razorpay_description?: string;
  paid_at?: string;
  /** ISO 4217 currency the customer saw on the booking page (e.g. AED). */
  display_currency?: string | null;
  /** INR-base FX rate snapshot (units of `display_currency` per 1 INR). */
  display_fx_rate?: number | null;
  details_note: string;
  customer_phone?: string;
  customer_email?: string;
  customer_name?: string;
  travellers?: Array<{
    traveller_type?: string | null;
    salutation?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    email?: string | null;
    child_age?: number | null;
  }>;
  room_details?: Array<{ adults?: number; children?: number; child_ages?: number[] }> | null;
}): Promise<CrmPaymentEventResult | null> {
  const base = String(env.CRM_API_URL || '').replace(/\/$/, '');
  if (!base) return null;

  const lockKey = [
    input.booking_id,
    String(input.payment_status || '').toLowerCase(),
    String(input.razorpay_payment_id || input.razorpay_order_id || '').trim() || 'no-gateway-ref',
  ].join(':');
  const inflight = bookingPaymentCrmSyncInflight.get(lockKey) as Promise<CrmPaymentEventResult | null> | undefined;
  if (inflight) {
    return await inflight;
  }

  const run = (async () => {
    // eslint-disable-next-line no-console
    console.info('[payment-crm-sync] started', {
      booking_id: input.booking_id,
      payment_status: input.payment_status,
      destination: input.destination || null,
    });
    const response = await fetch(`${base}/api/booking/payment-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        booking_id: input.booking_id,
        payment_status: input.payment_status,
        amount: input.amount,
        amount_slab: input.amount_slab,
        full_amount: input.full_amount,
        remaining_amount: input.remaining_amount,
        payment_currency: input.payment_currency || 'INR',
        destination: input.destination,
        tour_title: input.tour_title,
        travel_date: input.travel_date,
        return_date: input.return_date,
        duration: input.duration,
        starting_point: input.starting_point || input.departure_city,
        tour_region: input.tour_region,
        departure_city: input.departure_city,
        razorpay_order_id: input.razorpay_order_id,
        razorpay_payment_id: input.razorpay_payment_id,
        razorpay_bank_rrn: input.razorpay_bank_rrn,
        razorpay_description: input.razorpay_description,
        paid_at: input.paid_at,
        display_currency: input.display_currency || undefined,
        display_fx_rate: input.display_fx_rate || undefined,
        customer_phone: input.customer_phone,
        customer_email: input.customer_email,
        customer_name: input.customer_name,
        travellers: input.travellers,
        room_details: input.room_details,
        note: input.details_note,
      }),
    });
    if (response.ok) {
      const payload = (await response.json().catch(() => ({}))) as {
        lead_id?: number | null;
        mts_id?: string | null;
        message?: string;
      };
      const result: CrmPaymentEventResult = {
        lead_id: payload?.lead_id ?? null,
        mts_id: payload?.mts_id ?? null,
      };
      // eslint-disable-next-line no-console
      console.info('[payment-crm-sync] success via /api/booking/payment-event', {
        booking_id: input.booking_id,
        payment_status: input.payment_status,
        lead_id: result.lead_id,
        mts_id: result.mts_id,
      });
      return result;
    }

    const text = await response.text().catch(() => '');
    // eslint-disable-next-line no-console
    console.warn('[payment-crm-sync] primary endpoint failed, trying fallback /api/lead/website', {
      status: response.status,
      body: text,
    });

    const fallbackResp = await fetch(`${base}/api/lead/website`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: input.customer_name || 'Website Customer',
        phone: input.customer_phone || '',
        email: input.customer_email || undefined,
        destination: input.destination || undefined,
        date_of_travel: input.travel_date || new Date().toISOString().slice(0, 10),
        date: input.travel_date || new Date().toISOString().slice(0, 10),
        travel_date: input.travel_date || new Date().toISOString().slice(0, 10),
        return_date: input.return_date || undefined,
        duration: input.duration || undefined,
        enquiry: 'Tour Package',
        source: 'website',
        notes: [
          {
            type: 'note',
            content: input.details_note,
            timestamp: new Date().toISOString(),
          },
        ],
        summary: `Booking payment update | status=${input.payment_status} | booking=${input.booking_id} | amount=${input.amount}`,
        starting_point: input.starting_point || input.departure_city || undefined,
        tour_region: input.tour_region || undefined,
      }),
    });

    if (!fallbackResp.ok) {
      const fallbackText = await fallbackResp.text().catch(() => '');
      throw new Error(`CRM booking payment sync failed: ${fallbackResp.status} ${fallbackText}`.trim());
    }
    const fallbackPayload = (await fallbackResp.json().catch(() => ({}))) as {
      lead_id?: number | null;
      mts_id?: string | null;
    };
    // eslint-disable-next-line no-console
    console.info('[payment-crm-sync] success via fallback /api/lead/website', {
      booking_id: input.booking_id,
      payment_status: input.payment_status,
      lead_id: fallbackPayload?.lead_id ?? null,
      mts_id: fallbackPayload?.mts_id ?? null,
    });
    return {
      lead_id: fallbackPayload?.lead_id ?? null,
      mts_id: fallbackPayload?.mts_id ?? null,
    };
  })();

  bookingPaymentCrmSyncInflight.set(lockKey, run as Promise<unknown>);
  try {
    return await run;
  } finally {
    if (bookingPaymentCrmSyncInflight.get(lockKey) === (run as unknown)) {
      bookingPaymentCrmSyncInflight.delete(lockKey);
    }
  }
}

async function createBookingTransaction(input: {
  booking_id: number;
  payment_status: string;
  amount: number;
  currency: string;
  payment_order_id?: string;
  payment_id?: string;
  note?: string;
}) {
  const payload = {
    booking_id: input.booking_id,
    transaction_type: 'payment',
    payment_status: input.payment_status,
    amount: Number(input.amount || 0),
    currency: input.currency || 'INR',
    payment_order_id: input.payment_order_id || null,
    payment_id: input.payment_id || null,
    gateway: 'razorpay',
    note: input.note || null,
  };
  const { error } = await supabase.from('booking_transactions').insert(payload);
  if (!error) return;
  if (/relation .* does not exist/i.test(String(error.message || ''))) {
    // eslint-disable-next-line no-console
    console.warn('[booking-transaction] table missing, skipping insert');
    return;
  }
  throw new Error(`Failed to create booking transaction: ${error.message}`);
}

async function getSuccessfulBookingTransactionTotal(bookingId: number): Promise<number | null> {
  const { data, error } = await supabase
    .from('booking_transactions')
    .select('amount,payment_status')
    .eq('booking_id', bookingId);
  if (error) {
    if (/relation .* does not exist/i.test(String(error.message || ''))) return null;
    // eslint-disable-next-line no-console
    console.warn('[booking-transaction] total lookup failed:', error.message);
    return null;
  }
  return (data || []).reduce((sum, row) => {
    const status = String((row as { payment_status?: string | null }).payment_status || '').toLowerCase();
    if (!['success', 'paid', 'captured'].some((key) => status.includes(key))) return sum;
    return sum + Number((row as { amount?: number | null }).amount || 0);
  }, 0);
}

async function getPaidAmountForBooking(booking: { id: number; payment_amount?: number | null }) {
  const bookingPaid = Number(booking.payment_amount || 0);
  const transactionPaid = await getSuccessfulBookingTransactionTotal(booking.id);
  return Math.max(bookingPaid, Number(transactionPaid || 0));
}

export type DestinationListItem = {
  id: number;
  name: string;
  /** Display line: "City, Country" or country/region name only */
  label: string;
  /** ISO 3166-1 alpha-2 fallback when no `flag_image_url` */
  flag_iso: string | null;
  /** Optional absolute URL for flag art in Supabase (PNG/JPEG/GIF…) */
  flag_image_url?: string | null;
};

type DestinationListRawRow = {
  id: number;
  name: string;
  destination_type?: string | null;
  parent_id?: number | null;
  country_region?: string | null;
  /** Explicit ISO 3166-1 alpha-2 on website destinations (preferred for flags). */
  flag_iso?: string | null;
  /** Direct flag asset URL stored in Website Supabase */
  flag_image_url?: string | null;
};
type DepartureCityRow = { name: string };
type DestinationShowcaseRow = {
  id: number;
  name: string;
  slug?: string | null;
  destination_type?: string | null;
  parent_id?: number | null;
  continent?: string | null;
  /** Website Supabase often uses this */
  image_url?: string | null;
  /** CRM-style column when present */
  cover_image_url?: string | null;
};
type TourRow = {
  id: number;
  title: string;
  flow_type: 'enquiry' | 'booking' | 'both';
  destination?: string | null;
  destination_ref?: { name?: string | null } | null;
};
type DepartureRow = {
  id: number;
  tour_id: number;
  city?: string | null;
  start_date: string;
  end_date: string;
  price: number;
  twin_sharing_price?: number | null;
  triple_sharing_price?: number | null;
  single_sharing_price?: number | null;
  quad_sharing_price?: number | null;
  infant_price?: number | null;
  child_price?: number | null;
  youth_price?: number | null;
  max_travellers?: number | null;
  departure_city?: { name?: string | null } | null;
};

function mapDepartureApiRow(row: DepartureRow) {
  const legacy = Number(row.price) || 0;
  const twin = Number(row.twin_sharing_price) || legacy || 0;
  const bands = childPricesFromDb(row);
  return {
    id: row.id,
    tour_id: row.tour_id,
    city: row.departure_city?.name || row.city || 'Unknown',
    start_date: row.start_date,
    end_date: row.end_date,
    price: twin,
    twin_sharing_price: twin,
    triple_sharing_price: row.triple_sharing_price ?? null,
    single_sharing_price: row.single_sharing_price ?? null,
    quad_sharing_price: row.quad_sharing_price ?? null,
    infant_price: bands.infant_price ?? null,
    child_price: bands.child_price ?? null,
    youth_price: bands.youth_price ?? null,
    max_travellers: row.max_travellers ?? null,
  };
}

type DepartureApiRow = ReturnType<typeof mapDepartureApiRow>;

function mapDepartureForMarket(
  row: DepartureRow,
  marketCountry: string,
  departureUsdById: Record<string, import('../lib/tour-market-audience').TourMarketPricing> | undefined
): DepartureApiRow & {
  display_currency?: 'INR' | 'USD';
  twin_sharing_price_inr?: number;
  triple_sharing_price_inr?: number | null;
  single_sharing_price_inr?: number | null;
  quad_sharing_price_inr?: number | null;
  infant_price_inr?: number | null;
  child_price_inr?: number | null;
  youth_price_inr?: number | null;
} {
  const base = mapDepartureApiRow(row);
  const isGlobal = marketCountry.toLowerCase() !== 'in';
  if (!isGlobal) return base;

  const depUsd = lookupDeparturePricingUsd(departureUsdById, {
    id: row.id,
    city: row.departure_city?.name || row.city,
    start_date: row.start_date,
  });
  const pick = (
    inr: number | null | undefined,
    keys: Array<keyof import('../lib/tour-market-audience').TourMarketPricing>
  ) => {
    for (const key of keys) {
      const stored = depUsd?.[key];
      if (stored != null && Number(stored) > 0) {
        return resolveGlobalUsdPrice(inr, Number(stored));
      }
    }
    return null;
  };

  const twinInr = base.twin_sharing_price ?? base.price;
  const twinUsd = pick(twinInr, ['twin_sharing_price', 'price_from']) ?? 0;

  return {
    ...base,
    display_currency: 'USD',
    twin_sharing_price_inr: twinInr,
    triple_sharing_price_inr: base.triple_sharing_price,
    single_sharing_price_inr: base.single_sharing_price,
    quad_sharing_price_inr: base.quad_sharing_price,
    infant_price_inr: base.infant_price,
    child_price_inr: base.child_price,
    youth_price_inr: base.youth_price,
    twin_sharing_price: twinUsd,
    price: twinUsd,
    triple_sharing_price: pick(base.triple_sharing_price, ['triple_sharing_price']),
    single_sharing_price: pick(base.single_sharing_price, ['single_sharing_price']),
    quad_sharing_price: pick(base.quad_sharing_price, ['quad_sharing_price']),
    infant_price: pick(base.infant_price, ['infant_price']),
    child_price: pick(base.child_price, ['child_price']),
    youth_price: pick(base.youth_price, ['youth_price']),
  };
}

function mergePriceSheet(departure: TourPriceSheet, tour: TourPriceSheet): TourPriceSheet {
  const d = departure;
  const t = tour;
  return {
    twin_sharing_price: d.twin_sharing_price || d.price || t.twin_sharing_price,
    triple_sharing_price: d.triple_sharing_price ?? t.triple_sharing_price,
    single_sharing_price: d.single_sharing_price ?? t.single_sharing_price,
    quad_sharing_price: d.quad_sharing_price ?? t.quad_sharing_price,
    ...childPricesFromDb({
      infant_price: d.infant_price ?? t.infant_price,
      child_price: d.child_price ?? t.child_price,
      youth_price: d.youth_price ?? t.youth_price,
    }),
    price: d.price || d.twin_sharing_price || t.twin_sharing_price,
  };
}

type ListingTourRow = {
  id: number;
  title: string;
  slug?: string | null;
  visibility_status?: string | null;
  is_active?: boolean | null;
  flow_type: 'enquiry' | 'booking' | 'both';
  destination?: string | null;
  tour_includes?: string[] | null;
  hero_image_url?: string | null;
  gallery_image_urls?: string[] | null;
  duration_days?: number | null;
  twin_sharing_price?: number | null;
  triple_sharing_price?: number | null;
  single_sharing_price?: number | null;
  quad_sharing_price?: number | null;
  infant_price?: number | null;
  child_price?: number | null;
  youth_price?: number | null;
  destination_ref?: {
    name?: string | null;
    slug?: string | null;
    image_url?: string | null;
    cover_image_url?: string | null;
  } | null;
  departures?: Array<{
    id?: number;
    price?: number | null;
    twin_sharing_price?: number | null;
    triple_sharing_price?: number | null;
    single_sharing_price?: number | null;
    quad_sharing_price?: number | null;
    start_date?: string | null;
    end_date?: string | null;
    city?: string | null;
    departure_city?: { name?: string | null } | null;
  }> | null;
};

function destinationKind(row: DestinationListRawRow): 'city' | 'country' | 'continent' | 'other' {
  const raw = row.destination_type;
  if (raw == null || String(raw).trim() === '') {
    return 'other';
  }
  const t = String(raw).toLowerCase().trim();
  if (t === 'city') return 'city';
  if (t === 'country') return 'country';
  if (t === 'continent') return 'continent';
  return 'other';
}

/** Broad regions (not individual countries) — hidden from searchable "where to go". */
function isExcludedMacroRegion(name: string): boolean {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return false;
  const exclusions = new Set([
    'africa',
    'asia',
    'europe',
    'antarctica',
    'oceania',
    'north america',
    'south america',
    'latin america',
    'middle east',
    'arab world',
    'caribbean',
    'central america',
    'scandinavia',
    'balkans',
    'south east asia',
    'southeast asia',
  ]);
  return exclusions.has(key);
}

function resolveParentCountryRow(
  row: DestinationListRawRow,
  byId: Map<number, DestinationListRawRow>,
): DestinationListRawRow | null {
  let current: DestinationListRawRow | undefined = row;
  const seen = new Set<number>();
  while (current?.parent_id != null && !seen.has(Number(current.id))) {
    seen.add(Number(current.id));
    const parent = byId.get(Number(current.parent_id));
    if (!parent) {
      return null;
    }
    if (destinationKind(parent) === 'country') {
      return parent;
    }
    current = parent;
  }
  return null;
}

function normalizeFlagIsoStored(value: unknown): string | null {
  const t = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (t.length === 2 && /^[a-z]{2}$/.test(t)) return t;
  return null;
}

function normalizeHttpImageUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return t;
  } catch {
    return null;
  }
}

function buildDestinationListItems(rows: DestinationListRawRow[]): DestinationListItem[] {
  const byId = new Map<number, DestinationListRawRow>();
  for (const r of rows) {
    byId.set(Number(r.id), r);
  }

  const items: DestinationListItem[] = [];
  for (const r of rows) {
    const kind = destinationKind(r);
    if (kind === 'continent') {
      continue;
    }

    let label = String(r.name || '').trim();
    if (isExcludedMacroRegion(label)) {
      continue;
    }

    let flagHint = r.country_region ? String(r.country_region).trim() : '';

    /** City + untyped rows: attach country when known ("City, Country"). Countries stay single-line. */
    if (kind === 'city' || kind === 'other') {
      const parentCountry = resolveParentCountryRow(r, byId);
      const countryLabel = parentCountry?.name?.trim()
        ? parentCountry.name.trim()
        : r.country_region
          ? String(r.country_region).trim()
          : '';
      if (countryLabel && countryLabel.toLowerCase() !== label.toLowerCase()) {
        label = `${label}, ${countryLabel}`;
      }
      flagHint = parentCountry?.name?.trim()
        ? parentCountry.name.trim()
        : flagHint || countryLabel || (label.includes(',') ? label.split(',').pop()!.trim() : label);
    } else if (kind === 'country') {
      flagHint = flagHint || label;
    }

    const countryPartComma = label.includes(',') ? label.slice(label.lastIndexOf(',') + 1).trim() : '';

    const flag_iso =
      normalizeFlagIsoStored(r.flag_iso) ||
      resolveIso2FromCountryHint(flagHint) ||
      resolveIso2FromCountryHint(r.country_region ? String(r.country_region) : null) ||
      resolveIso2FromCountryHint(countryPartComma) ||
      resolveIso2FromCountryHint(label);

    items.push({
      id: Number(r.id),
      name: String(r.name || '').trim(),
      label,
      flag_iso,
      flag_image_url: normalizeHttpImageUrl(r.flag_image_url),
    });
  }

  items.sort((a, b) => a.label.localeCompare(b.label));
  return items;
}

export async function getDestinations(): Promise<DestinationListItem[]> {
  const fullAttempts = [
    'id,name,destination_type,parent_id,country_region,flag_iso,flag_image_url',
    'id,name,destination_type,parent_id,country_region,flag_iso',
    'id,name,destination_type,parent_id,country_region',
    'id,name,flag_iso,flag_image_url',
    'id,name,flag_iso',
    'id,name,flag_image_url',
    'id,name',
  ];

  let lastErr = '';
  for (const cols of fullAttempts) {
    const full = await supabase.from('destinations').select(cols).order('name', { ascending: true });
    if (!full.error && full.data) {
      const rows = full.data as unknown as DestinationListRawRow[];
      if (cols.includes('destination_type')) {
        return buildDestinationListItems(rows);
      }
      return rows.map((row) => {
        const name = String(row.name || '').trim();
        const flagImg = normalizeHttpImageUrl(row.flag_image_url);
        return {
          id: Number(row.id),
          name,
          label: name,
          flag_iso:
            normalizeFlagIsoStored(row.flag_iso) ||
            resolveIso2FromCountryHint(name),
          flag_image_url: flagImg,
        };
      });
    }
    lastErr = String(full.error?.message || '');
  }

  throw new Error(`Failed to fetch destinations: ${lastErr}`);
}

function parseDestinationPageMeta(description: string | null | undefined): {
  tagline: string | null;
  banner_image_url: string | null;
  default_view_mode: 'list' | 'grid';
  body: string;
  description_in: string;
  description_au: string;
} {
  const text = String(description || '').trim();
  const re = /^<!--dest-meta:([\s\S]*?)-->\s*/;
  const match = text.match(re);
  if (!match) {
    return {
      tagline: null,
      banner_image_url: null,
      default_view_mode: 'grid',
      body: text,
      description_in: text,
      description_au: text,
    };
  }
  try {
    const meta = JSON.parse(match[1]) as {
      tagline?: string;
      banner_image_url?: string;
      default_view_mode?: 'list' | 'grid';
      description_in?: string;
      description_au?: string;
    };
    const legacyBody = text.slice(match[0].length).trim();
    const description_in = String(meta.description_in || '').trim() || legacyBody;
    const description_au =
      String(meta.description_au || '').trim() ||
      String(meta.description_in || '').trim() ||
      legacyBody;
    return {
      tagline: meta.tagline?.trim() || null,
      banner_image_url: meta.banner_image_url?.trim() || null,
      default_view_mode: meta.default_view_mode === 'list' ? 'list' : 'grid',
      body: legacyBody || description_in,
      description_in,
      description_au,
    };
  } catch {
    return {
      tagline: null,
      banner_image_url: null,
      default_view_mode: 'grid',
      body: text,
      description_in: text,
      description_au: text,
    };
  }
}

type DestinationSlugRow = {
  id: number;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  image_url?: string | null;
  cover_image_url?: string | null;
  flag_image_url?: string | null;
  is_active?: boolean | null;
};

function isDestinationSlugRow(data: unknown): data is DestinationSlugRow {
  return (
    typeof data === 'object' &&
    data !== null &&
    'id' in data &&
    typeof (data as { id: unknown }).id === 'number'
  );
}

export async function getDestinationBySlug(slug: string) {
  const normalized = normalizeDestinationSlug(slug);
  if (!normalized) return null;

  const slugVariants = destinationSlugVariants(slug);
  const selectTries = [
    'id,name,slug,description,image_url,cover_image_url,flag_image_url,flag_iso,is_active',
    'id,name,slug,description,image_url,cover_image_url,flag_image_url,is_active',
    'id,name,slug,description,image_url,cover_image_url,flag_image_url,flag_iso',
    'id,name,slug,description,image_url,cover_image_url,flag_image_url',
    'id,name,slug,description,cover_image_url,flag_image_url',
    'id,name,slug,description,image_url,cover_image_url',
    'id,name,slug,description',
    'id,name,slug,cover_image_url,image_url',
    'id,name,slug',
  ];

  let lastErr = '';
  for (const cols of selectTries) {
    for (const variant of slugVariants) {
      const { data, error } = await supabase.from('destinations').select(cols).eq('slug', variant).maybeSingle();
      if (!error && isDestinationSlugRow(data)) {
        const row = data;
        if (row.is_active === false) return null;
        const pageMeta = parseDestinationPageMeta(row.description);
        return {
          id: Number(row.id),
          name: String(row.name || '').trim(),
          slug: normalizeDestinationSlug(String(row.slug || normalized)),
          tagline: pageMeta.tagline,
          banner_image_url:
            pageMeta.banner_image_url ||
            row.cover_image_url ||
            row.image_url ||
            null,
          flag_image_url: row.flag_image_url?.trim() || null,
          flag_iso:
            normalizeFlagIsoStored((row as { flag_iso?: string | null }).flag_iso) ||
            resolveIso2FromCountryHint(String(row.name || '')),
          default_view_mode: pageMeta.default_view_mode,
          description: String(row.description || '').trim(),
          description_in: pageMeta.description_in,
          description_au: pageMeta.description_au,
        };
      }
      lastErr = String(error?.message || '');
      if (lastErr && !/column .* does not exist/i.test(lastErr)) break;
    }
    if (lastErr && !/column .* does not exist/i.test(lastErr)) break;
  }
  return null;
}

export async function getDepartureCities() {
  const { data, error } = await supabase
    .from('departure_cities')
    .select('name')
    .order('name', { ascending: true });

  if (!error) {
    return ((data || []) as DepartureCityRow[]).map((row) => row.name).filter(Boolean);
  }

  const { data: fallback, error: fallbackError } = await supabase
    .from('departures')
    .select('city')
    .order('city', { ascending: true });

  if (fallbackError) {
    throw new Error(`Failed to fetch departure cities: ${fallbackError.message}`);
  }

  return Array.from(
    new Set(
      (fallback || [])
        .map((row: { city?: string | null }) => String(row.city || '').trim())
        .filter(Boolean)
    )
  );
}

export async function getHeroSearchOptions() {
  const [destinations, departureFrom] = await Promise.all([getDestinations(), getDepartureCities()]);
  const dedupedDepartureFrom = Array.from(new Set(departureFrom)).sort((a, b) => a.localeCompare(b));
  return {
    departureFrom: dedupedDepartureFrom,
    goingTo: destinations.map((d) => d.name),
  };
}

async function fetchDestinationRowsForShowcase(): Promise<DestinationShowcaseRow[]> {
  const tries = [
    'id,name,slug,destination_type,parent_id,continent,image_url,cover_image_url',
    'id,name,slug,destination_type,parent_id,continent,image_url',
    'id,name,slug,destination_type,parent_id,continent,cover_image_url',
    'id,name,slug,destination_type,parent_id,continent',
    'id,name,slug,image_url',
    'id,name,slug',
  ];
  let lastError = '';
  for (const cols of tries) {
    const { data, error } = await supabase.from('destinations').select(cols).order('name', { ascending: true });
    if (!error) {
      return ((data || []) as unknown) as DestinationShowcaseRow[];
    }
    lastError = String(error.message || '');
  }
  throw new Error(`Failed to fetch destinations for showcase: ${lastError}`);
}

async function fetchShowcaseTourRows() {
  const tries = [
    'id,destination_id,destination,title,visibility_status',
    'id,destination_id,destination,title',
  ];
  let lastErr = '';
  for (const cols of tries) {
    const attempt = await supabase.from('tours').select(cols);
    if (!attempt.error) return attempt.data || [];
    lastErr = String(attempt.error.message || '');
    if (!/column .* does not exist/i.test(lastErr)) break;
  }
  throw new Error(`Failed to fetch tours for showcase: ${lastErr || 'Unknown error'}`);
}

export async function getDestinationShowcase() {
  const [allDestinations, toursRaw, departuresRes] = await Promise.all([
    fetchDestinationRowsForShowcase(),
    fetchShowcaseTourRows(),
    supabase.from('departures').select('tour_id,price'),
  ]);

  const departuresError = departuresRes.error;
  if (departuresError) {
    throw new Error(`Failed to fetch departures for showcase: ${departuresError.message}`);
  }

  const tours = (toursRaw as unknown as Array<{
    id: number;
    destination_id?: number | null;
    destination?: string | null;
    visibility_status?: string | null;
    is_active?: boolean | null;
  }>).filter((t) => isTourListedPublicly(parseTourVisibility(t)));
  const departures = (departuresRes.data || []) as Array<{ tour_id: number; price: number }>;

  const destinationById = new Map<number, DestinationShowcaseRow>();
  const destinationByName = new Map<string, DestinationShowcaseRow>();
  for (const d of allDestinations) {
    destinationById.set(Number(d.id), d);
    destinationByName.set(String(d.name), d);
  }

  const minPriceByTourId = new Map<number, number>();
  for (const dep of departures || []) {
    const tourId = Number((dep as { tour_id: number }).tour_id);
    const price = Number((dep as { price: number }).price);
    if (!Number.isFinite(tourId) || !Number.isFinite(price)) continue;
    const existing = minPriceByTourId.get(tourId);
    if (existing === undefined || price < existing) minPriceByTourId.set(tourId, price);
  }

  const minPriceByDestinationId = new Map<number, number>();
  for (const t of tours || []) {
    const destinationIdRaw = (t as { destination_id?: number | null; destination?: string | null }).destination_id;
    let destinationId = destinationIdRaw ? Number(destinationIdRaw) : NaN;
    if (!Number.isFinite(destinationId)) {
      const fallbackName = String((t as { destination?: string | null }).destination || '');
      const fallbackDestination = destinationByName.get(fallbackName);
      destinationId = fallbackDestination ? Number(fallbackDestination.id) : NaN;
    }
    if (!Number.isFinite(destinationId)) continue;

    const minTourPrice = minPriceByTourId.get(Number((t as { id: number }).id));
    if (minTourPrice === undefined) continue;
    const existing = minPriceByDestinationId.get(destinationId);
    if (existing === undefined || minTourPrice < existing) minPriceByDestinationId.set(destinationId, minTourPrice);
  }

  const cards = allDestinations
    .filter((d) => (d.destination_type || 'country') !== 'continent')
    .map((d) => {
      const parent = d.parent_id ? destinationById.get(Number(d.parent_id)) : undefined;
      const continent =
        d.continent ||
        (parent?.destination_type === 'continent' ? parent.name : parent?.continent) ||
        'Other';
      return {
        id: Number(d.id),
        name: d.name,
        slug: normalizeDestinationSlug(
          String(d.slug || d.name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-'))
        ),
        continent,
        image_url:
          d.image_url ||
          d.cover_image_url ||
          'https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&w=900&q=80',
        starting_from: minPriceByDestinationId.get(Number(d.id)) ?? null,
      };
    });

  const grouped = cards.reduce<Record<string, typeof cards>>((acc, item) => {
    const key = item.continent || 'Other';
    if (!acc[key]) acc[key] = [];
    acc[key].push(item);
    return acc;
  }, {});

  return Object.entries(grouped)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([continent, items]) => ({
      continent,
      destinations: items.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

export async function getTours() {
  const selectTries = [
    'id,title,flow_type,visibility_status,destination,destination_ref:destinations(name)',
    'id,title,flow_type,destination,destination_ref:destinations(name)',
  ];
  let data: TourRow[] | null = null;
  let error: { message: string } | null = null;
  for (const sel of selectTries) {
    const attempt = await supabase.from('tours').select(sel).order('title', { ascending: true });
    if (!attempt.error) {
      data = (attempt.data || []) as unknown as TourRow[];
      error = null;
      break;
    }
    error = attempt.error;
    if (!/column .* does not exist/i.test(String(attempt.error.message || ''))) break;
  }

  if (error && !String(error.message || '').includes('destinations')) {
    throw new Error(`Failed to fetch tours: ${error.message}`);
  }

  const rows = ((data || []) as (TourRow & { visibility_status?: string | null; is_active?: boolean | null })[])
    .filter((row) => isTourListedPublicly(parseTourVisibility(row)))
    .map((row) => ({
      id: row.id,
      title: row.title,
      flow_type: row.flow_type,
      destination: row.destination_ref?.name || row.destination || 'Unknown',
    }));

  rows.sort((a, b) => a.destination.localeCompare(b.destination) || a.title.localeCompare(b.title));
  return rows;
}

function toSlug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-');
}

function inferCategory(title: string): 'Family' | 'Honeymoon' | 'Friends' | 'Group Tour' {
  const lower = title.toLowerCase();
  if (lower.includes('honeymoon') || lower.includes('couple')) return 'Honeymoon';
  if (lower.includes('family')) return 'Family';
  if (lower.includes('friends') || lower.includes('group')) return 'Friends';
  return 'Group Tour';
}

function inferTheme(title: string): 'Adventure' | 'Culture' {
  const lower = title.toLowerCase();
  if (lower.includes('adventure') || lower.includes('trek') || lower.includes('safari')) return 'Adventure';
  return 'Culture';
}

/** CRM-published tours: INR in CRM → INR on site; AUD/USD/etc. → USD on site. */
function crmStorefrontUsesUsd(cmsMeta: TourCmsMeta): boolean {
  const src = String(cmsMeta.crm_source_currency || '').toUpperCase().trim();
  if (src) return src !== 'INR';
  if (crmMetaHasCrmItinerary(cmsMeta) && cmsMeta.market_audience === 'global') return true;
  return false;
}

export function resolveStorefrontPricingCurrency(cmsMeta: TourCmsMeta): 'INR' | 'USD' | 'AUD' {
  const src = String(cmsMeta.crm_source_currency || '').toUpperCase().trim();
  if (crmMetaHasCrmItinerary(cmsMeta)) {
    if (src === 'INR') return 'INR';
    if (src === 'AUD') return 'AUD';
    if (src) return 'USD';
  }
  if (crmStorefrontUsesUsd(cmsMeta)) return 'USD';
  if (cmsMeta.market_audience === 'global') return 'USD';
  return 'INR';
}

function crmDisplayBandsFromMeta(
  cmsMeta: TourCmsMeta,
  row: {
    twin_sharing_price?: number | null;
    triple_sharing_price?: number | null;
    single_sharing_price?: number | null;
    quad_sharing_price?: number | null;
    infant_price?: number | null;
    child_price?: number | null;
    youth_price?: number | null;
  }
) {
  const snap = cmsMeta.crm_costing_snapshot;
  const dp = cmsMeta.crm_display_prices as
    | {
        twin_sharing_price?: number | null;
        triple_sharing_price?: number | null;
        single_sharing_price?: number | null;
        quad_sharing_price?: number | null;
        child_price?: number | null;
        infant_price?: number | null;
      }
    | undefined;
  const pick = (key: keyof NonNullable<typeof dp>): number | null => {
    const fromDisplay = Number(dp?.[key]);
    if (Number.isFinite(fromDisplay) && fromDisplay > 0) return fromDisplay;
    if (key === 'twin_sharing_price') {
      const per = Number(snap?.per_person);
      if (Number.isFinite(per) && per > 0) return per;
    }
    return null;
  };
  const bands = childPricesFromDb(row);
  return {
    twin: pick('twin_sharing_price'),
    triple: pick('triple_sharing_price'),
    single: pick('single_sharing_price'),
    quad: pick('quad_sharing_price'),
    infant: pick('infant_price') ?? bands.infant_price,
    child: pick('child_price') ?? bands.child_price,
    youth: bands.youth_price,
    displayUsd: false,
  };
}

function usdFromInrColumn(inr: number | null | undefined): number | null {
  const n = Number(inr);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n / inrPerUsd());
}

/** Legacy tours sometimes stored INR values inside `pricing_usd` — detect and recompute. */
function saneStoredUsd(
  storedUsd: number | null | undefined,
  inrColumn: number | null | undefined
): number | null {
  const stored = Number(storedUsd);
  const inr = Number(inrColumn);
  if (Number.isFinite(stored) && stored > 0) {
    if (Number.isFinite(inr) && inr > 0 && stored >= inr * 0.85) {
      return usdFromInrColumn(inr);
    }
    if ((!Number.isFinite(inr) || inr <= 0) && stored >= 15000) {
      return usdFromInrColumn(stored);
    }
    return Math.round(stored);
  }
  return usdFromInrColumn(inrColumn);
}

function twinUsdFromCrmDisplayMeta(
  cmsMeta: TourCmsMeta,
  inrPerUsdRate: number
): number | null {
  const raw = cmsMeta.crm_display_prices as
    | { currency?: string; twin_sharing_price?: number | null }
    | undefined;
  const amount = Number(raw?.twin_sharing_price);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const currency = String(raw?.currency || cmsMeta.crm_source_currency || 'INR')
    .toUpperCase()
    .trim();
  if (currency === 'INR') return Math.round(amount);
  const inr = foreignAmountToInr(amount, currency, STATIC_RATES_TO_INR);
  if (!inr) return null;
  return Math.round(inr / inrPerUsdRate);
}

function pickUsdBand(
  inr: number | null | undefined,
  storedUsd: number | null | undefined
): number | null {
  return saneStoredUsd(storedUsd, inr);
}

function resolveMarketPriceBands(
  row: {
    twin_sharing_price?: number | null;
    triple_sharing_price?: number | null;
    single_sharing_price?: number | null;
    quad_sharing_price?: number | null;
    infant_price?: number | null;
    child_price?: number | null;
    youth_price?: number | null;
  },
  cmsMeta: TourCmsMeta,
  marketCountry: string
) {
  const bands = childPricesFromDb(row);
  const isGlobalMarket = marketCountry.toLowerCase() !== 'in';
  const crmSrc = String(cmsMeta.crm_source_currency || '').toUpperCase().trim();
  if (crmMetaHasCrmItinerary(cmsMeta) && crmSrc === 'AUD') {
    return crmDisplayBandsFromMeta(cmsMeta, row);
  }
  const crmUsd = crmStorefrontUsesUsd(cmsMeta);

  if (crmUsd) {
    const stored = readGlobalPricingFromMeta(cmsMeta);
    const rate = inrPerUsd();
    const fromCrmDisplay = twinUsdFromCrmDisplayMeta(cmsMeta, rate);
    return {
      twin:
        fromCrmDisplay ??
        pickUsdBand(row.twin_sharing_price, stored?.twin_sharing_price ?? stored?.price_from),
      triple: pickUsdBand(row.triple_sharing_price, stored?.triple_sharing_price),
      single: pickUsdBand(row.single_sharing_price, stored?.single_sharing_price),
      quad: pickUsdBand(row.quad_sharing_price, stored?.quad_sharing_price),
      infant: pickUsdBand(bands.infant_price, stored?.infant_price),
      child: pickUsdBand(bands.child_price, stored?.child_price),
      youth: pickUsdBand(bands.youth_price, stored?.youth_price),
      displayUsd: true,
    };
  }

  if (crmMetaHasCrmItinerary(cmsMeta) && cmsMeta.market_audience === 'india') {
    return {
      twin: row.twin_sharing_price,
      triple: row.triple_sharing_price,
      single: row.single_sharing_price,
      quad: row.quad_sharing_price,
      infant: bands.infant_price,
      child: bands.child_price,
      youth: bands.youth_price,
      displayUsd: false,
    };
  }

  if (crmMetaHasCrmItinerary(cmsMeta) && cmsMeta.market_audience === 'global') {
    const stored = readGlobalPricingFromMeta(cmsMeta);
    const rate = inrPerUsd();
    const fromCrmDisplay = twinUsdFromCrmDisplayMeta(cmsMeta, rate);
    return {
      twin:
        fromCrmDisplay ??
        pickUsdBand(row.twin_sharing_price, stored?.twin_sharing_price ?? stored?.price_from),
      triple: pickUsdBand(row.triple_sharing_price, stored?.triple_sharing_price),
      single: pickUsdBand(row.single_sharing_price, stored?.single_sharing_price),
      quad: pickUsdBand(row.quad_sharing_price, stored?.quad_sharing_price),
      infant: pickUsdBand(bands.infant_price, stored?.infant_price),
      child: pickUsdBand(bands.child_price, stored?.child_price),
      youth: pickUsdBand(bands.youth_price, stored?.youth_price),
      displayUsd: true,
    };
  }

  if (!isGlobalMarket) {
    return {
      twin: row.twin_sharing_price,
      triple: row.triple_sharing_price,
      single: row.single_sharing_price,
      quad: row.quad_sharing_price,
      infant: bands.infant_price,
      child: bands.child_price,
      youth: bands.youth_price,
      displayUsd: false,
    };
  }

  const stored = readGlobalPricingFromMeta(cmsMeta);
  const pick = (_inr: number | null | undefined, usd?: number | null | undefined) => {
    if (usd != null && usd > 0) return usd;
    return null;
  };

  return {
    twin: pick(row.twin_sharing_price, stored?.twin_sharing_price ?? stored?.price_from),
    triple: pick(row.triple_sharing_price, stored?.triple_sharing_price),
    single: pick(row.single_sharing_price, stored?.single_sharing_price),
    quad: pick(row.quad_sharing_price, stored?.quad_sharing_price),
    infant: pick(bands.infant_price, stored?.infant_price),
    child: pick(bands.child_price, stored?.child_price),
    youth: pick(bands.youth_price, stored?.youth_price),
    displayUsd: true,
  };
}

function crmMetaHasCrmItinerary(cmsMeta: TourCmsMeta): boolean {
  return Number(cmsMeta.crm_itinerary_id) > 0;
}

/** Group tours: “from” price = lowest departure (matches tour detail), not tour-level USD only. */
function lowestStartingTwinFromDepartures(
  departures: NonNullable<ListingTourRow['departures']>,
  cmsMeta: TourCmsMeta,
  marketCountry: string,
  discountPercent: number | null
): number | null {
  const depUsd = cmsMeta.departure_pricing_usd || {};
  const isGlobal = marketCountry.toLowerCase() !== 'in';
  const candidates: number[] = [];

  for (const dep of departures) {
    const twinInr = Number(dep.twin_sharing_price ?? dep.price) || 0;
    if (twinInr <= 0) continue;

    const stored = lookupDeparturePricingUsd(depUsd, {
      id: dep.id,
      city: dep.city ?? dep.departure_city?.name,
      start_date: dep.start_date,
    });

    const twinUsd = isGlobal
      ? resolveGlobalUsdPrice(twinInr, stored?.twin_sharing_price ?? stored?.price_from)
      : twinInr;
    const display = twinSharingDisplayPrice({ twin_sharing_price: twinUsd }, discountPercent);
    if (display > 0) candidates.push(display);
  }

  return candidates.length ? Math.min(...candidates) : null;
}

function discountedDisplay(value: number | null | undefined, discountPercent: number | null): number | null {
  const n = Number(value) || 0;
  if (n <= 0) return null;
  if (discountPercent && discountPercent > 0) {
    return Math.max(1, Math.round(n * (1 - discountPercent / 100)));
  }
  return Math.round(n);
}

function selectLowestAdultRate(
  sheet: TourPriceSheet,
  discountPercent: number | null,
  departureTwinDisplay?: number | null
): { value: number | null; note: string | null } {
  const candidates: Array<{ value: number; note: string }> = [];
  const push = (value: number | null, note: string) => {
    if (value && value > 0) candidates.push({ value, note });
  };

  push(discountedDisplay(sheet.single_sharing_price, discountPercent), 'Single sharing rate');
  push(discountedDisplay(sheet.twin_sharing_price, discountPercent), 'Twin sharing rate');
  push(discountedDisplay(sheet.triple_sharing_price, discountPercent), 'Triple sharing rate');
  push(discountedDisplay(sheet.quad_sharing_price, discountPercent), 'Quad sharing rate');
  push(discountedDisplay(departureTwinDisplay, null), 'Twin sharing rate');

  if (!candidates.length) return { value: null, note: null };
  const best = candidates.reduce((min, row) => (row.value < min.value ? row : min), candidates[0]);
  return best;
}

export async function getToursListing(marketCountry = 'in') {
  let data: ListingTourRow[] | null = null;
  let error: { message: string } | null = null;

  const baseTries = [
    'id,title,slug,flow_type,visibility_status,destination,tour_includes,hero_image_url,gallery_image_urls,duration_days,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,discounted_price,overview',
    'id,title,slug,flow_type,destination,tour_includes,hero_image_url,gallery_image_urls,duration_days,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,discounted_price,overview',
    'id,title,slug,flow_type,visibility_status,destination,tour_includes,hero_image_url,duration_days,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,discounted_price,overview',
    'id,title,slug,flow_type,destination,tour_includes,hero_image_url,duration_days,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,discounted_price,overview',
    'id,title,flow_type,destination,tour_includes,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,overview',
    'id,title,flow_type,destination,tour_includes,twin_sharing_price,triple_sharing_price,single_sharing_price,infant_price,child_price,youth_price',
    'id,title,flow_type,destination,tour_includes,twin_sharing_price,triple_sharing_price,single_sharing_price,child_price,youth_price',
  ];
  const departuresPart =
    'departures(id,price,twin_sharing_price,triple_sharing_price,single_sharing_price,start_date,end_date,city,departure_city:departure_cities(name))';
  const destinationEmbedTries = [
    'destination_ref:destinations(name,slug,image_url)',
    'destination_ref:destinations(name,slug)',
  ];

  outer: for (const base of baseTries) {
    for (const embed of destinationEmbedTries) {
      const sel = `${base},${embed},${departuresPart}`;
      const attempt = await supabase.from('tours').select(sel).order('title', { ascending: true });
      if (!attempt.error) {
        data = ((attempt.data || []) as unknown) as ListingTourRow[];
        error = null;
        break outer;
      }
      error = attempt.error;
      if (!/column .* does not exist/i.test(String(attempt.error.message || ''))) {
        break outer;
      }
    }
  }

  if (error) {
    throw new Error(`Failed to fetch tours listing: ${error.message}`);
  }

  const rows = ((data || []) as ListingTourRow[])
    .filter((row) => isTourListedPublicly(parseTourVisibility(row)))
    .filter((row) => {
      const meta = parseTourCmsMeta((row as { overview?: string | null }).overview);
      if (crmMetaHasCrmItinerary(meta)) return true;
      return tourVisibleForMarket(meta.market_audience, marketCountry);
    });
  const sidebarBadgeMap = await loadActiveSidebarBadgeMap();
  return rows.map((row) => {
    const departures = Array.isArray(row.departures) ? row.departures : [];
    const prices = departures
      .map((d) => Number(d.price))
      .filter((price) => Number.isFinite(price) && price > 0);
    const startEndPair = departures.find((d) => d.start_date && d.end_date);
    let durationNights = 0;
    if (startEndPair?.start_date && startEndPair?.end_date) {
      const start = new Date(startEndPair.start_date);
      const end = new Date(startEndPair.end_date);
      const diffMs = end.getTime() - start.getTime();
      durationNights = Math.max(1, Math.round(diffMs / (1000 * 60 * 60 * 24)));
    } else if (row.duration_days && row.duration_days > 0) {
      durationNights = Math.max(1, row.duration_days - 1);
    } else {
      durationNights = 3 + (row.id % 5);
    }

    const derivedTwin = prices.length ? Math.min(...prices) : null;
    const cmsMeta = parseTourCmsMeta((row as { overview?: string | null }).overview);
    const marketBands = resolveMarketPriceBands(row, cmsMeta, marketCountry);
    const discountPercent = inferDiscountPercent(
      marketBands.twin ?? row.twin_sharing_price,
      (row as { discounted_price?: number | null }).discounted_price,
      cmsMeta.discount_percent
    );
    const crmUsdListing = resolveStorefrontPricingCurrency(cmsMeta) === 'USD';
    const listingSheet: TourPriceSheet = {
      twin_sharing_price: marketBands.twin ?? (crmUsdListing ? null : derivedTwin),
      triple_sharing_price: marketBands.triple,
      single_sharing_price: marketBands.single,
      quad_sharing_price: marketBands.quad,
      infant_price: marketBands.infant,
      child_price: marketBands.child,
      youth_price: marketBands.youth,
      price: marketBands.twin ?? (crmUsdListing ? null : derivedTwin),
    };
    const bandPrices = childPricesFromDb(row);
    const fromDepartures =
      departures.length > 0
        ? lowestStartingTwinFromDepartures(departures, cmsMeta, marketCountry, discountPercent)
        : null;
    const isGlobalListing = marketCountry.toLowerCase() !== 'in';
    const lowestAdult = selectLowestAdultRate(listingSheet, discountPercent, fromDepartures);
    const startingTwin = crmUsdListing
      ? marketBands.twin ?? lowestAdult.value ?? null
      : isGlobalListing
        ? lowestAdult.value
        : lowestAdult.value || row.twin_sharing_price || derivedTwin;
    const startingTriple =
      marketBands.triple ?? row.triple_sharing_price ?? (startingTwin ? Math.round(startingTwin * 0.9) : null);
    const startingSingle = marketBands.single ?? row.single_sharing_price ?? null;
    const startingQuad = marketBands.quad ?? row.quad_sharing_price ?? null;
    const startingInfant = marketBands.infant ?? bandPrices.infant_price ?? null;
    const startingChild = marketBands.child ?? bandPrices.child_price ?? null;
    const startingYouth = marketBands.youth ?? bandPrices.youth_price ?? null;
    const destination = row.destination_ref?.name || row.destination || 'Unknown';
    const heroImage = String(row.hero_image_url || '').trim();
    const gallery = Array.isArray(row.gallery_image_urls)
      ? row.gallery_image_urls.map((u) => String(u || '').trim()).filter(Boolean)
      : [];
    const departureCities = Array.from(
      new Set(
        departures
          .map((d) => String(d.departure_city?.name || d.city || '').trim())
          .filter(Boolean)
      )
    );

    return {
      id: row.id,
      title: row.title,
      slug: row.slug || null,
      flow_type: row.flow_type,
      destination,
      destination_slug: row.destination_ref?.slug || toSlug(destination),
      image_url:
        heroImage ||
        gallery[0] ||
        row.destination_ref?.image_url ||
        'https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&w=900&q=80',
      hero_image_url: heroImage || null,
      gallery_image_urls: gallery,
      duration_nights: durationNights,
      tour_category: inferCategory(row.title),
      theme: inferTheme(row.title),
      tour_type: resolveListingTourType(cmsMeta, row.flow_type),
      promo_badge: resolvePromoBadgeLabel(cmsMeta, sidebarBadgeMap),
      starting_from_twin: startingTwin,
      starting_from_triple: startingTriple,
      starting_from_single: startingSingle,
      starting_from_quad: startingQuad,
      starting_from_infant: startingInfant,
      starting_from_child: startingChild,
      starting_from_youth: startingYouth,
      departure_cities: departureCities,
      tour_includes: Array.isArray(row.tour_includes) ? row.tour_includes : [],
    };
  });
}

export async function getToursListingByIds(tourIds: number[], marketCountry = 'in') {
  const ids = [...new Set(tourIds.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) return [];
  const listing = await getToursListing(marketCountry);
  const byId = new Map(listing.map((item) => [item.id, item]));
  return ids.map((id) => byId.get(id)).filter((item): item is NonNullable<typeof item> => Boolean(item));
}

export type TourItineraryDay = {
  day: string;
  title: string;
  details: string;
};

export type TourDetail = {
  id: number;
  title: string;
  slug: string | null;
  destination: string;
  destination_slug: string;
  flow_type: 'enquiry' | 'booking' | 'both';
  image_url: string;
  hero_image_url: string | null;
  gallery_image_urls: string[];
  duration_nights: number;
  duration_days: number | null;
  tour_category: 'Family' | 'Honeymoon' | 'Friends' | 'Group Tour';
  theme: 'Adventure' | 'Culture';
  tour_type: string;
  promo_badge?: string | null;
  starting_from_twin: number | null;
  starting_from_triple: number | null;
  starting_from_single: number | null;
  starting_from_quad: number | null;
  starting_from_infant: number | null;
  starting_from_child: number | null;
  starting_from_youth: number | null;
  starting_from_twin_inr?: number | null;
  starting_from_triple_inr?: number | null;
  starting_from_single_inr?: number | null;
  starting_from_quad_inr?: number | null;
  starting_from_infant_inr?: number | null;
  starting_from_child_inr?: number | null;
  starting_from_youth_inr?: number | null;
  /** Caption for `starting_from_twin` (e.g. "Twin sharing rate"). */
  starting_from_sharing_note?: string | null;
  sales_price: number | null;
  discounted_price: number | null;
  discount_percent: number | null;
  departure_cities: string[];
  tour_includes: string[];
  tour_exclusions: string[];
  overview: string | null;
  itinerary_days: TourItineraryDay[];
  max_travellers: number | null;
  min_age: number | null;
  starting_city: string | null;
  visibility_status: TourVisibilityStatus;
  /** CRM-published: INR, AUD (native CRM currency), or USD on storefronts. */
  storefront_pricing_currency?: 'INR' | 'USD' | 'AUD';
  /** Fixed CRM trip total in `crm_display_currency` (unlisted / quote tours). */
  crm_display_total?: number | null;
  crm_display_per_person?: number | null;
  crm_display_currency?: string | null;
  crm_display_adults?: number | null;
};

export async function getTourBySlug(slug: string, marketCountry = 'in'): Promise<TourDetail | null> {
  const normalized = slug.trim().toLowerCase();
  if (!normalized) return null;

  const idTries = ['id,slug', 'id'];
  let tourId: number | null = null;
  for (const cols of idTries) {
    const attempt = await supabase.from('tours').select(cols).eq('slug', normalized).maybeSingle();
    if (!attempt.error && attempt.data) {
      tourId = Number((attempt.data as unknown as { id: number }).id);
      if (Number.isFinite(tourId) && tourId > 0) break;
    }
    if (attempt.error && !/column .* does not exist/i.test(String(attempt.error.message || ''))) {
      break;
    }
  }
  if (!tourId) return null;
  return getTourById(tourId, marketCountry);
}

export async function getTourByKey(key: string, marketCountry = 'in'): Promise<TourDetail | null> {
  const trimmed = decodeURIComponent(key).trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    return getTourById(Number(trimmed), marketCountry);
  }
  return getTourBySlug(trimmed, marketCountry);
}

export async function getTourById(tourId: number, marketCountry = 'in'): Promise<TourDetail | null> {
  const departuresPart =
    'departures(id,price,twin_sharing_price,triple_sharing_price,single_sharing_price,start_date,end_date,city,departure_city:departure_cities(name))';
  const destinationEmbedTries = [
    'destination_ref:destinations(name,slug,image_url)',
    'destination_ref:destinations(name,slug)',
  ];
  const baseTries = [
    'id,title,slug,flow_type,visibility_status,destination,destination_id,tour_region,tour_includes,tour_exclusions,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,sales_price,discounted_price,duration_days,max_travellers,min_age,starting_city,hero_image_url,gallery_image_urls,overview,itinerary_days',
    'id,title,slug,flow_type,destination,destination_id,tour_region,tour_includes,tour_exclusions,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,sales_price,discounted_price,duration_days,max_travellers,min_age,starting_city,hero_image_url,gallery_image_urls,overview,itinerary_days',
    'id,title,flow_type,destination,destination_id,tour_region,tour_includes,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price',
    'id,title,flow_type,destination,destination_id,tour_region,tour_includes,twin_sharing_price,triple_sharing_price,single_sharing_price,child_price,youth_price',
  ];

  type DetailRow = ListingTourRow & {
    slug?: string | null;
    tour_exclusions?: string[] | null;
    sales_price?: number | null;
    discounted_price?: number | null;
    duration_days?: number | null;
    max_travellers?: number | null;
    min_age?: number | null;
    starting_city?: string | null;
    hero_image_url?: string | null;
    gallery_image_urls?: string[] | null;
    overview?: string | null;
    itinerary_days?: TourItineraryDay[] | null;
  };

  let row: DetailRow | null = null;
  let lastError: { message: string } | null = null;

  outer: for (const base of baseTries) {
    for (const embed of destinationEmbedTries) {
      const sel = `${base},${embed},${departuresPart}`;
      const attempt = await supabase.from('tours').select(sel).eq('id', tourId).maybeSingle();
      if (!attempt.error && attempt.data) {
        row = attempt.data as unknown as DetailRow;
        break outer;
      }
      lastError = attempt.error;
      if (attempt.error && !/column .* does not exist/i.test(String(attempt.error.message || ''))) {
        throw new Error(`Failed to fetch tour: ${attempt.error.message}`);
      }
    }
  }

  if (!row) return null;

  const visibility = parseTourVisibility(row as ListingTourRow);
  if (visibility === 'inactive') return null;

  const departures = Array.isArray(row.departures) ? row.departures : [];
  const prices = departures
    .map((d) => Number(d.price))
    .filter((price) => Number.isFinite(price) && price > 0);
  const startEndPair = departures.find((d) => d.start_date && d.end_date);
  let durationNights = 0;
  if (startEndPair?.start_date && startEndPair?.end_date) {
    const start = new Date(startEndPair.start_date);
    const end = new Date(startEndPair.end_date);
    const diffMs = end.getTime() - start.getTime();
    durationNights = Math.max(1, Math.round(diffMs / (1000 * 60 * 60 * 24)));
  } else if (row.duration_days && row.duration_days > 0) {
    durationNights = Math.max(1, row.duration_days - 1);
  } else {
    durationNights = 8;
  }

  const derivedTwin = prices.length ? Math.min(...prices) : null;
  const cmsMeta = parseTourCmsMeta(row.overview);
  if (!crmMetaHasCrmItinerary(cmsMeta) && !tourVisibleForMarket(cmsMeta.market_audience, marketCountry)) {
    return null;
  }
  const sidebarBadgeMap = await loadActiveSidebarBadgeMap();
  const marketBands = resolveMarketPriceBands(row, cmsMeta, marketCountry);
  const storefrontCurrency = resolveStorefrontPricingCurrency(cmsMeta);
  const crmUsdStorefront = storefrontCurrency === 'USD';
  const crmSnap = cmsMeta.crm_costing_snapshot;
  const discountPercent = inferDiscountPercent(
    marketBands.twin ?? row.twin_sharing_price,
    row.discounted_price,
    cmsMeta.discount_percent
  );
  const detailSheet: TourPriceSheet = {
    twin_sharing_price: marketBands.twin ?? (crmUsdStorefront ? null : derivedTwin),
    triple_sharing_price: marketBands.triple,
    single_sharing_price: marketBands.single,
    quad_sharing_price: marketBands.quad,
    infant_price: marketBands.infant,
    child_price: marketBands.child,
    youth_price: marketBands.youth,
    price: marketBands.twin ?? (crmUsdStorefront ? null : derivedTwin),
  };
  const isGlobalDetail = marketCountry.toLowerCase() !== 'in';
  const fromDepartureUsd = departures.length
    ? lowestStartingTwinFromDepartures(departures, cmsMeta, marketCountry, discountPercent)
    : null;
  const lowestAdult = selectLowestAdultRate(detailSheet, discountPercent, fromDepartureUsd);
  const tourTwinDisplay = twinSharingDisplayPrice(detailSheet, discountPercent);
  const startingTwin = crmUsdStorefront
    ? marketBands.twin ?? lowestAdult.value ?? null
    : isGlobalDetail
      ? lowestAdult.value
      : lowestAdult.value ||
        tourTwinDisplay ||
        row.twin_sharing_price ||
        row.discounted_price ||
        derivedTwin;
  const startingSharingNote = lowestAdult.note ?? twinSharingRateNote(detailSheet);
  const detailBand = childPricesFromDb(row);
  const destination = row.destination_ref?.name || row.destination || 'Unknown';
  const heroImage = String(row.hero_image_url || '').trim() || null;
  const gallery = Array.isArray(row.gallery_image_urls)
    ? row.gallery_image_urls.map((u) => String(u || '').trim()).filter(Boolean)
    : [];
  const fallbackImage =
    heroImage ||
    row.destination_ref?.image_url ||
    row.destination_ref?.cover_image_url ||
    gallery.find((url) => /\.(jpe?g|png|webp|avif)(\?|$)/i.test(url)) ||
    'https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&w=900&q=80';

  const itineraryDays = Array.isArray(row.itinerary_days)
    ? row.itinerary_days
        .map((entry) => ({
          day: String(entry?.day || '').trim(),
          title: String(entry?.title || '').trim(),
          details: String(entry?.details || '').trim(),
        }))
        .filter((entry) => entry.day && entry.title)
    : [];

  return {
    id: row.id,
    title: row.title,
    slug: row.slug || null,
    destination,
    destination_slug: row.destination_ref?.slug || toSlug(destination),
    flow_type: row.flow_type,
    image_url: fallbackImage,
    hero_image_url: heroImage,
    gallery_image_urls: gallery,
    duration_nights: durationNights,
    duration_days: row.duration_days ?? durationNights + 1,
    tour_category: inferCategory(row.title),
    theme: inferTheme(row.title),
    tour_type: resolveListingTourType(cmsMeta, row.flow_type),
    promo_badge: resolvePromoBadgeLabel(cmsMeta, sidebarBadgeMap),
    starting_from_twin: startingTwin,
    starting_from_triple:
      marketBands.triple ?? row.triple_sharing_price ?? (startingTwin ? Math.round(startingTwin * 0.9) : null),
    starting_from_single: marketBands.single ?? row.single_sharing_price ?? null,
    starting_from_quad: marketBands.quad ?? row.quad_sharing_price ?? null,
    starting_from_infant: marketBands.infant ?? detailBand.infant_price ?? null,
    starting_from_child: marketBands.child ?? detailBand.child_price ?? null,
    starting_from_youth: marketBands.youth ?? detailBand.youth_price ?? null,
    starting_from_twin_inr: row.twin_sharing_price ?? derivedTwin,
    starting_from_triple_inr: row.triple_sharing_price ?? null,
    starting_from_single_inr: row.single_sharing_price ?? null,
    starting_from_quad_inr: row.quad_sharing_price ?? null,
    starting_from_infant_inr: detailBand.infant_price ?? null,
    starting_from_child_inr: detailBand.child_price ?? null,
    starting_from_youth_inr: detailBand.youth_price ?? null,
    starting_from_sharing_note: startingSharingNote,
    sales_price: row.sales_price ?? null,
    discounted_price: row.discounted_price ?? startingTwin,
    discount_percent: discountPercent,
    departure_cities: Array.from(
      new Set(departures.map((d) => String(d.departure_city?.name || d.city || '').trim()).filter(Boolean))
    ),
    tour_includes: Array.isArray(row.tour_includes) ? row.tour_includes : [],
    tour_exclusions: Array.isArray(row.tour_exclusions) ? row.tour_exclusions : [],
    overview: row.overview || null,
    itinerary_days: itineraryDays,
    max_travellers: row.max_travellers ?? null,
    min_age: row.min_age ?? null,
    starting_city: row.starting_city || 'Sydney',
    visibility_status: visibility,
    storefront_pricing_currency: storefrontCurrency,
    crm_display_currency: crmSnap?.currency ?? cmsMeta.crm_source_currency ?? null,
    crm_display_per_person: crmSnap?.per_person ?? null,
    crm_display_total: crmSnap?.total ?? null,
    crm_display_adults: crmSnap?.adults ?? null,
  };
}

export async function getTourDepartures(tourId: number, marketCountry = 'in') {
  const tour = await getTourById(tourId, marketCountry);
  if (!tour) return null;
  const cmsMeta = parseTourCmsMeta(tour.overview);
  const departureUsdById = cmsMeta.departure_pricing_usd;
  const selectTries = [
    'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,max_travellers,departure_city:departure_cities(name)',
    'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,infant_price,child_price,youth_price,max_travellers,departure_city:departure_cities(name)',
    'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,child_price,youth_price,max_travellers,departure_city:departure_cities(name)',
    'id,tour_id,city,start_date,end_date,price,departure_city:departure_cities(name)',
  ];
  let lastErr = '';
  for (const sel of selectTries) {
    const { data, error } = await supabase
      .from('departures')
      .select(sel)
      .eq('tour_id', tourId)
      .order('start_date', { ascending: true });
    if (!error) {
      return ((data || []) as unknown as DepartureRow[]).map((row) =>
        mapDepartureForMarket(row, marketCountry, departureUsdById)
      );
    }
    lastErr = String(error.message || '');
    if (!/column .* does not exist/i.test(lastErr) && !lastErr.includes('departure_cities')) {
      throw new Error(`Failed to fetch departures: ${lastErr}`);
    }
  }
  throw new Error(`Failed to fetch departures: ${lastErr}`);
}

function validateCreateBookingPayload(input: CreateBookingInput): void {
  if (!input.tour_id) {
    throw new Error('tour_id is required.');
  }

  const adults = Number(input.adults || 0);
  const children = Number(input.children || 0);
  const infants = Number(input.infants || 0);
  const totalTravellers = adults + children + infants;

  if (totalTravellers <= 0) {
    throw new Error('At least one traveller is required.');
  }

  if (!Array.isArray(input.travellers) || input.travellers.length !== totalTravellers) {
    throw new Error('travellers count must match adults + children + infants.');
  }

  for (const [idx, traveller] of input.travellers.entries()) {
    if (
      !traveller.salutation ||
      !traveller.first_name ||
      !traveller.last_name ||
      !traveller.phone ||
      !traveller.email
    ) {
      throw new Error(`Traveller #${idx + 1} is missing required fields.`);
    }
  }
}

export async function createBooking(input: CreateBookingInput) {
  validateCreateBookingPayload(input);

  const departureId =
    input.departure_id != null && Number(input.departure_id) > 0 ? Number(input.departure_id) : null;

  const adults = Number(input.adults || 0);
  const children = Number(input.children || 0);
  const infants = Number(input.infants || 0);

  const { data: tourRow } = await supabase
    .from('tours')
    .select(
      'twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,discounted_price,overview'
    )
    .eq('id', input.tour_id)
    .maybeSingle();

  if (!tourRow) {
    throw new Error('Tour not found.');
  }

  const cmsMeta = parseTourCmsMeta((tourRow as { overview?: string | null } | null)?.overview);
  const discountPercent = inferDiscountPercent(
    (tourRow as { twin_sharing_price?: number | null } | null)?.twin_sharing_price,
    (tourRow as { discounted_price?: number | null } | null)?.discounted_price,
    cmsMeta.discount_percent
  );
  const displayCurrency =
    String(input.display_currency || '').toUpperCase().trim() ||
    resolveStorefrontPricingCurrency(cmsMeta);
  const tourSheetInr = tourPriceSheetForCurrency(
    tourRow as Parameters<typeof tourPriceSheetForCurrency>[0],
    cmsMeta,
    'INR'
  );
  const tourSheetDisplay = tourPriceSheetForCurrency(
    tourRow as Parameters<typeof tourPriceSheetForCurrency>[0],
    cmsMeta,
    displayCurrency
  );

  type BookingDepartureRow = {
    id: number;
    tour_id: number;
    price?: number | null;
    twin_sharing_price?: number | null;
    triple_sharing_price?: number | null;
    single_sharing_price?: number | null;
    quad_sharing_price?: number | null;
    infant_price?: number | null;
    child_price?: number | null;
    youth_price?: number | null;
  };

  let effectiveTourId = Number(input.tour_id);
  let depSheetDisplay = tourSheetDisplay;
  let depSheetInr = tourSheetInr;

  if (departureId) {
    const depSelectTries = [
      'id,tour_id,price,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price',
      'id,tour_id,price,twin_sharing_price,triple_sharing_price,single_sharing_price,infant_price,child_price,youth_price',
      'id,tour_id,price,twin_sharing_price,triple_sharing_price,single_sharing_price,child_price,youth_price',
      'id,tour_id,price',
    ];
    let departure: BookingDepartureRow | null = null;
    let departureError: { message?: string } | null = null;
    for (const sel of depSelectTries) {
      const res = await supabase
        .from('departures')
        .select(sel)
        .eq('id', departureId)
        .eq('tour_id', input.tour_id)
        .single();
      if (!res.error && res.data) {
        departure = res.data as unknown as BookingDepartureRow;
        departureError = null;
        break;
      }
      departureError = res.error;
      if (!/column .* does not exist/i.test(String(res.error?.message || ''))) break;
    }

    if (departureError || !departure) {
      const fallback = await supabase
        .from('departures')
        .select('id,tour_id,price')
        .eq('id', departureId)
        .single();
      if (fallback.error || !fallback.data) {
        throw new Error('Invalid departure selected for this tour.');
      }
      departure = fallback.data as unknown as BookingDepartureRow;
      // eslint-disable-next-line no-console
      console.warn('[createBooking] departure tour mismatch, using departure.tour_id', {
        requestedTourId: input.tour_id,
        departureId,
        resolvedTourId: departure?.tour_id,
      });
    }
    if (!departure) {
      throw new Error('Invalid departure selected for this tour.');
    }
    effectiveTourId = Number(departure.tour_id || input.tour_id);
    const depRow = departure as TourPriceSheet;
    depSheetInr = mergePriceSheet(depRow, tourSheetInr);
    depSheetDisplay =
      displayCurrency === 'INR'
        ? depSheetInr
        : mergePriceSheet(depRow, tourSheetDisplay);
  }
  const childAges = (input.travellers || [])
    .filter((t) => t.type === 'child')
    .map((t) => Number((t as TravellerInput & { child_age?: string }).child_age))
    .filter((a) => Number.isFinite(a));

  const pricedRooms =
    input.room_details?.map((room) => ({
      adults: Number(room.adults || 0),
      children: Number(room.children || 0),
      child_ages: room.child_ages,
      sharing_type: room.sharing_type,
      billing_units:
        room.billing_units != null && room.billing_units > 0 ? Number(room.billing_units) : undefined,
      stranger_slots:
        room.stranger_slots != null && room.stranger_slots >= 0 ? Number(room.stranger_slots) : undefined,
    })) ?? [];

  const crmSnap = cmsMeta.crm_costing_snapshot;
  const crmSnapCurrency = String(crmSnap?.currency || cmsMeta.crm_source_currency || '').toUpperCase().trim();
  const crmSnapTotal = Number(crmSnap?.total);
  let totalPrice = 0;
  if (
    crmMetaHasCrmItinerary(cmsMeta) &&
    Number.isFinite(crmSnapTotal) &&
    crmSnapTotal > 0 &&
    (!crmSnapCurrency || crmSnapCurrency === displayCurrency)
  ) {
    totalPrice = Math.round(crmSnapTotal);
  } else {
    totalPrice = computeBookingTotalInr({
      sheet: depSheetDisplay,
      discountPercent,
      room_details: pricedRooms,
      adults,
      children: children + infants,
      child_ages: childAges.length
        ? childAges
        : input.room_details?.flatMap((r) => r.child_ages || []) || [],
    });
  }

  const flightCostPerPerson = tourFlightCostPerPerson(cmsMeta.flights, cmsMeta.flight_cost_inr);
  const includeFlight = input.include_flight !== false;
  if (!includeFlight && flightCostPerPerson > 0) {
    const rooms =
      input.room_details?.length
        ? input.room_details
        : [{ adults, children: children + infants }];
    const paying = countPayingTravellers(rooms);
    totalPrice = bookingTotalWithFlightOption(totalPrice, flightCostPerPerson, false, paying);
  }

  const bookingBaseInsert: Record<string, unknown> = {
    tour_id: effectiveTourId,
    total_price: totalPrice,
    status: 'pending',
  };
  if (departureId != null) {
    bookingBaseInsert.departure_id = departureId;
  }
  if (displayCurrency && displayCurrency !== 'INR') {
    bookingBaseInsert.display_currency = displayCurrency;
  }
  const bookingBaseInsertUpperStatus = {
    ...bookingBaseInsert,
    status: 'Pending',
  };

  type BookingRow = {
    id: number;
    tour_id: number;
    departure_id: number | null;
    total_price: number;
    status: string;
  };
  let booking: BookingRow | null = null;
  let bookingError: Error | null = null;

  // Forward-compatible: save manual cost summary when column exists.
  if (input.manual_cost_summary) {
    const insertWithManualCost = await supabase
      .from('bookings')
      .insert({
        ...bookingBaseInsert,
        manual_cost_summary: input.manual_cost_summary,
      })
      .select('id,tour_id,departure_id,total_price,status,created_at')
      .single();
    booking = (insertWithManualCost.data as BookingRow | null) || null;
    bookingError = insertWithManualCost.error || null;
  }

  // Backward-compatible fallback for environments where manual_cost_summary is not added yet.
  if (!booking && bookingError && /column .*manual_cost_summary.* does not exist/i.test(String(bookingError.message || ''))) {
    bookingError = null;
  }

  if (!booking && !bookingError) {
    const baseInsert = await supabase
      .from('bookings')
      .insert(bookingBaseInsert)
      .select('id,tour_id,departure_id,total_price,status,created_at')
      .single();
    booking = (baseInsert.data as BookingRow | null) || null;
    bookingError = baseInsert.error || null;
  }

  if (
    !booking &&
    bookingError &&
    /invalid input value for enum .*status/i.test(String(bookingError.message || ''))
  ) {
    const retryInsert = await supabase
      .from('bookings')
      .insert(bookingBaseInsertUpperStatus)
      .select('id,tour_id,departure_id,total_price,status,created_at')
      .single();
    booking = (retryInsert.data as BookingRow | null) || null;
    bookingError = retryInsert.error || null;
  }

  if (bookingError || !booking) {
    const msg = String(bookingError?.message || 'Unknown error');
    if (/departure_id.*not-null/i.test(msg)) {
      throw new Error(
        `${msg} — run migrations/20250604_bookings_departure_id_nullable.sql in Supabase to allow flexible bookings without a departure.`
      );
    }
    throw new Error(`Failed to create booking: ${msg}`);
  }

  const roomPatch: Record<string, unknown> = {};
  if (Number(input.rooms) > 0) roomPatch.rooms = Number(input.rooms);
  if (Array.isArray(input.room_details) && input.room_details.length > 0) {
    roomPatch.room_details = input.room_details;
  }
  if (displayCurrency && displayCurrency !== 'INR') {
    roomPatch.display_currency = displayCurrency;
  }
  if (input.user_id) {
    roomPatch.user_id = input.user_id;
  }
  if (Object.keys(roomPatch).length > 0) {
    const tryUpdate = await supabase.from('bookings').update(roomPatch).eq('id', booking.id);
    let roomUpdateError = tryUpdate.error;
    // Forward-compatible: if optional columns don't exist yet, retry without them.
    if (
      roomUpdateError &&
      /column .*(display_currency|display_fx_rate|user_id).* does not exist/i.test(String(roomUpdateError.message || ''))
    ) {
      const slimPatch: Record<string, unknown> = { ...roomPatch };
      delete slimPatch.display_currency;
      delete slimPatch.display_fx_rate;
      delete slimPatch.user_id;
      if (Object.keys(slimPatch).length > 0) {
        const retry = await supabase.from('bookings').update(slimPatch).eq('id', booking.id);
        roomUpdateError = retry.error || null;
      } else {
        roomUpdateError = null;
      }
    }
    if (roomUpdateError && !/column .* does not exist/i.test(String(roomUpdateError.message || ''))) {
      // eslint-disable-next-line no-console
      console.warn('[createBooking] optional rooms/room_details update skipped:', roomUpdateError.message);
    }
  }

  const travellerRows = input.travellers.map((traveller) => ({
    booking_id: booking.id,
    traveller_type: traveller.type,
    salutation: traveller.salutation,
    first_name: traveller.first_name,
    last_name: traveller.last_name,
    phone: traveller.phone,
    email: traveller.email,
    pan: String(traveller.pan || ''),
  }));

  let travellerInsert = await supabase
    .from('travellers')
    .insert(travellerRows)
    .select('id,booking_id,traveller_type,salutation,first_name,last_name,phone,email,pan');
  if (travellerInsert.error && /column .*pan.* does not exist/i.test(String(travellerInsert.error.message || ''))) {
    const travellerRowsWithoutPan = travellerRows.map(({ pan, ...row }) => row);
    travellerInsert = await supabase
      .from('travellers')
      .insert(travellerRowsWithoutPan)
      .select('id,booking_id,traveller_type,salutation,first_name,last_name,phone,email');
  }
  const { data: travellers, error: travellersError } = travellerInsert;

  if (travellersError) {
    throw new Error(`Booking created but travellers insert failed: ${travellersError.message}`);
  }

  enqueueCrmBookingSync({
    bookingId: booking.id,
    tourId: booking.tour_id,
    departureId: booking.departure_id,
    totalPrice: booking.total_price,
    travellerCount: travellerRows.length,
    primaryTravellerEmail: travellers?.[0]?.email,
    primaryTravellerPhone: travellers?.[0]?.phone,
  });

  return {
    booking,
    travellers: travellers || [],
  };
}

type TravellerRowForNote = {
  traveller_type?: string | null;
  salutation?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  email?: string | null;
  pan?: string | null;
};

async function computeInrPackageTotalForBooking(booking: Record<string, unknown>): Promise<number> {
  const tourId = Number(booking.tour_id);
  const { data: tourRow } = await supabase
    .from('tours')
    .select(
      'twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,discounted_price,overview'
    )
    .eq('id', tourId)
    .maybeSingle();
  if (!tourRow) return Number(booking.total_price) || 0;

  const cmsMeta = parseTourCmsMeta((tourRow as { overview?: string | null }).overview);
  const discountPercent = inferDiscountPercent(
    (tourRow as { twin_sharing_price?: number | null }).twin_sharing_price,
    (tourRow as { discounted_price?: number | null }).discounted_price,
    cmsMeta.discount_percent
  );
  let depSheetInr = tourPriceSheetForCurrency(
    tourRow as Parameters<typeof tourPriceSheetForCurrency>[0],
    cmsMeta,
    'INR'
  );
  const departureId = Number(booking.departure_id) > 0 ? Number(booking.departure_id) : null;
  if (departureId) {
    const { data: dep } = await supabase
      .from('departures')
      .select(
        'id,tour_id,price,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price'
      )
      .eq('id', departureId)
      .maybeSingle();
    if (dep) depSheetInr = mergePriceSheet(dep as TourPriceSheet, depSheetInr);
  }

  const roomDetails = Array.isArray(booking.room_details)
    ? (booking.room_details as Array<{
        adults?: number;
        children?: number;
        child_ages?: number[];
        sharing_type?: string;
        billing_units?: number;
        stranger_slots?: number;
      }>)
    : [];
  const pricedRooms = roomDetails.map((room) => ({
    adults: Number(room.adults || 0),
    children: Number(room.children || 0),
    child_ages: room.child_ages,
    sharing_type: room.sharing_type as RoomPricingInput['sharing_type'],
    billing_units:
      room.billing_units != null && room.billing_units > 0 ? Number(room.billing_units) : undefined,
    stranger_slots:
      room.stranger_slots != null && room.stranger_slots >= 0 ? Number(room.stranger_slots) : undefined,
  }));
  const adults = pricedRooms.reduce((sum, room) => sum + Number(room.adults || 0), 0);
  const children = pricedRooms.reduce((sum, room) => sum + Number(room.children || 0), 0);

  return computeBookingTotalInr({
    sheet: depSheetInr,
    discountPercent,
    room_details: pricedRooms,
    adults,
    children,
    child_ages: pricedRooms.flatMap((r) => r.child_ages || []),
  });
}

async function packageTotalForPayment(
  context: { booking: Record<string, unknown>; displayCurrency: string | null },
  razorpayAccount: RazorpayAccount
): Promise<number> {
  const chargeCur = chargeCurrencyForBooking(context.displayCurrency, razorpayAccount);
  if (chargeCur === 'INR' && context.displayCurrency && context.displayCurrency !== 'INR') {
    return computeInrPackageTotalForBooking(context.booking);
  }
  return Number((context.booking as { total_price?: number | null }).total_price || 0);
}

async function resolvePaymentChargeAmount(
  context: Awaited<ReturnType<typeof getBookingPaymentContext>>,
  razorpayAccount: RazorpayAccount,
  purpose: 'advance' | 'balance'
): Promise<number> {
  const region = resolveTourRegionFromData(context.tourRegion, context.destination, context.continent);
  const chargeCur = chargeCurrencyForBooking(context.displayCurrency, razorpayAccount);
  const packageTotal = await packageTotalForPayment(context, razorpayAccount);
  const paid = await getPaidAmountForBooking(context.booking);
  if (purpose === 'balance') {
    return Math.max(0, Math.round(packageTotal - paid));
  }
  return getAdvanceAmountForCurrency(region, chargeCur);
}

function buildTravellersAndRoomsCrmNote(
  travellers: TravellerRowForNote[],
  rooms: number | null | undefined,
  roomDetails: Array<{
    adults?: number;
    children?: number;
    child_ages?: number[];
    sharing_type?: string;
    stranger_slots?: number;
  }> | null | undefined
): string {
  const lines: string[] = ['', 'Travellers Info:'];
  travellers.forEach((t, i) => {
    const type = String(t.traveller_type || 'adult').toLowerCase();
    const roleLabel =
      type === 'child' ? 'child' : type === 'infant' ? 'infant' : 'adult';
    lines.push(`Traveller ${i + 1} (${roleLabel})`);
    lines.push(`Salutation: ${t.salutation?.trim() || '—'}`);
    lines.push(`First Name: ${t.first_name?.trim() || '—'}`);
    lines.push(`Last Name: ${t.last_name?.trim() || '—'}`);
    lines.push(`Phone: ${t.phone?.trim() || '—'}`);
    lines.push(`Email: ${t.email?.trim() || '—'}`);
    lines.push(`PAN (Optional): ${String(t.pan || '').trim() || '—'}`);
    lines.push('');
  });

  lines.push('Rooms & occupancy:');
  if (Array.isArray(roomDetails) && roomDetails.length > 0) {
    roomDetails.forEach((r, idx) => {
      const a = Number(r.adults ?? 0);
      const c = Number(r.children ?? 0);
      const ages = Array.isArray(r.child_ages) ? r.child_ages.filter((n) => Number.isFinite(n)) : [];
      const agePart = ages.length ? ` | Child ages: ${ages.join(', ')}` : '';
      const sharingPart = r.sharing_type ? ` | ${String(r.sharing_type)} sharing` : '';
      lines.push(`Room ${idx + 1}: ${a} Adult(s), ${c} Child(ren)${sharingPart}${agePart}`);
    });
    lines.push(`Total rooms: ${rooms ?? roomDetails.length}`);
  } else {
    const a = travellers.filter((t) => String(t.traveller_type || 'adult').toLowerCase() === 'adult').length;
    const c = travellers.filter((t) => String(t.traveller_type || '').toLowerCase() === 'child').length;
    const inf = travellers.filter((t) => String(t.traveller_type || '').toLowerCase() === 'infant').length;
    if (rooms != null && rooms > 0) {
      lines.push(`Total rooms: ${rooms} (per-room Adults/Children not stored)`);
    }
    lines.push(`Travellers overall: ${a} Adult(s), ${c} Child(ren)${inf ? `, ${inf} Infant(s)` : ''}`);
  }

  return lines.join('\n');
}

async function getBookingPaymentContext(bookingId: number) {
  let booking: Record<string, unknown> | null = null;
  let bookingError: { message?: string } | null = null;

  const bookingSelectWide =
    'id,tour_id,departure_id,total_price,status,payment_amount,payment_status,payment_id,payment_order_id,rooms,room_details,display_currency,display_fx_rate,mts_id,crm_lead_id';
  const bookingSelectMid =
    'id,tour_id,departure_id,total_price,status,payment_amount,payment_status,payment_id,payment_order_id,rooms,room_details';
  const bookingSelectNarrow =
    'id,tour_id,departure_id,total_price,status,payment_amount,payment_status,payment_id,payment_order_id';

  const wideRes = await supabase.from('bookings').select(bookingSelectWide).eq('id', bookingId).single();
  if (wideRes.error && /column .* does not exist/i.test(String(wideRes.error.message || ''))) {
    // Some columns are missing — try mid (drops display_*), then narrow (drops rooms/room_details too).
    const midRes = await supabase.from('bookings').select(bookingSelectMid).eq('id', bookingId).single();
    if (midRes.error && /column .* does not exist/i.test(String(midRes.error.message || ''))) {
      const narrowRes = await supabase.from('bookings').select(bookingSelectNarrow).eq('id', bookingId).single();
      booking = (narrowRes.data as Record<string, unknown>) || null;
      bookingError = narrowRes.error;
    } else {
      booking = (midRes.data as Record<string, unknown>) || null;
      bookingError = midRes.error;
    }
  } else if (wideRes.error) {
    throw new Error(`Booking not found: ${wideRes.error.message}`);
  } else {
    booking = (wideRes.data as Record<string, unknown>) || null;
    bookingError = null;
  }
  if (bookingError || !booking) throw new Error('Booking not found.');

  const loadTravellersForBooking = async (): Promise<TravellerRowForNote[]> => {
    const bid = Number(booking.id);
    const attempts = [
      'id,traveller_type,salutation,first_name,last_name,phone,email,pan',
      'id,traveller_type,salutation,first_name,last_name,phone,email',
      'id,first_name,last_name,phone,email',
    ];
    for (const cols of attempts) {
      const t = await supabase.from('travellers').select(cols).eq('booking_id', bid).order('id', { ascending: true });
      if (!t.error) return (t.data || []) as TravellerRowForNote[];
      if (!/column .* does not exist/i.test(String(t.error.message || ''))) {
        throw new Error(`Failed to load travellers: ${t.error.message}`);
      }
    }
    return [];
  };
  const travellerRowsLoaded = await loadTravellersForBooking();

  const bookingDepartureId = Number(booking.departure_id) > 0 ? Number(booking.departure_id) : null;
  const { data: tour } = await supabase
    .from('tours')
    .select('id,title,destination,tour_region,destination_ref:destinations(name,continent)')
    .eq('id', Number(booking.tour_id))
    .maybeSingle();
  const { data: departure } = bookingDepartureId
    ? await supabase
        .from('departures')
        .select('id,city,start_date,end_date')
        .eq('id', bookingDepartureId)
        .maybeSingle()
    : { data: null };

  const tourTitle = String((tour as { title?: string })?.title || '').trim();
  const destination = String((tour as { destination?: string })?.destination || '').trim();
  const tourRegion = String((tour as { tour_region?: string })?.tour_region || '').trim();
  const continent = String(
    (tour as { destination_ref?: { continent?: string | null } | null })?.destination_ref?.continent || ''
  ).trim();
  const departureCity = String((departure as { city?: string })?.city || '').trim();
  const travelDate = String((departure as { start_date?: string })?.start_date || '').trim();
  const returnDate = String((departure as { end_date?: string })?.end_date || '').trim();
  const derivedDurationNights =
    travelDate && returnDate
      ? Math.max(
          1,
          Math.round(
            (new Date(`${returnDate}T00:00:00Z`).getTime() - new Date(`${travelDate}T00:00:00Z`).getTime()) /
              (1000 * 60 * 60 * 24)
          )
        )
      : 0;
  const durationLabel = derivedDurationNights > 0 ? `${derivedDurationNights}N` : '';
  const durationDaysLabel = derivedDurationNights > 0 ? `${derivedDurationNights + 1} Days` : '';
  const primaryTraveller = travellerRowsLoaded[0];
  const roomsStored = booking.rooms != null ? Number(booking.rooms) : null;
  const roomDetailsStored = Array.isArray(booking.room_details)
    ? (booking.room_details as Array<{ adults?: number; children?: number; child_ages?: number[] }>)
    : null;
  const travellersRoomsNote = buildTravellersAndRoomsCrmNote(
    travellerRowsLoaded,
    roomsStored,
    roomDetailsStored
  );

  const bookingRow = booking as {
    id: number;
    tour_id: number;
    departure_id: number;
    total_price: number;
    status: string;
    payment_amount?: number | null;
    payment_status?: string | null;
    payment_id?: string | null;
    payment_order_id?: string | null;
    display_currency?: string | null;
    display_fx_rate?: number | null;
    mts_id?: string | null;
    crm_lead_id?: number | null;
  };

  const displayCurrencyRaw = String(bookingRow.display_currency || '').toUpperCase().trim();
  const displayCurrency = displayCurrencyRaw && displayCurrencyRaw !== 'INR' ? displayCurrencyRaw : null;
  const displayFxRate = Number(bookingRow.display_fx_rate) > 0 ? Number(bookingRow.display_fx_rate) : null;
  const formatInr = (amount: number) => formatBookingAmount(amount, displayCurrency || 'INR');

  const travellersForCrm = attachChildAgesToTravellers(travellerRowsLoaded, roomDetailsStored);

  return {
    booking: bookingRow,
    destination,
    tourTitle,
    tourRegion,
    continent,
    departureCity,
    travelDate,
    returnDate,
    durationLabel,
    durationDaysLabel,
    primaryTraveller,
    roomDetailsStored,
    travellersForCrm,
    travellersRoomsNote,
    displayCurrency,
    displayFxRate,
    formatInr,
  };
}

function attachChildAgesToTravellers(
  travellers: TravellerRowForNote[],
  roomDetails: Array<{ child_ages?: number[] }> | null | undefined
): Array<TravellerRowForNote & { child_age?: number | null }> {
  const childAges = (roomDetails || []).flatMap((r) =>
    Array.isArray(r.child_ages) ? r.child_ages.filter((n) => Number.isFinite(n)) : []
  );
  let ageIdx = 0;
  return travellers.map((t) => {
    const type = String(t.traveller_type || 'adult').toLowerCase();
    const needsAge = type === 'child' || type === 'infant';
    const child_age =
      needsAge && ageIdx < childAges.length ? Number(childAges[ageIdx++]) : needsAge ? null : null;
    return { ...t, child_age };
  });
}

export async function createBookingPaymentOrder(input: CreateBookingPaymentOrderInput) {
  if (!input.booking_id) throw new Error('booking_id is required.');

  const context = await getBookingPaymentContext(input.booking_id);
  const razorpayAccount = resolveRazorpayAccountForCurrency(context.displayCurrency);
  if (!razorpayAccountConfigured(razorpayAccount)) {
    const label = razorpayAccount === 'au' ? 'Australia (AUD)' : 'India (INR)';
    throw new Error(`Razorpay credentials for ${label} are not configured.`);
  }

  const resolvedRegion = resolveTourRegionFromData(context.tourRegion, context.destination, context.continent);
  const advanceAmount = await resolvePaymentChargeAmount(context, razorpayAccount, 'advance');
  const charge = chargeAmountMinorUnits(advanceAmount, razorpayAccount);
  const currency = chargeCurrencyForAccount(razorpayAccount);
  const client = getRazorpayClient(razorpayAccount);

  const order = await client.orders.create({
    amount: charge.minorUnits,
    currency,
    receipt: `booking_${context.booking.id}_${Date.now()}`,
    notes: {
      booking_id: String(context.booking.id),
      destination: context.destination || 'N/A',
      tour_title: context.tourTitle || 'N/A',
      region: resolvedRegion,
      razorpay_account: razorpayAccount,
    },
  });

  try {
    await upsertBookingPaymentFields(context.booking.id, {
      payment_status: 'pending',
      payment_order_id: order.id,
      payment_amount: charge.majorAmount,
      payment_currency: currency,
      payment_notes: `Payment initiated via Razorpay (${razorpayAccount}) order ${order.id}; ${charge.currency} ${charge.majorAmount}`,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[payment-order] booking payment field update failed:', err);
  }

  return {
    booking: context.booking,
    razorpay_key_id: getRazorpayKeyId(razorpayAccount),
    razorpay_order_id: order.id,
    amount: charge.minorUnits,
    currency,
    slab_region: resolvedRegion,
    description: `Advance payment for ${context.tourTitle || context.destination || 'your tour'}`,
  };
}

export async function getBookingPaymentSummary(input: CreateBookingPaymentOrderInput) {
  if (!input.booking_id) throw new Error('booking_id is required.');
  const context = await getBookingPaymentContext(input.booking_id);
  const razorpayAccount = resolveRazorpayAccountForCurrency(context.displayCurrency);
  const totalAmountInInr = await packageTotalForPayment(context, razorpayAccount);
  const paidAmountInInr = await getPaidAmountForBooking(context.booking);
  const remainingAmountInInr = Math.max(0, totalAmountInInr - paidAmountInInr);
  return {
    booking_id: context.booking.id,
    mts_id: context.booking.mts_id ?? null,
    payment_status: context.booking.payment_status ?? null,
    total_amount: totalAmountInInr,
    paid_amount: paidAmountInInr,
    remaining_amount: remainingAmountInInr,
    display_currency: context.displayCurrency,
    display_fx_rate: context.displayFxRate,
  };
}

export async function createBookingBalancePaymentOrder(input: CreateBookingPaymentOrderInput) {
  if (!input.booking_id) throw new Error('booking_id is required.');

  const context = await getBookingPaymentContext(input.booking_id);
  const razorpayAccount = resolveRazorpayAccountForCurrency(context.displayCurrency);
  if (!razorpayAccountConfigured(razorpayAccount)) {
    const label = razorpayAccount === 'au' ? 'Australia (AUD)' : 'India (INR)';
    throw new Error(`Razorpay credentials for ${label} are not configured.`);
  }

  const totalAmountInInr = Number((context.booking as { total_price?: number | null })?.total_price || 0);
  const paidAmountInInr = await getPaidAmountForBooking(context.booking);
  const remainingAmountInInr = Math.max(0, Math.round(totalAmountInInr - paidAmountInInr));
  if (remainingAmountInInr <= 0) {
    throw new Error('No balance amount is due for this booking.');
  }

  const remainingCharge = await resolvePaymentChargeAmount(context, razorpayAccount, 'balance');
  const charge = chargeAmountMinorUnits(remainingCharge, razorpayAccount);
  const currency = chargeCurrencyForAccount(razorpayAccount);
  const client = getRazorpayClient(razorpayAccount);

  const order = await client.orders.create({
    amount: charge.minorUnits,
    currency,
    receipt: `booking_balance_${context.booking.id}_${Date.now()}`,
    notes: {
      booking_id: String(context.booking.id),
      purpose: 'balance',
      destination: context.destination || 'N/A',
      tour_title: context.tourTitle || 'N/A',
      razorpay_account: razorpayAccount,
    },
  });

  try {
    await upsertBookingPaymentFields(context.booking.id, {
      payment_status: 'balance_pending',
      payment_order_id: order.id,
      payment_amount: charge.majorAmount,
      payment_currency: currency,
      payment_notes: `Balance payment initiated via Razorpay (${razorpayAccount}) order ${order.id}`,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[balance-payment-order] booking payment field update failed:', err);
  }

  return {
    booking: context.booking,
    razorpay_key_id: getRazorpayKeyId(razorpayAccount),
    razorpay_order_id: order.id,
    amount: charge.minorUnits,
    currency,
    paid_amount: paidAmountInInr,
    remaining_amount: remainingAmountInInr,
    description: `Balance payment for ${context.booking.mts_id || context.tourTitle || context.destination || 'your tour'}`,
  };
}

export async function verifyBookingPayment(input: VerifyBookingPaymentInput) {
  if (!input.booking_id || !input.razorpay_order_id || !input.razorpay_payment_id || !input.razorpay_signature) {
    throw new Error('booking_id, razorpay_order_id, razorpay_payment_id and razorpay_signature are required.');
  }

  const context = await getBookingPaymentContext(input.booking_id);
  const razorpayAccount = resolveRazorpayAccountForCurrency(context.displayCurrency);
  if (
    !verifyPaymentSignature(
      razorpayAccount,
      input.razorpay_order_id,
      input.razorpay_payment_id,
      input.razorpay_signature
    )
  ) {
    throw new Error('Invalid payment signature.');
  }

  const razorpayClient = getRazorpayClient(razorpayAccount);
  const existingPaymentId = String((context.booking as { payment_id?: string | null })?.payment_id || '').trim();
  const existingPaymentStatus = String((context.booking as { payment_status?: string | null })?.payment_status || '').toLowerCase();
  if (existingPaymentId && existingPaymentId === input.razorpay_payment_id && existingPaymentStatus === 'paid') {
    return {
      booking_id: context.booking.id,
      status: 'confirmed',
      payment_status: 'paid',
      duplicate: true,
      mts_id: context.booking.mts_id ?? null,
      lead_id: context.booking.crm_lead_id ?? null,
    };
  }
  const paidBefore = await getPaidAmountForBooking(context.booking);
  const bookingPaymentStored = Number(
    (context.booking as { payment_amount?: number | null })?.payment_amount || 0
  );
  let currentPaymentAmountInInr = bookingPaymentStored;
  let paymentCurrency: string = chargeCurrencyForAccount(razorpayAccount);
  let paidAtIso = new Date().toISOString();
  let razorpayBankRrn = '';
  let razorpayDescription = '';
  let paymentPurpose: 'advance' | 'balance' = input.purpose || 'advance';
  try {
    const payment = (await razorpayClient.payments.fetch(input.razorpay_payment_id)) as {
      amount?: number;
      currency?: string;
      created_at?: number;
      acquirer_data?: { rrn?: string };
      description?: string;
    };
    if (Number.isFinite(Number(payment?.amount || 0)) && Number(payment?.amount || 0) > 0) {
      currentPaymentAmountInInr = Number(payment.amount) / 100;
    }
    paymentCurrency = String(payment?.currency || paymentCurrency).toUpperCase();
    if (Number.isFinite(Number(payment?.created_at || 0)) && Number(payment?.created_at || 0) > 0) {
      paidAtIso = new Date(Number(payment.created_at) * 1000).toISOString();
    }
    razorpayBankRrn = String(payment?.acquirer_data?.rrn || '').trim();
    razorpayDescription = String(payment?.description || '').trim();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[payment-verify] unable to fetch Razorpay payment details, using booking fallback:', err);
  }
  if (!input.purpose) {
    try {
      const order = (await razorpayClient.orders.fetch(input.razorpay_order_id)) as {
        notes?: { purpose?: string };
      };
      if (String(order?.notes?.purpose || '').toLowerCase() === 'balance') {
        paymentPurpose = 'balance';
      }
    } catch {
      // Order notes are best-effort; default advance behavior remains.
    }
  }
  const fullAmountInInr = await packageTotalForPayment(context, razorpayAccount);
  const cumulativePaidAmountInInr =
    paymentPurpose === 'balance'
      ? Math.min(fullAmountInInr, paidBefore + currentPaymentAmountInInr)
      : currentPaymentAmountInInr;
  const remainingAmountInInr = Math.max(0, fullAmountInInr - cumulativePaidAmountInInr);
  const nextPaymentStatus = remainingAmountInInr <= 0 ? 'paid' : 'partial_paid';
  const advanceSlabInInr =
    paymentPurpose === 'balance'
      ? Number(paidBefore || 0)
      : Number((context.booking as { payment_amount?: number | null })?.payment_amount || currentPaymentAmountInInr || 0);
  const customerCurrencyLine = context.displayCurrency
    ? `\nCustomer Display Currency: ${context.displayCurrency}`
    : '';
  const paymentCurrencyAmount =
    paymentCurrency && paymentCurrency !== 'INR'
      ? `${paymentCurrency} ${Number(currentPaymentAmountInInr || 0).toLocaleString('en-IN')}`
      : context.formatInr(currentPaymentAmountInInr);
  const detailsNote =
    `Payment Status: SUCCESS\n` +
    `Payment Purpose: ${paymentPurpose === 'balance' ? 'BALANCE' : 'ADVANCE'}\n` +
    `Booking ID: ${context.booking.id}\n` +
    `Razorpay Order ID: ${input.razorpay_order_id}\n` +
    `Razorpay Payment ID: ${input.razorpay_payment_id}\n` +
    `Amount Paid: ${paymentCurrencyAmount}\n` +
    `Cumulative Paid: ${context.formatInr(cumulativePaidAmountInInr)}\n` +
    `Full Package Amount: ${context.formatInr(fullAmountInInr)}\n` +
    `Remaining Amount: ${context.formatInr(remainingAmountInInr)}\n` +
    `Advance Slab: ${context.formatInr(advanceSlabInInr)}\n` +
    `Paid Time: ${paidAtIso}\n` +
    `Bank RRN: ${razorpayBankRrn || 'N/A'}\n` +
    `Description: ${razorpayDescription || 'N/A'}\n` +
    `Destination: ${context.destination || 'N/A'}\n` +
    `Travel Date: ${context.travelDate || 'N/A'}\n` +
    `Return Date: ${context.returnDate || 'N/A'}\n` +
    `Duration: ${context.durationDaysLabel || context.durationLabel || 'N/A'}\n` +
    `Departure City: ${context.departureCity || 'N/A'}\n` +
    `Tour Region: ${context.tourRegion || 'N/A'}` +
    customerCurrencyLine +
    (context.travellersRoomsNote || '');

  try {
    await upsertBookingPaymentFields(context.booking.id, {
      status: 'confirmed',
      payment_status: nextPaymentStatus,
      payment_order_id: input.razorpay_order_id,
      payment_id: input.razorpay_payment_id,
      payment_amount: cumulativePaidAmountInInr,
      payment_currency: paymentCurrency,
      payment_verified_at: new Date().toISOString(),
      payment_notes: detailsNote,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[payment-verify] booking payment field update failed:', err);
  }

  try {
    await createBookingTransaction({
      booking_id: context.booking.id,
      payment_status: 'success',
      amount: Number(currentPaymentAmountInInr || 0),
      currency: paymentCurrency || 'INR',
      payment_order_id: input.razorpay_order_id,
      payment_id: input.razorpay_payment_id,
      note: detailsNote,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[payment-verify] transaction insert failed:', err);
  }

  let crmSyncResult: CrmPaymentEventResult | null = null;
  try {
    crmSyncResult = await syncBookingPaymentToCrm({
      booking_id: context.booking.id,
      payment_status: 'success',
      amount: Number(currentPaymentAmountInInr || 0),
      amount_slab: advanceSlabInInr,
      full_amount: fullAmountInInr,
      remaining_amount: remainingAmountInInr,
      payment_currency: paymentCurrency,
      destination: context.destination,
      tour_title: context.tourTitle,
      travel_date: context.travelDate,
      return_date: context.returnDate,
      duration: context.durationDaysLabel || context.durationLabel,
      starting_point: context.departureCity,
      tour_region: context.tourRegion,
      departure_city: context.departureCity,
      razorpay_order_id: input.razorpay_order_id,
      razorpay_payment_id: input.razorpay_payment_id,
      razorpay_bank_rrn: razorpayBankRrn,
      razorpay_description: razorpayDescription,
      paid_at: paidAtIso,
      display_currency: context.displayCurrency,
      display_fx_rate: context.displayFxRate,
      customer_phone: context.primaryTraveller?.phone ?? undefined,
      customer_email: context.primaryTraveller?.email ?? undefined,
      customer_name: `${context.primaryTraveller?.first_name || ''} ${context.primaryTraveller?.last_name || ''}`.trim(),
      travellers: context.travellersForCrm,
      room_details: context.roomDetailsStored,
      details_note: detailsNote,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[payment-verify] CRM sync failed:', err);
  }

  // Persist mts_id + crm_lead_id back onto the booking row so subsequent flows
  // (confirmation page reload, dashboard fetch, support look-up) can read them
  // without re-asking the CRM. Forward-compatible: silently skipped when columns are missing.
  if (crmSyncResult?.mts_id || crmSyncResult?.lead_id) {
    try {
      await upsertBookingPaymentFields(context.booking.id, {
        mts_id: crmSyncResult?.mts_id || undefined,
        crm_lead_id: crmSyncResult?.lead_id || undefined,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[payment-verify] booking mts_id update skipped:', err);
    }
  }

  return {
    booking_id: context.booking.id,
    status: 'confirmed',
    payment_status: nextPaymentStatus,
    paid_amount: cumulativePaidAmountInInr,
    remaining_amount: remainingAmountInInr,
    mts_id: crmSyncResult?.mts_id ?? null,
    lead_id: crmSyncResult?.lead_id ?? null,
  };
}

export async function updateBookingPaymentStatus(input: UpdateBookingPaymentStatusInput) {
  if (!input.booking_id || !input.payment_status) {
    throw new Error('booking_id and payment_status are required.');
  }
  const context = await getBookingPaymentContext(input.booking_id);
  const advanceSlabInInr = Number((context.booking as { payment_amount?: number | null })?.payment_amount || 0);
  const customerCurrencyLine = context.displayCurrency
    ? `\nCustomer Display Currency: ${context.displayCurrency}${context.displayFxRate ? ` (1 ${context.displayCurrency} ≈ INR ${context.displayFxRate})` : ''}`
    : '';
  const detailsNote =
    `Payment Status: ${String(input.payment_status).toUpperCase()}\n` +
    `Booking ID: ${context.booking.id}\n` +
    `Razorpay Order ID: ${input.razorpay_order_id || 'N/A'}\n` +
    `Razorpay Payment ID: ${input.razorpay_payment_id || 'N/A'}\n` +
    `Advance Slab: ${context.formatInr(advanceSlabInInr)}\n` +
    `Reason: ${input.reason || 'Not provided'}` +
    customerCurrencyLine +
    (context.travellersRoomsNote || '');

  try {
    await upsertBookingPaymentFields(context.booking.id, {
      status: 'pending',
      payment_status: input.payment_status,
      payment_order_id: input.razorpay_order_id || null,
      payment_id: input.razorpay_payment_id || null,
      payment_notes: detailsNote,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[payment-status] booking payment field update failed:', err);
  }

  try {
    await createBookingTransaction({
      booking_id: context.booking.id,
      payment_status: input.payment_status,
      amount: Number((context.booking as { payment_amount?: number | null })?.payment_amount || 0),
      currency: 'INR',
      payment_order_id: input.razorpay_order_id,
      payment_id: input.razorpay_payment_id,
      note: detailsNote,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[payment-status] transaction insert failed:', err);
  }

  let crmSyncResult: CrmPaymentEventResult | null = null;
  try {
    crmSyncResult = await syncBookingPaymentToCrm({
      booking_id: context.booking.id,
      payment_status: input.payment_status,
      amount: advanceSlabInInr,
      amount_slab: advanceSlabInInr,
      payment_currency: 'INR',
      destination: context.destination,
      tour_title: context.tourTitle,
      travel_date: context.travelDate,
      return_date: context.returnDate,
      duration: context.durationDaysLabel || context.durationLabel,
      starting_point: context.departureCity,
      tour_region: context.tourRegion,
      departure_city: context.departureCity,
      razorpay_order_id: input.razorpay_order_id,
      razorpay_payment_id: input.razorpay_payment_id,
      display_currency: context.displayCurrency,
      display_fx_rate: context.displayFxRate,
      customer_phone: context.primaryTraveller?.phone ?? undefined,
      customer_email: context.primaryTraveller?.email ?? undefined,
      customer_name: `${context.primaryTraveller?.first_name || ''} ${context.primaryTraveller?.last_name || ''}`.trim(),
      travellers: context.travellersForCrm,
      room_details: context.roomDetailsStored,
      details_note: detailsNote,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[payment-status] CRM sync failed:', err);
  }

  if (crmSyncResult?.mts_id || crmSyncResult?.lead_id) {
    try {
      await upsertBookingPaymentFields(context.booking.id, {
        mts_id: crmSyncResult?.mts_id || undefined,
        crm_lead_id: crmSyncResult?.lead_id || undefined,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[payment-status] booking mts_id update skipped:', err);
    }
  }

  return {
    booking_id: context.booking.id,
    status: 'pending',
    payment_status: input.payment_status,
    mts_id: crmSyncResult?.mts_id ?? context.booking.mts_id ?? null,
    lead_id: crmSyncResult?.lead_id ?? context.booking.crm_lead_id ?? null,
  };
}

export async function handleRazorpayWebhook(rawBody: string, signature: string | undefined) {
  const webhookAccount = resolveWebhookAccount(rawBody, signature);
  if (!webhookAccount) {
    throw new Error('Invalid webhook signature.');
  }

  const payload = JSON.parse(rawBody || '{}') as {
    event?: string;
    payload?: { payment?: { entity?: { order_id?: string; id?: string; status?: string } } };
  };
  const event = String(payload.event || '');
  const paymentEntity = payload.payload?.payment?.entity;
  const orderId = String(paymentEntity?.order_id || '');
  const paymentId = String(paymentEntity?.id || '');

  if (!orderId) {
    return { processed: false, reason: 'missing_order_id' };
  }

  const { data: booking } = await supabase
    .from('bookings')
    .select('id,payment_status,payment_id')
    .eq('payment_order_id', orderId)
    .maybeSingle();
  if (!booking?.id) return { processed: false, reason: 'booking_not_found' };

  if (event === 'payment.captured' || event === 'order.paid') {
    const paySt = String((booking as { payment_status?: string | null }).payment_status || '').toLowerCase();
    const existingPid = String((booking as { payment_id?: string | null }).payment_id || '').trim();
    if (paySt === 'paid' && existingPid) {
      return { processed: true, booking_id: booking.id, payment_status: 'paid', duplicate: true };
    }
    const syntheticSignature = crypto
      .createHmac('sha256', String(
        webhookAccount === 'au' ? env.RAZORPAY_AU_KEY_SECRET : env.RAZORPAY_IN_KEY_SECRET
      ))
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
    await verifyBookingPayment({
      booking_id: booking.id,
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: syntheticSignature,
    });
    return { processed: true, booking_id: booking.id, payment_status: 'paid' };
  }

  if (event === 'payment.failed') {
    await updateBookingPaymentStatus({
      booking_id: booking.id,
      payment_status: 'failed',
      reason: String(paymentEntity?.status || 'payment.failed'),
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
    });
    return { processed: true, booking_id: booking.id, payment_status: 'failed' };
  }

  return { processed: false, reason: 'event_ignored', event };
}

function validateCreateEnquiryPayload(input: CreateEnquiryInput): void {
  if (!input.tour_id) {
    throw new Error('tour_id is required.');
  }
  if (!String(input.name || '').trim()) {
    throw new Error('name is required.');
  }
  if (!String(input.phone || '').trim()) {
    throw new Error('phone is required.');
  }
  if (!String(input.departure_city || '').trim()) {
    throw new Error('departure_city is required.');
  }
  if (!String(input.travel_date || '').trim()) {
    throw new Error('travel_date is required.');
  }
}

function normalizePhoneNumber(rawPhone: string): string {
  const trimmed = String(rawPhone || '').trim();
  if (!trimmed) return '';
  const hasPlusPrefix = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  return `${hasPlusPrefix ? '+' : ''}${digits}`;
}

function validateWebsiteLeadPayload(input: CreateWebsiteLeadInput): void {
  if (!String(input.name || '').trim()) {
    throw new Error('name is required.');
  }
  if (!String(input.destination || '').trim()) {
    throw new Error('destination is required.');
  }
  const normalizedPhone = normalizePhoneNumber(String(input.phone || ''));
  const digitsOnly = normalizedPhone.replace(/\D/g, '');
  if (!digitsOnly) {
    throw new Error('phone is required.');
  }
  if (digitsOnly.length < 7 || digitsOnly.length > 15) {
    throw new Error('Enter a valid mobile number.');
  }
}

function consumeSlidingWindowRateLimit(
  store: Map<string, number[]>,
  key: string,
  limit: number,
  windowMs: number
) {
  const now = Date.now();
  const hits = (store.get(key) || []).filter((ts) => now - ts < windowMs);
  if (hits.length >= limit) {
    const retryAfterMs = windowMs - (now - hits[0]);
    store.set(key, hits);
    return { allowed: false, retryAfterMs };
  }
  hits.push(now);
  store.set(key, hits);
  return { allowed: true, retryAfterMs: 0 };
}

async function forwardEnquiryToCrm25(input: CreateEnquiryInput) {
  const base = String(env.CRM_API_URL || '').replace(/\/$/, '');
  if (!base) return;
  const url = `${base}/api/lead/website`;

  const hasTourTitle = String(input.tour_title || '').trim().length > 0;
  const normalizedRoomDetails =
    Array.isArray(input.room_details) && input.room_details.length > 0
      ? input.room_details.map((room) => ({
          adults: Number(room?.adults || 0),
          children: Number(room?.children || 0),
          child_ages: Array.isArray(room?.child_ages)
            ? room.child_ages.map((age) => Number(age)).filter((age) => Number.isFinite(age) && age > 0)
            : [],
        }))
      : [
          {
            adults: Number(input.adults || 0),
            children: Number(input.children || 0),
            child_ages: [],
          },
        ];
  const normalizedChildAges = normalizedRoomDetails.flatMap((room) => room.child_ages || []);
  const enquiryLabel = String(input.enquiry_type || '').trim() || 'Tour Package';
  const leadSource = String(input.source || '').trim() || 'website';
  const serviceList =
    Array.isArray(input.services) && input.services.length > 0
      ? input.services.map((service) => String(service).trim()).filter(Boolean)
      : [enquiryLabel];
  const isMiceLead =
    enquiryLabel.toUpperCase() === 'MICE' ||
    (Array.isArray(serviceList) && serviceList.some((s) => String(s).toUpperCase() === 'MICE'));
  const isForexLead =
    enquiryLabel.toUpperCase() === 'FOREX' ||
    (Array.isArray(serviceList) && serviceList.some((s) => String(s).toUpperCase() === 'FOREX'));
  const miceRequirements = String(input.mice_requirements || '').trim();
  const noteContent = hasTourTitle
    ? `Customer needs assistance for the tour booking - "${String(input.tour_title || '').trim()}". Link: ${String(input.page_url || '').trim() || 'Not provided'}`
    : isForexLead
      ? `Forex website enquiry — ${miceRequirements || 'Rate / amount details in summary'}${
          input.page_url ? ` | ${input.page_url}` : ''
        }`
      : isMiceLead
        ? `MICE website enquiry — ${input.destination || 'destination TBC'}${
            miceRequirements ? `. ${miceRequirements}` : ''
          }${input.page_url ? ` | ${input.page_url}` : ''}`
        : `Customer needs assistance via ${input.destination || 'website contact'}${
            input.nationality ? ` | Nationality: ${input.nationality}` : ''
          }${input.page_url ? ` | ${input.page_url}` : ''}`;
  const attendeeCount = Number(input.attendees ?? input.adults) || 1;
  const basePayload = {
    name: input.name,
    phone: input.phone,
    email: input.email || undefined,
    destination: input.destination || undefined,
    duration: input.duration || undefined,
    date_of_travel: input.travel_date,
    date: input.travel_date,
    travel_date: input.travel_date,
    enquiry: enquiryLabel,
    services: serviceList,
    starting_point: input.departure_city,
    summary: isForexLead
      ? [
          `Forex enquiry — ${input.forex_currency_have || '?'} → ${input.forex_currency_required || '?'}`,
          miceRequirements || null,
        ]
          .filter(Boolean)
          .join(' | ')
      : isMiceLead
        ? [
            `MICE enquiry — ${input.event_type || 'Event'} | ${input.destination || 'TBC'} | ${attendeeCount} attendee(s)`,
            input.venue_location ? `Venue: ${input.venue_location}` : null,
            input.event_date ? `Event date: ${input.event_date}` : null,
          ]
            .filter(Boolean)
            .join(' | ')
        : [
          `Website enquiry for ${input.destination || 'tour'} | ${input.duration || 'duration not specified'} | ${input.adults}A/${input.children}C | Rooms: ${input.rooms}`,
          input.occupancy_notes ? String(input.occupancy_notes).trim() : null,
        ]
          .filter(Boolean)
          .join(' | '),
    source: leadSource,
    adults: input.adults,
    children: input.children,
    babies: input.infants || 0,
    travelers: attendeeCount,
    passengers: attendeeCount,
    attendees: attendeeCount,
    rooms: input.rooms,
    ...(input.event_type ? { event_type: input.event_type } : {}),
    ...(input.event_date ? { event_date: input.event_date } : {}),
    ...(input.venue_location ? { venue_location: input.venue_location } : {}),
    ...(miceRequirements ? { mice_requirements: miceRequirements } : {}),
    room_details: normalizedRoomDetails,
    children_ages: normalizedChildAges,
    ...(input.tour_region ? { tour_region: input.tour_region } : {}),
    ...(input.budget != null && input.budget !== '' ? { budget: input.budget } : {}),
    ...(input.is_flexible_dates ? { is_flexible_dates: true } : {}),
    ...(input.return_date ? { return_date: input.return_date } : {}),
    ...(input.occupancy_notes ? { occupancy_notes: input.occupancy_notes } : {}),
    ...(input.forex_currency_have ? { forex_currency_have: input.forex_currency_have } : {}),
    ...(input.forex_currency_required ? { forex_currency_required: input.forex_currency_required } : {}),
    notes: [
      {
        type: 'note',
        content: noteContent,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const sourceCandidates: Array<string | null> = [
    leadSource,
    ...(leadSource.toLowerCase() !== 'website' ? ['website'] : []),
    'Website',
    'WEB',
    null,
  ];
  let lastError = '';

  for (const source of sourceCandidates) {
    const payload = source ? { ...basePayload, source } : basePayload;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (response.ok) return;

    const text = await response.text().catch(() => '');
    const errorText = `CRM lead forward failed: ${response.status} ${text}`.trim();
    const isSourceEnumError = /invalid input value for enum lead_source_enum/i.test(text);
    if (isSourceEnumError) {
      // eslint-disable-next-line no-console
      console.warn('[website-lead] CRM rejected source, retrying with fallback source', { attemptedSource: source ?? 'none' });
      lastError = errorText;
      continue;
    }

    throw new Error(errorText);
  }

  throw new Error(lastError || 'CRM lead forward failed.');
}

export async function createEnquiry(input: CreateEnquiryInput) {
  validateCreateEnquiryPayload(input);
  const isMissingTableError = (message: string) =>
    /relation .* does not exist/i.test(message) ||
    /could not find the table .* in the schema cache/i.test(message);

  const ipKey = String(input.ip_address || '').trim() || 'unknown';
  const phoneKey = String(input.phone || '').trim().toLowerCase();

  const ipRate = consumeSlidingWindowRateLimit(
    enquiryIpRateMap,
    ipKey,
    ENQUIRY_IP_RATE_MAX,
    ENQUIRY_RATE_WINDOW_MS
  );
  if (!ipRate.allowed) {
    throw new Error('Too many enquiries from this network. Please try again later.');
  }

  const phoneRate = consumeSlidingWindowRateLimit(
    enquiryPhoneRateMap,
    phoneKey,
    ENQUIRY_PHONE_RATE_MAX,
    ENQUIRY_RATE_WINDOW_MS
  );
  if (!phoneRate.allowed) {
    throw new Error('Too many enquiries for this phone number. Please try again shortly.');
  }

  const enquiryRowBase = {
    tour_id: input.tour_id,
    departure_id: input.departure_id || null,
    name: String(input.name || '').trim(),
    phone: String(input.phone || '').trim(),
    email: String(input.email || '').trim() || null,
    departure_city: String(input.departure_city || '').trim(),
    travel_date: String(input.travel_date || '').trim(),
    adults: Number(input.adults || 0),
    children: Number(input.children || 0),
    infants: Number(input.infants || 0),
    rooms: Number(input.rooms || 0),
    status: 'new',
    source: 'website',
  };

  const enquiryRowExtended = {
    ...enquiryRowBase,
    destination: String(input.destination || '').trim() || null,
    duration: String(input.duration || '').trim() || null,
  };
  const enquiryRowBaseUpperSource = {
    ...enquiryRowBase,
    source: 'Website',
  };
  const enquiryRowExtendedUpperSource = {
    ...enquiryRowExtended,
    source: 'Website',
  };
  const { source: _sourceBase, ...enquiryRowBaseWithoutSource } = enquiryRowBase;
  const { source: _sourceExtended, ...enquiryRowExtendedWithoutSource } = enquiryRowExtended;

  let primary = await supabase
    .from('enquiries')
    .insert(enquiryRowExtended)
    .select('id,tour_id,departure_id,name,phone,email,departure_city,travel_date,adults,children,infants,rooms,status,created_at')
    .single();

  if (primary.error && /column .* does not exist/i.test(String(primary.error.message || ''))) {
    primary = await supabase
      .from('enquiries')
      .insert(enquiryRowBase)
      .select('id,tour_id,departure_id,name,phone,email,departure_city,travel_date,adults,children,infants,rooms,status,created_at')
      .single();
  }
  if (primary.error && /invalid input value for enum .*source/i.test(String(primary.error.message || ''))) {
    primary = await supabase
      .from('enquiries')
      .insert(enquiryRowExtendedUpperSource)
      .select('id,tour_id,departure_id,name,phone,email,departure_city,travel_date,adults,children,infants,rooms,status,created_at')
      .single();
    if (primary.error && /column .* does not exist/i.test(String(primary.error.message || ''))) {
      primary = await supabase
        .from('enquiries')
        .insert(enquiryRowBaseUpperSource)
        .select('id,tour_id,departure_id,name,phone,email,departure_city,travel_date,adults,children,infants,rooms,status,created_at')
        .single();
    }
  }
  if (primary.error && /invalid input value for enum .*source/i.test(String(primary.error.message || ''))) {
    primary = await supabase
      .from('enquiries')
      .insert(enquiryRowExtendedWithoutSource)
      .select('id,tour_id,departure_id,name,phone,email,departure_city,travel_date,adults,children,infants,rooms,status,created_at')
      .single();
    if (primary.error && /column .* does not exist/i.test(String(primary.error.message || ''))) {
      primary = await supabase
        .from('enquiries')
        .insert(enquiryRowBaseWithoutSource)
        .select('id,tour_id,departure_id,name,phone,email,departure_city,travel_date,adults,children,infants,rooms,status,created_at')
        .single();
    }
  }

  if (!primary.error && primary.data) {
    // Persist optional user_id link (silently skipped when the column doesn't exist yet).
    if (input.user_id) {
      const enquiryId = (primary.data as { id?: number })?.id;
      if (enquiryId) {
        const { error: linkErr } = await supabase
          .from('enquiries')
          .update({ user_id: input.user_id })
          .eq('id', enquiryId);
        if (linkErr && !/column .* does not exist/i.test(String(linkErr.message || ''))) {
          // eslint-disable-next-line no-console
          console.warn('[tour-enquiry] user_id link skipped:', linkErr.message);
        }
      }
    }
    try {
      // eslint-disable-next-line no-console
      console.info('[tour-enquiry] forwarding to CRM', {
        tourId: input.tour_id,
        destination: String(input.destination || '').trim() || null,
        hasLink: Boolean(String(input.page_url || '').trim()),
      });
      // eslint-disable-next-line no-console
      console.info(`[tour-enquiry] passenger snapshot: ${input.adults}A/${input.children}C, rooms=${input.rooms}`);
      await forwardEnquiryToCrm25(input);
      // eslint-disable-next-line no-console
      console.info('[tour-enquiry] CRM forward success');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[tour-enquiry] CRM forward failed:', err);
    }
    return { enquiry: primary.data };
  }

  // Fallback for environments using an alternate table name.
  if (primary.error && isMissingTableError(String(primary.error.message || ''))) {
    let fallback = await supabase
      .from('booking_enquiries')
      .insert(enquiryRowExtended)
      .select('id,tour_id,departure_id,name,phone,email,departure_city,travel_date,adults,children,infants,rooms,status,created_at')
      .single();

    if (fallback.error && /column .* does not exist/i.test(String(fallback.error.message || ''))) {
      fallback = await supabase
        .from('booking_enquiries')
        .insert(enquiryRowBase)
        .select('id,tour_id,departure_id,name,phone,email,departure_city,travel_date,adults,children,infants,rooms,status,created_at')
        .single();
    }
    if (fallback.error && /invalid input value for enum .*source/i.test(String(fallback.error.message || ''))) {
      fallback = await supabase
        .from('booking_enquiries')
        .insert(enquiryRowExtendedUpperSource)
        .select('id,tour_id,departure_id,name,phone,email,departure_city,travel_date,adults,children,infants,rooms,status,created_at')
        .single();
      if (fallback.error && /column .* does not exist/i.test(String(fallback.error.message || ''))) {
        fallback = await supabase
          .from('booking_enquiries')
          .insert(enquiryRowBaseUpperSource)
          .select('id,tour_id,departure_id,name,phone,email,departure_city,travel_date,adults,children,infants,rooms,status,created_at')
          .single();
      }
    }
    if (fallback.error && /invalid input value for enum .*source/i.test(String(fallback.error.message || ''))) {
      fallback = await supabase
        .from('booking_enquiries')
        .insert(enquiryRowExtendedWithoutSource)
        .select('id,tour_id,departure_id,name,phone,email,departure_city,travel_date,adults,children,infants,rooms,status,created_at')
        .single();
      if (fallback.error && /column .* does not exist/i.test(String(fallback.error.message || ''))) {
        fallback = await supabase
          .from('booking_enquiries')
          .insert(enquiryRowBaseWithoutSource)
          .select('id,tour_id,departure_id,name,phone,email,departure_city,travel_date,adults,children,infants,rooms,status,created_at')
          .single();
      }
    }

    if (!fallback.error && fallback.data) {
      try {
        // eslint-disable-next-line no-console
        console.info('[tour-enquiry] forwarding to CRM', {
          tourId: input.tour_id,
          destination: String(input.destination || '').trim() || null,
          hasLink: Boolean(String(input.page_url || '').trim()),
        });
        // eslint-disable-next-line no-console
        console.info(`[tour-enquiry] passenger snapshot: ${input.adults}A/${input.children}C, rooms=${input.rooms}`);
        await forwardEnquiryToCrm25(input);
        // eslint-disable-next-line no-console
        console.info('[tour-enquiry] CRM forward success');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[tour-enquiry] CRM forward failed:', err);
      }
      return { enquiry: fallback.data };
    }

    const fallbackMessage = String(fallback.error?.message || '');
    if (isMissingTableError(fallbackMessage)) {
      try {
        // eslint-disable-next-line no-console
        console.info('[tour-enquiry] forwarding to CRM without DB table', {
          tourId: input.tour_id,
          destination: String(input.destination || '').trim() || null,
          hasLink: Boolean(String(input.page_url || '').trim()),
        });
        // eslint-disable-next-line no-console
        console.info(`[tour-enquiry] passenger snapshot: ${input.adults}A/${input.children}C, rooms=${input.rooms}`);
        await forwardEnquiryToCrm25(input);
        // eslint-disable-next-line no-console
        console.info('[tour-enquiry] CRM forward success (no DB table)');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[tour-enquiry] CRM forward failed (no DB table):', err);
      }
      return { enquiry: null };
    }

    throw new Error(`Failed to create enquiry: ${fallback.error?.message || 'Unknown error'}`);
  }

  if (primary.error && isMissingTableError(String(primary.error.message || ''))) {
    try {
      // eslint-disable-next-line no-console
      console.info('[tour-enquiry] forwarding to CRM without DB table', {
        tourId: input.tour_id,
        destination: String(input.destination || '').trim() || null,
        hasLink: Boolean(String(input.page_url || '').trim()),
      });
      // eslint-disable-next-line no-console
      console.info(`[tour-enquiry] passenger snapshot: ${input.adults}A/${input.children}C, rooms=${input.rooms}`);
      await forwardEnquiryToCrm25(input);
      // eslint-disable-next-line no-console
      console.info('[tour-enquiry] CRM forward success (no DB table)');
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[tour-enquiry] CRM forward failed (no DB table):', err);
    }
    return { enquiry: null };
  }

  throw new Error(`Failed to create enquiry: ${primary.error?.message || 'Unknown error'}`);
}

export async function createWebsiteLead(input: CreateWebsiteLeadInput) {
  validateWebsiteLeadPayload(input);

  const normalizedPhone = normalizePhoneNumber(String(input.phone || ''));
  const ipKey = String(input.ip_address || '').trim() || 'unknown';
  const phoneKey = normalizedPhone.toLowerCase();

  const ipRate = consumeSlidingWindowRateLimit(
    enquiryIpRateMap,
    ipKey,
    ENQUIRY_IP_RATE_MAX,
    ENQUIRY_RATE_WINDOW_MS
  );
  if (!ipRate.allowed) {
    throw new Error('Too many enquiries from this network. Please try again later.');
  }

  const phoneRate = consumeSlidingWindowRateLimit(
    enquiryPhoneRateMap,
    phoneKey,
    ENQUIRY_PHONE_RATE_MAX,
    ENQUIRY_RATE_WINDOW_MS
  );
  if (!phoneRate.allowed) {
    throw new Error('Too many enquiries for this phone number. Please try again shortly.');
  }

  const today = new Date().toISOString().slice(0, 10);
  // eslint-disable-next-line no-console
  console.info('[website-lead] forwarding to CRM', {
    destination: String(input.destination || '').trim(),
    hasTourId: Boolean(input.tour_id),
    hasIp: Boolean(input.ip_address),
  });
  const enquiryType = String(input.enquiry_type || '').trim() || null;
  const serviceList =
    Array.isArray(input.services) && input.services.length > 0
      ? input.services.map((s) => String(s).trim()).filter(Boolean)
      : enquiryType
        ? [enquiryType]
        : null;
  const adults = Number(input.adults);
  const guestCount = Number.isFinite(adults) && adults > 0 ? adults : 1;
  const isMice = enquiryType?.toUpperCase() === 'MICE';
  const isForex =
    enquiryType?.toUpperCase() === 'FOREX' ||
    (Array.isArray(serviceList) && serviceList.some((s) => String(s).toUpperCase() === 'FOREX'));
  const miceRequirements = String(input.mice_requirements || input.message || '').trim() || null;
  const forexHave = String(input.forex_currency_have || '').trim() || null;
  const forexRequired = String(input.forex_currency_required || '').trim() || null;
  const forexAmount = Number(input.forex_amount);
  const forexMessage = isForex
    ? [
        input.forex_mode ? `Mode: ${input.forex_mode}` : null,
        forexHave ? `Currency have: ${forexHave}` : null,
        forexRequired ? `Currency required: ${forexRequired}` : null,
        Number.isFinite(forexAmount) && forexAmount > 0 ? `Amount: ${forexAmount}` : null,
        String(input.message || '').trim() || null,
      ]
        .filter(Boolean)
        .join(' | ')
    : null;

  try {
    await forwardEnquiryToCrm25({
      tour_id: Number(input.tour_id || 0),
      departure_id: null,
      name: String(input.name || '').trim(),
      phone: normalizedPhone,
      email: String(input.email || '').trim() || null,
      departure_city: String(input.market || 'Website').trim() || 'Website',
      travel_date: String(input.travel_date || '').trim() || today,
      destination: String(input.destination || '').trim() || (isForex ? 'Forex' : ''),
      duration: isMice && input.event_date ? String(input.event_date).trim() : '',
      adults: guestCount,
      attendees: guestCount,
      children: 0,
      infants: 0,
      rooms: 1,
      page_url: String(input.page_url || '').trim() || undefined,
      enquiry_type: enquiryType,
      services: serviceList,
      event_type: input.event_type || null,
      event_date: input.event_date || null,
      venue_location: input.venue_location || null,
      mice_requirements: isForex ? forexMessage : miceRequirements,
      forex_currency_have: forexHave,
      forex_currency_required: forexRequired,
      nationality: isMice || isForex ? null : String(input.message || input.nationality || '').trim() || null,
      ip_address: input.ip_address,
      user_agent: input.user_agent,
    });
    // eslint-disable-next-line no-console
    console.info('[website-lead] CRM forward success');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[website-lead] CRM forward failed', err);
    return {
      success: true,
      forwarded: false,
    };
  }

  return {
    success: true,
    forwarded: true,
  };
}

const PLANNER_MONTH_LABELS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const PLANNER_FLEXIBLE_DEFAULT_DAYS = 4;

const PLANNER_BUDGET_CRM_MAP: Record<string, string> = {
  'budget-friendly': 'economical',
  'comfort-collection': 'standard',
  'signature-tours': 'deluxe',
  'royal-retreat': 'luxury',
};

const INDIAN_DESTINATION_HINTS = [
  'india',
  'andhra pradesh',
  'arunachal pradesh',
  'assam',
  'bihar',
  'chhattisgarh',
  'goa',
  'gujarat',
  'haryana',
  'himachal pradesh',
  'jharkhand',
  'karnataka',
  'kerala',
  'madhya pradesh',
  'maharashtra',
  'manipur',
  'meghalaya',
  'mizoram',
  'nagaland',
  'odisha',
  'punjab',
  'rajasthan',
  'sikkim',
  'tamil nadu',
  'telangana',
  'tripura',
  'uttar pradesh',
  'uttarakhand',
  'west bengal',
  'andaman',
  'chandigarh',
  'delhi',
  'jammu',
  'kashmir',
  'ladakh',
  'lakshadweep',
  'puducherry',
  'mumbai',
  'bangalore',
  'chennai',
  'kolkata',
  'hyderabad',
  'jaipur',
];

function addDaysIsoDate(isoDate: string, daysToAdd: number): string | null {
  const base = new Date(`${String(isoDate).slice(0, 10)}T12:00:00`);
  if (Number.isNaN(base.getTime())) return null;
  base.setDate(base.getDate() + daysToAdd);
  return base.toISOString().slice(0, 10);
}

function normalizePlannerRooms(
  raw: Array<{ adults: number; children: number; child_ages?: number[]; childAges?: number[] }>
) {
  return raw.map((room) => {
    const childAges = Array.isArray(room.child_ages)
      ? room.child_ages
      : Array.isArray(room.childAges)
        ? room.childAges
        : [];
    return {
      adults: Number(room.adults || 0),
      children: Number(room.children || 0),
      child_ages: childAges.map((age) => Number(age)).filter((age) => Number.isFinite(age)),
    };
  });
}

function resolvePlannerTourRegion(destinations: string): 'Domestic' | 'International' {
  const parts = String(destinations || '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return 'International';

  const isIndianDestination = (part: string) =>
    INDIAN_DESTINATION_HINTS.some((hint) => part === hint || part.includes(hint) || hint.includes(part));

  return parts.every(isIndianDestination) ? 'Domestic' : 'International';
}

function mapPlannerBudgetTier(tierId?: string | null): string {
  const id = String(tierId || '').trim().toLowerCase();
  return PLANNER_BUDGET_CRM_MAP[id] || 'standard';
}

/** Silent CRM handoff for the header holiday planner (signed-in customers only). */
export async function createPlannerLead(input: CreatePlannerLeadInput) {
  const destinations = String(input.destinations || '').trim();
  if (!destinations) {
    throw new Error('destinations is required.');
  }
  if (!String(input.user_id || '').trim()) {
    throw new Error('Authentication required.');
  }

  const rooms = normalizePlannerRooms(
    Array.isArray(input.rooms) && input.rooms.length ? input.rooms : [{ adults: 1, children: 0 }]
  );
  const adults = rooms.reduce((sum, room) => sum + Number(room.adults || 0), 0) || 1;
  const children = rooms.reduce((sum, room) => sum + Number(room.children || 0), 0);
  const roomCount = Math.max(1, rooms.length);

  const name =
    String(input.name || '').trim() ||
    String(input.email || '')
      .split('@')[0]
      ?.trim() ||
    'Website traveller';
  const phoneRaw = normalizePhoneNumber(String(input.phone || ''));
  const digitsOnly = phoneRaw.replace(/\D/g, '');

  let travelDate = new Date().toISOString().slice(0, 10);
  let returnDate: string | null = null;
  let duration = String(PLANNER_FLEXIBLE_DEFAULT_DAYS);
  let isFlexibleDates = input.when_mode === 'flexible';
  let flexibleMonthNote: string | null = null;

  if (input.when_mode === 'specific' && input.travel_date) {
    isFlexibleDates = false;
    travelDate = String(input.travel_date).slice(0, 10);
    if (input.travel_end_date) {
      const start = new Date(`${travelDate}T12:00:00`);
      const end = new Date(`${String(input.travel_end_date).slice(0, 10)}T12:00:00`);
      if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end >= start) {
        const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
        duration = String(days);
        returnDate = String(input.travel_end_date).slice(0, 10);
      } else {
        duration = String(PLANNER_FLEXIBLE_DEFAULT_DAYS);
        returnDate = addDaysIsoDate(travelDate, PLANNER_FLEXIBLE_DEFAULT_DAYS - 1);
      }
    } else {
      duration = String(PLANNER_FLEXIBLE_DEFAULT_DAYS);
      returnDate = addDaysIsoDate(travelDate, PLANNER_FLEXIBLE_DEFAULT_DAYS - 1);
    }
  } else if (input.flexible_year != null && input.flexible_month != null) {
    const monthIndex = Number(input.flexible_month);
    const year = Number(input.flexible_year);
    const monthLabel = PLANNER_MONTH_LABELS[monthIndex] || 'Flexible';
    if (
      Number.isFinite(year) &&
      Number.isFinite(monthIndex) &&
      monthIndex >= 0 &&
      monthIndex <= 11
    ) {
      const month = String(monthIndex + 1).padStart(2, '0');
      travelDate = `${year}-${month}-01`;
      duration = String(PLANNER_FLEXIBLE_DEFAULT_DAYS);
      returnDate = addDaysIsoDate(travelDate, PLANNER_FLEXIBLE_DEFAULT_DAYS - 1);
      flexibleMonthNote = `Tentative month: ${monthLabel} ${year}`;
    } else {
      duration = String(PLANNER_FLEXIBLE_DEFAULT_DAYS);
      returnDate = addDaysIsoDate(travelDate, PLANNER_FLEXIBLE_DEFAULT_DAYS - 1);
      flexibleMonthNote = 'Tentative travel dates';
    }
  } else {
    returnDate = addDaysIsoDate(travelDate, PLANNER_FLEXIBLE_DEFAULT_DAYS - 1);
  }

  const budgetLabel = String(input.budget_tier_label || input.budget_tier_id || '').trim();
  const crmBudget = mapPlannerBudgetTier(input.budget_tier_id);
  const tourRegion = resolvePlannerTourRegion(destinations);

  const market = String(input.market || 'in').trim().toLowerCase();
  const departureCity = market === 'au' ? 'Australia (Web)' : 'India (Web)';

  if (digitsOnly.length < 7) {
    // eslint-disable-next-line no-console
    console.warn('[planner-lead] profile phone missing — CRM forward skipped', {
      user_id: input.user_id,
    });
    return { success: true, forwarded: false };
  }

  const userRateKey = `planner:${input.user_id}`;
  const userRate = consumeSlidingWindowRateLimit(
    enquiryIpRateMap,
    userRateKey,
    3,
    ENQUIRY_RATE_WINDOW_MS
  );
  if (!userRate.allowed) {
    return { success: true, forwarded: false };
  }

  const plannerDedupeKey = [
    input.user_id,
    destinations.toLowerCase(),
    travelDate,
    input.when_mode || '',
    duration,
    adults,
    children,
    roomCount,
    JSON.stringify(rooms),
    crmBudget,
  ].join('|');
  const lastPlannerForward = plannerLeadDedupeMap.get(plannerDedupeKey);
  if (lastPlannerForward && Date.now() - lastPlannerForward < PLANNER_LEAD_DEDUPE_WINDOW_MS) {
    return { success: true, forwarded: false, deduplicated: true };
  }

  // eslint-disable-next-line no-console
  console.info('[planner-lead] forwarding to CRM', {
    user_id: input.user_id,
    destination: destinations,
    adults,
    children,
    rooms: roomCount,
  });

  try {
    await forwardEnquiryToCrm25({
      tour_id: 0,
      departure_id: null,
      name,
      phone: phoneRaw,
      email: String(input.email || '').trim() || null,
      departure_city: departureCity,
      travel_date: travelDate,
      return_date: returnDate,
      destination: destinations,
      duration,
      adults,
      children,
      infants: 0,
      rooms: roomCount,
      room_details: rooms.map((room) => ({
        adults: Number(room.adults || 0),
        children: Number(room.children || 0),
        child_ages: Array.isArray(room.child_ages)
          ? room.child_ages.map((age) => Number(age)).filter((age) => Number.isFinite(age))
          : [],
      })),
      page_url: String(input.page_url || '').trim() || undefined,
      enquiry_type: 'Tour Package',
      source: 'Trip Planner',
      services: ['Tour Package'],
      tour_region: tourRegion,
      budget: crmBudget,
      is_flexible_dates: isFlexibleDates,
      nationality: null,
      ip_address: input.ip_address,
      user_agent: input.user_agent,
      occupancy_notes: [
        flexibleMonthNote,
        budgetLabel ? `Budget tier: ${budgetLabel}` : null,
      ]
        .filter(Boolean)
        .join(' | ') || undefined,
    });
    plannerLeadDedupeMap.set(plannerDedupeKey, Date.now());
    // eslint-disable-next-line no-console
    console.info('[planner-lead] CRM forward success');
    return { success: true, forwarded: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[planner-lead] CRM forward failed', err);
    return { success: true, forwarded: false };
  }
}

