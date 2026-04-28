import { supabase } from '../lib/supabase';
import { enqueueCrmBookingSync } from '../jobs/crm.job';
import { env } from '../config/env';

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
  travellers: TravellerInput[];
  manual_cost_summary?: {
    currency: 'INR';
    single: { per_adult: number; adults: number; children: Array<{ age: number; price: number }> };
    double: { per_adult: number; adults: number; children: Array<{ age: number; price: number }> };
    triple: { per_adult: number; adults: number; children: Array<{ age: number; price: number }> };
    quad: { per_adult: number; adults: number; children: Array<{ age: number; price: number }> };
  } | null;
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

  const { data: departure, error: departureError } = await supabase
    .from('departures')
    .select('id,tour_id,price')
    .eq('id', input.departure_id)
    .eq('tour_id', input.tour_id)
    .single();

  if (departureError || !departure) {
    throw new Error('Invalid departure selected for this tour.');
  }

  const adults = Number(input.adults || 0);
  const children = Number(input.children || 0);
  const infants = Number(input.infants || 0);

  // Minimal price calculation for MVP
  const perPaxPrice = Number(departure.price || 0);
  const totalPrice = perPaxPrice * (adults + children + infants);

  const bookingBaseInsert = {
    tour_id: input.tour_id,
    departure_id: input.departure_id,
    total_price: totalPrice,
    status: 'pending',
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

  if (bookingError || !booking) {
    throw new Error(`Failed to create booking: ${bookingError?.message || 'Unknown error'}`);
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

  const { data: travellers, error: travellersError } = await supabase
    .from('travellers')
    .insert(travellerRows)
    .select('id,booking_id,traveller_type,salutation,first_name,last_name,phone,email,pan');

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
    try {
      // eslint-disable-next-line no-console
      console.info('[tour-enquiry] forwarding to CRM', {
        tourId: input.tour_id,
        destination: String(input.destination || '').trim() || null,
        hasLink: Boolean(String(input.page_url || '').trim()),
      });
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

