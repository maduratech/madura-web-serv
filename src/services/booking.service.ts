import { supabase } from '../lib/supabase';
import { enqueueCrmBookingSync } from '../jobs/crm.job';

export type TravellerInput = {
  type: 'adult' | 'child' | 'infant';
  salutation: string;
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
  pan: string;
};

export type CreateBookingInput = {
  tour_id: number;
  departure_id: number;
  adults: number;
  children: number;
  infants: number;
  travellers: TravellerInput[];
};

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
  const { data, error } = await supabase
    .from('tours')
    .select(
      'id,title,flow_type,destination,destination_ref:destinations(name,slug,image_url),departures(price,start_date,end_date,city,departure_city:departure_cities(name))'
    )
    .order('title', { ascending: true });

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

    const startingTwin = prices.length ? Math.min(...prices) : null;
    const startingTriple = startingTwin ? Math.round(startingTwin * 0.9) : null;
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
      departure_cities: departureCities,
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
      !traveller.email ||
      !traveller.pan
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

  const { data: booking, error: bookingError } = await supabase
    .from('bookings')
    .insert({
      tour_id: input.tour_id,
      departure_id: input.departure_id,
      total_price: totalPrice,
      status: 'pending',
    })
    .select('id,tour_id,departure_id,total_price,status,created_at')
    .single();

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
    pan: traveller.pan,
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

