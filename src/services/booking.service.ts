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

