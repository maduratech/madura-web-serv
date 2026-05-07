import { supabase } from '../lib/supabase';
import { enqueueCrmBookingSync } from '../jobs/crm.job';
import { env } from '../config/env';
import crypto from 'node:crypto';
import Razorpay from 'razorpay';

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
  departure_id: number;
  adults: number;
  children: number;
  infants: number;
  /** Optional: stored when `bookings.rooms` / `bookings.room_details` exist (for CRM payment notes). */
  rooms?: number;
  room_details?: Array<{ adults: number; children: number; child_ages?: number[] }>;
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
  if (cur === 'USD') display = `$${converted.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
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
  room_details?: Array<{ adults: number; children: number; child_ages?: number[] }>;
  tour_title?: string;
  page_url?: string;
  ip_address?: string;
  user_agent?: string;
  /** Optional: auth.users id when the enquiry is filed by a signed-in customer (P2). */
  user_id?: string;
};

export type CreateWebsiteLeadInput = {
  name: string;
  phone: string;
  destination: string;
  tour_id?: number;
  ip_address?: string;
  user_agent?: string;
};

const enquiryIpRateMap = new Map<string, number[]>();
const enquiryPhoneRateMap = new Map<string, number[]>();
const ENQUIRY_RATE_WINDOW_MS = 10 * 60 * 1000; // 10 min
const ENQUIRY_IP_RATE_MAX = 12;
const ENQUIRY_PHONE_RATE_MAX = 5;
const DOMESTIC_ADVANCE_AMOUNT_INR = 1000;
const SEA_MIDDLE_EAST_ADVANCE_AMOUNT_INR = 3000;
const INTERNATIONAL_ADVANCE_AMOUNT_INR = 5000;

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

const razorpayClient = new Razorpay({
  key_id: env.RAZORPAY_KEY_ID || '',
  key_secret: env.RAZORPAY_KEY_SECRET || '',
});

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

function getAdvanceAmountInInr(resolvedRegion: 'domestic' | 'sea_middle_east' | 'international') {
  if (resolvedRegion === 'domestic') return DOMESTIC_ADVANCE_AMOUNT_INR;
  if (resolvedRegion === 'sea_middle_east') return SEA_MIDDLE_EAST_ADVANCE_AMOUNT_INR;
  return INTERNATIONAL_ADVANCE_AMOUNT_INR;
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

type DestinationRow = { id: number; name: string };
type DepartureCityRow = { name: string };
type DestinationShowcaseRow = {
  id: number;
  name: string;
  slug?: string | null;
  destination_type?: string | null;
  parent_id?: number | null;
  continent?: string | null;
  image_url?: string | null;
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
  departure_city?: { name?: string | null } | null;
};

type ListingTourRow = {
  id: number;
  title: string;
  flow_type: 'enquiry' | 'booking' | 'both';
  destination?: string | null;
  tour_includes?: string[] | null;
  twin_sharing_price?: number | null;
  triple_sharing_price?: number | null;
  single_sharing_price?: number | null;
  child_with_bed_price?: number | null;
  child_without_bed_price?: number | null;
  destination_ref?: { name?: string | null; slug?: string | null; image_url?: string | null } | null;
  departures?: Array<{
    price?: number | null;
    start_date?: string | null;
    end_date?: string | null;
    city?: string | null;
    departure_city?: { name?: string | null } | null;
  }> | null;
};

export async function getDestinations() {
  const { data, error } = await supabase
    .from('destinations')
    .select('id,name')
    .order('name', { ascending: true });

  if (error) {
    throw new Error(`Failed to fetch destinations: ${error.message}`);
  }

  return (data || []) as DestinationRow[];
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

export async function getDestinationShowcase() {
  const [{ data: destinations, error: destinationsError }, { data: tours, error: toursError }, { data: departures, error: departuresError }] =
    await Promise.all([
      supabase
        .from('destinations')
        .select('id,name,slug,destination_type,parent_id,continent,image_url')
        .order('name', { ascending: true }),
      supabase.from('tours').select('id,destination_id,destination,title'),
      supabase.from('departures').select('tour_id,price'),
    ]);

  if (destinationsError) {
    throw new Error(`Failed to fetch destination showcase: ${destinationsError.message}`);
  }
  if (toursError) {
    throw new Error(`Failed to fetch tours for showcase: ${toursError.message}`);
  }
  if (departuresError) {
    throw new Error(`Failed to fetch departures for showcase: ${departuresError.message}`);
  }

  const allDestinations = (destinations || []) as DestinationShowcaseRow[];
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
        slug: d.slug || d.name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-'),
        continent,
        image_url:
          d.image_url ||
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
  const { data, error } = await supabase
    .from('tours')
    .select('id,title,flow_type,destination,destination_ref:destinations(name)')
    .order('title', { ascending: true });

  if (error && !String(error.message || '').includes('destinations')) {
    throw new Error(`Failed to fetch tours: ${error.message}`);
  }

  const rows = ((data || []) as TourRow[]).map((row) => ({
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

export async function getToursListing() {
  let data: ListingTourRow[] | null = null;
  let error: { message: string } | null = null;

  const withDedicatedPricing = await supabase
    .from('tours')
    .select(
      'id,title,flow_type,destination,tour_includes,twin_sharing_price,triple_sharing_price,single_sharing_price,child_with_bed_price,child_without_bed_price,destination_ref:destinations(name,slug,image_url),departures(price,start_date,end_date,city,departure_city:departure_cities(name))'
    )
    .order('title', { ascending: true });

  data = (withDedicatedPricing.data || []) as ListingTourRow[];
  error = withDedicatedPricing.error;

  // Backward compatible fallback until dedicated columns exist in all environments.
  if (error && /column .* does not exist/i.test(String(error.message || ''))) {
    const fallback = await supabase
      .from('tours')
      .select(
        'id,title,flow_type,destination,tour_includes,destination_ref:destinations(name,slug,image_url),departures(price,start_date,end_date,city,departure_city:departure_cities(name))'
      )
      .order('title', { ascending: true });
    data = (fallback.data || []) as ListingTourRow[];
    error = fallback.error;
  }

  if (error) {
    throw new Error(`Failed to fetch tours listing: ${error.message}`);
  }

  const rows = (data || []) as ListingTourRow[];
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
    } else {
      durationNights = 3 + (row.id % 5);
    }

    const derivedTwin = prices.length ? Math.min(...prices) : null;
    const startingTwin = row.twin_sharing_price ?? derivedTwin;
    const startingTriple = row.triple_sharing_price ?? (startingTwin ? Math.round(startingTwin * 0.9) : null);
    const startingSingle = row.single_sharing_price ?? null;
    const startingChildWithBed = row.child_with_bed_price ?? null;
    const startingChildWithoutBed = row.child_without_bed_price ?? null;
    const destination = row.destination_ref?.name || row.destination || 'Unknown';
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
      flow_type: row.flow_type,
      destination,
      destination_slug: row.destination_ref?.slug || toSlug(destination),
      image_url:
        row.destination_ref?.image_url ||
        'https://images.unsplash.com/photo-1488646953014-85cb44e25828?auto=format&fit=crop&w=900&q=80',
      duration_nights: durationNights,
      tour_category: inferCategory(row.title),
      theme: inferTheme(row.title),
      tour_type: row.flow_type === 'booking' ? 'Group Package' : 'Customizable',
      starting_from_twin: startingTwin,
      starting_from_triple: startingTriple,
      starting_from_single: startingSingle,
      starting_from_child_with_bed: startingChildWithBed,
      starting_from_child_without_bed: startingChildWithoutBed,
      departure_cities: departureCities,
      tour_includes: Array.isArray(row.tour_includes) ? row.tour_includes : [],
    };
  });
}

export async function getTourDepartures(tourId: number) {
  const { data, error } = await supabase
    .from('departures')
    .select('id,tour_id,city,start_date,end_date,price,departure_city:departure_cities(name)')
    .eq('tour_id', tourId)
    .order('start_date', { ascending: true });

  if (error && !String(error.message || '').includes('departure_cities')) {
    throw new Error(`Failed to fetch departures: ${error.message}`);
  }

  return ((data || []) as DepartureRow[]).map((row) => ({
    id: row.id,
    tour_id: row.tour_id,
    city: row.departure_city?.name || row.city || 'Unknown',
    start_date: row.start_date,
    end_date: row.end_date,
    price: row.price,
  }));
}

function validateCreateBookingPayload(input: CreateBookingInput): void {
  if (!input.tour_id || !input.departure_id) {
    throw new Error('tour_id and departure_id are required.');
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

  let { data: departure, error: departureError } = await supabase
    .from('departures')
    .select('id,tour_id,price')
    .eq('id', input.departure_id)
    .eq('tour_id', input.tour_id)
    .single();

  if (departureError || !departure) {
    const fallback = await supabase
      .from('departures')
      .select('id,tour_id,price')
      .eq('id', input.departure_id)
      .single();
    if (fallback.error || !fallback.data) {
      throw new Error('Invalid departure selected for this tour.');
    }
    departure = fallback.data;
    // eslint-disable-next-line no-console
    console.warn('[createBooking] departure tour mismatch, using departure.tour_id', {
      requestedTourId: input.tour_id,
      departureId: input.departure_id,
      resolvedTourId: departure.tour_id,
    });
  }
  const effectiveTourId = Number(departure.tour_id || input.tour_id);

  const adults = Number(input.adults || 0);
  const children = Number(input.children || 0);
  const infants = Number(input.infants || 0);

  // Minimal price calculation for MVP
  const perPaxPrice = Number(departure.price || 0);
  const totalPrice = perPaxPrice * (adults + children + infants);

  const bookingBaseInsert = {
    tour_id: effectiveTourId,
    departure_id: input.departure_id,
    total_price: totalPrice,
    status: 'pending',
  };
  const bookingBaseInsertUpperStatus = {
    ...bookingBaseInsert,
    status: 'Pending',
  };

  type BookingRow = { id: number; tour_id: number; departure_id: number; total_price: number; status: string };
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
    throw new Error(`Failed to create booking: ${bookingError?.message || 'Unknown error'}`);
  }

  const roomPatch: Record<string, unknown> = {};
  if (Number(input.rooms) > 0) roomPatch.rooms = Number(input.rooms);
  if (Array.isArray(input.room_details) && input.room_details.length > 0) {
    roomPatch.room_details = input.room_details;
  }
  const displayCurrencyClean = String(input.display_currency || '').toUpperCase().trim();
  if (displayCurrencyClean && displayCurrencyClean !== 'INR') {
    roomPatch.display_currency = displayCurrencyClean;
    if (Number(input.display_fx_rate) > 0) {
      roomPatch.display_fx_rate = Number(input.display_fx_rate);
    }
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

function buildTravellersAndRoomsCrmNote(
  travellers: TravellerRowForNote[],
  rooms: number | null | undefined,
  roomDetails: Array<{ adults?: number; children?: number; child_ages?: number[] }> | null | undefined
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
      lines.push(`Room ${idx + 1}: ${a} Adult(s), ${c} Child(ren)${agePart}`);
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

  const [{ data: tour }, { data: departure }] = await Promise.all([
    supabase
      .from('tours')
      .select('id,title,destination,tour_region,destination_ref:destinations(name,continent)')
      .eq('id', Number(booking.tour_id))
      .maybeSingle(),
    supabase
      .from('departures')
      .select('id,city,start_date,end_date')
      .eq('id', Number(booking.departure_id))
      .maybeSingle(),
  ]);

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
  const formatInr = (amount: number) => formatInrDual(amount, displayCurrency, displayFxRate);

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
    travellersRoomsNote,
    displayCurrency,
    displayFxRate,
    formatInr,
  };
}

export async function createBookingPaymentOrder(input: CreateBookingPaymentOrderInput) {
  if (!input.booking_id) throw new Error('booking_id is required.');
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay credentials are not configured.');
  }

  const context = await getBookingPaymentContext(input.booking_id);
  const resolvedRegion = resolveTourRegionFromData(context.tourRegion, context.destination, context.continent);
  const advanceAmountInInr = getAdvanceAmountInInr(resolvedRegion);

  const order = await razorpayClient.orders.create({
    amount: advanceAmountInInr * 100,
    currency: 'INR',
    receipt: `booking_${context.booking.id}_${Date.now()}`,
    notes: {
      booking_id: String(context.booking.id),
      destination: context.destination || 'N/A',
      tour_title: context.tourTitle || 'N/A',
      region: resolvedRegion,
    },
  });

  try {
    await upsertBookingPaymentFields(context.booking.id, {
      payment_status: 'pending',
      payment_order_id: order.id,
      payment_amount: advanceAmountInInr,
      payment_currency: 'INR',
      payment_notes: `Payment initiated via Razorpay order ${order.id}`,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[payment-order] booking payment field update failed:', err);
  }

  return {
    booking: context.booking,
    razorpay_key_id: env.RAZORPAY_KEY_ID,
    razorpay_order_id: order.id,
    amount: advanceAmountInInr * 100,
    currency: 'INR',
    slab_region: resolvedRegion,
    description: `Advance payment for ${context.tourTitle || context.destination || 'your tour'}`,
  };
}

export async function verifyBookingPayment(input: VerifyBookingPaymentInput) {
  if (!input.booking_id || !input.razorpay_order_id || !input.razorpay_payment_id || !input.razorpay_signature) {
    throw new Error('booking_id, razorpay_order_id, razorpay_payment_id and razorpay_signature are required.');
  }
  const expectedSignature = crypto
    .createHmac('sha256', String(env.RAZORPAY_KEY_SECRET || ''))
    .update(`${input.razorpay_order_id}|${input.razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== input.razorpay_signature) {
    throw new Error('Invalid payment signature.');
  }

  const context = await getBookingPaymentContext(input.booking_id);
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
  let paidAmountInInr = Number((context.booking as { payment_amount?: number | null })?.payment_amount || 0);
  let paymentCurrency = 'INR';
  let paidAtIso = new Date().toISOString();
  let razorpayBankRrn = '';
  let razorpayDescription = '';
  try {
    const payment = (await razorpayClient.payments.fetch(input.razorpay_payment_id)) as {
      amount?: number;
      currency?: string;
      created_at?: number;
      acquirer_data?: { rrn?: string };
      description?: string;
    };
    if (Number.isFinite(Number(payment?.amount || 0)) && Number(payment?.amount || 0) > 0) {
      paidAmountInInr = Number(payment.amount) / 100;
    }
    paymentCurrency = String(payment?.currency || 'INR').toUpperCase();
    if (Number.isFinite(Number(payment?.created_at || 0)) && Number(payment?.created_at || 0) > 0) {
      paidAtIso = new Date(Number(payment.created_at) * 1000).toISOString();
    }
    razorpayBankRrn = String(payment?.acquirer_data?.rrn || '').trim();
    razorpayDescription = String(payment?.description || '').trim();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[payment-verify] unable to fetch Razorpay payment details, using booking fallback:', err);
  }
  const fullAmountInInr = Number((context.booking as { total_price?: number | null })?.total_price || 0);
  const remainingAmountInInr = Math.max(0, fullAmountInInr - paidAmountInInr);
  const advanceSlabInInr = Number((context.booking as { payment_amount?: number | null })?.payment_amount || 0);
  const customerCurrencyLine = context.displayCurrency
    ? `\nCustomer Display Currency: ${context.displayCurrency}${context.displayFxRate ? ` (1 INR ≈ ${(1 / context.displayFxRate).toFixed(6)} ${context.displayCurrency} | 1 ${context.displayCurrency} ≈ INR ${context.displayFxRate})` : ''}`
    : '';
  const paymentCurrencyAmount =
    paymentCurrency && paymentCurrency !== 'INR'
      ? `${paymentCurrency} ${Number(paidAmountInInr || 0).toLocaleString('en-IN')}`
      : context.formatInr(paidAmountInInr);
  const detailsNote =
    `Payment Status: SUCCESS\n` +
    `Booking ID: ${context.booking.id}\n` +
    `Razorpay Order ID: ${input.razorpay_order_id}\n` +
    `Razorpay Payment ID: ${input.razorpay_payment_id}\n` +
    `Amount Paid: ${paymentCurrencyAmount}\n` +
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
      payment_status: 'paid',
      payment_order_id: input.razorpay_order_id,
      payment_id: input.razorpay_payment_id,
      payment_amount: paidAmountInInr,
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
      amount: Number(paidAmountInInr || 0),
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
      amount: Number(paidAmountInInr || 0),
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
    payment_status: 'paid',
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
  const webhookSecret = String(env.RAZORPAY_WEBHOOK_SECRET || '');
  if (!signature || !webhookSecret) {
    throw new Error('Webhook signature validation failed.');
  }
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  if (expected !== signature) {
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
    await verifyBookingPayment({
      booking_id: booking.id,
      razorpay_order_id: orderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: crypto
        .createHmac('sha256', String(env.RAZORPAY_KEY_SECRET || ''))
        .update(`${orderId}|${paymentId}`)
        .digest('hex'),
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
  const noteContent = hasTourTitle
    ? `Customer needs assistance for the tour booking - "${String(input.tour_title || '').trim()}". Link: ${String(input.page_url || '').trim() || 'Not provided'}`
    : `Customer needs assistance for the ${input.destination || 'selected'} tour booking.`;
  const basePayload = {
    name: input.name,
    phone: input.phone,
    email: input.email || undefined,
    destination: input.destination || undefined,
    duration: input.duration || undefined,
    date_of_travel: input.travel_date,
    date: input.travel_date,
    travel_date: input.travel_date,
    enquiry: 'Tour Package',
    services: ['Tour Package'],
    starting_point: input.departure_city,
    summary: `Website enquiry for ${input.destination || 'tour'} | ${input.duration || 'duration not specified'} | ${input.adults}A/${input.children}C | Rooms: ${input.rooms}`,
    source: 'website',
    adults: input.adults,
    children: input.children,
    babies: input.infants || 0,
    travelers: input.adults,
    passengers: input.adults,
    rooms: input.rooms,
    room_details: normalizedRoomDetails,
    children_ages: normalizedChildAges,
    notes: [
      {
        type: 'note',
        content: noteContent,
        timestamp: new Date().toISOString(),
      },
    ],
  };

  const sourceCandidates: Array<string | null> = ['website', 'Website', 'WEB', null];
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
  try {
    await forwardEnquiryToCrm25({
      tour_id: Number(input.tour_id || 0),
      departure_id: null,
      name: String(input.name || '').trim(),
      phone: normalizedPhone,
      email: null,
      departure_city: 'Website',
      travel_date: today,
      destination: String(input.destination || '').trim(),
      duration: '',
      adults: 1,
      children: 0,
      infants: 0,
      rooms: 1,
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

