import { supabase } from '../lib/supabase';
import { resolveStorefront, type PaymentStorefront } from '../lib/payment-storefront';
import { normalizeDestinationSlug } from '../lib/destination-slug';

export type CmsOrderRow = {
  id: number;
  created_at: string;
  market: PaymentStorefront;
  tour_id: number | null;
  tour_title: string;
  destination: string | null;
  destination_slug: string | null;
  traveller_name: string | null;
  traveller_email: string | null;
  traveller_phone: string | null;
  total_price: number | null;
  payment_amount: number | null;
  display_currency: string | null;
  payment_status: string | null;
  status: string | null;
  mts_id: string | null;
};

export type CmsDestinationOrderStat = {
  destination: string;
  destination_slug: string | null;
  booking_count: number;
  booking_count_in: number;
  booking_count_au: number;
};

function resolveBookingMarket(row: {
  display_currency?: string | null;
  payment_currency?: string | null;
}): PaymentStorefront {
  const currency = String(row.payment_currency || row.display_currency || '').toUpperCase().trim();
  return resolveStorefront(currency === 'AUD' ? 'AUD' : currency || 'INR');
}

function travellerLabel(parts: {
  salutation?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}): string | null {
  const name = [parts.salutation, parts.first_name, parts.last_name]
    .map((p) => String(p || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  return name || null;
}

async function loadBookingsRaw() {
  const tries = [
    'id,created_at,tour_id,total_price,payment_amount,display_currency,payment_currency,payment_status,status,mts_id,tour:tours(id,title,destination,destination_ref:destinations(name,slug))',
    'id,created_at,tour_id,total_price,payment_amount,display_currency,payment_status,status,mts_id,tour:tours(id,title,destination,destination_ref:destinations(name,slug))',
    'id,created_at,tour_id,total_price,payment_amount,display_currency,payment_status,status,tour:tours(id,title,destination)',
    'id,created_at,tour_id,total_price,payment_status,status,tour:tours(id,title,destination)',
  ];
  for (const cols of tries) {
    const { data, error } = await supabase
      .from('bookings')
      .select(cols)
      .order('created_at', { ascending: false })
      .limit(500);
    if (!error) return (data || []) as unknown as Record<string, unknown>[];
    if (!/column .* does not exist|schema cache/i.test(String(error.message || ''))) {
      throw new Error(error.message);
    }
  }
  throw new Error('Failed to load bookings for CMS orders.');
}

async function loadTravellersByBookingId(bookingIds: number[]) {
  const map = new Map<
    number,
    { name: string | null; email: string | null; phone: string | null }
  >();
  if (!bookingIds.length) return map;

  const tries = [
    'booking_id,salutation,first_name,last_name,email,phone',
    'booking_id,first_name,last_name,email,phone',
    'booking_id,first_name,last_name,email',
  ];
  for (const cols of tries) {
    const { data, error } = await supabase
      .from('travellers')
      .select(cols)
      .in('booking_id', bookingIds)
      .order('id', { ascending: true });
    if (error) {
      if (/column .* does not exist|schema cache/i.test(String(error.message || ''))) continue;
      throw new Error(error.message);
    }
    for (const row of data || []) {
      const bookingId = Number((row as { booking_id?: number }).booking_id);
      if (!Number.isFinite(bookingId) || map.has(bookingId)) continue;
      map.set(bookingId, {
        name: travellerLabel(row as { salutation?: string; first_name?: string; last_name?: string }),
        email: String((row as { email?: string }).email || '').trim() || null,
        phone: String((row as { phone?: string }).phone || '').trim() || null,
      });
    }
    return map;
  }
  return map;
}

export async function listCmsOrders(): Promise<{
  orders: CmsOrderRow[];
  destination_stats: CmsDestinationOrderStat[];
}> {
  const raw = await loadBookingsRaw();
  const bookingIds = raw
    .map((row) => Number(row.id))
    .filter((id) => Number.isFinite(id));
  const travellers = await loadTravellersByBookingId(bookingIds);

  const orders: CmsOrderRow[] = raw.map((row) => {
    const id = Number(row.id);
    const tour = (row.tour || null) as {
      id?: number;
      title?: string | null;
      destination?: string | null;
      destination_ref?: { name?: string | null; slug?: string | null } | null;
    } | null;
    const traveller = travellers.get(id);
    const destination =
      tour?.destination_ref?.name?.trim() || tour?.destination?.trim() || null;
    const destinationSlug = tour?.destination_ref?.slug
      ? normalizeDestinationSlug(String(tour.destination_ref.slug))
      : destination
        ? normalizeDestinationSlug(destination)
        : null;

    return {
      id,
      created_at: String(row.created_at || ''),
      market: resolveBookingMarket(row as { display_currency?: string; payment_currency?: string }),
      tour_id: tour?.id != null ? Number(tour.id) : Number(row.tour_id) || null,
      tour_title: String(tour?.title || '—').trim() || '—',
      destination,
      destination_slug: destinationSlug,
      traveller_name: traveller?.name ?? null,
      traveller_email: traveller?.email ?? null,
      traveller_phone: traveller?.phone ?? null,
      total_price: row.total_price != null ? Number(row.total_price) : null,
      payment_amount: row.payment_amount != null ? Number(row.payment_amount) : null,
      display_currency: row.display_currency != null ? String(row.display_currency) : null,
      payment_status: row.payment_status != null ? String(row.payment_status) : null,
      status: row.status != null ? String(row.status) : null,
      mts_id: row.mts_id != null ? String(row.mts_id) : null,
    };
  });

  const statMap = new Map<string, CmsDestinationOrderStat>();
  for (const order of orders) {
    const key = order.destination?.trim() || 'Unknown';
    const slug = order.destination_slug;
    const existing = statMap.get(key) || {
      destination: key,
      destination_slug: slug,
      booking_count: 0,
      booking_count_in: 0,
      booking_count_au: 0,
    };
    existing.booking_count += 1;
    if (order.market === 'au') existing.booking_count_au += 1;
    else existing.booking_count_in += 1;
    if (!existing.destination_slug && slug) existing.destination_slug = slug;
    statMap.set(key, existing);
  }

  const destination_stats = [...statMap.values()].sort((a, b) => {
    if (b.booking_count !== a.booking_count) return b.booking_count - a.booking_count;
    return a.destination.localeCompare(b.destination);
  });

  return { orders, destination_stats };
}

export async function deleteCmsOrder(id: number): Promise<void> {
  const bookingId = Math.floor(Number(id));
  if (!Number.isFinite(bookingId) || bookingId <= 0) {
    throw new Error('Invalid order id.');
  }

  const existing = await supabase.from('bookings').select('id').eq('id', bookingId).maybeSingle();
  if (existing.error) {
    throw new Error(existing.error.message || `Failed to look up order #${bookingId}.`);
  }
  if (!existing.data) {
    throw new Error(`Order #${bookingId} was not found.`);
  }

  // Clear dependent rows first (FK-safe). Ignore schema-missing tables.
  const childDeletes = ['travellers', 'booking_transactions'] as const;
  for (const table of childDeletes) {
    const { error } = await supabase.from(table).delete().eq('booking_id', bookingId);
    if (error && !/relation .* does not exist|schema cache|column .* does not exist/i.test(String(error.message || ''))) {
      throw new Error(`Could not remove ${table} for order #${bookingId}: ${error.message}`);
    }
  }

  const { error } = await supabase.from('bookings').delete().eq('id', bookingId);
  if (error) {
    throw new Error(error.message || `Failed to delete order #${bookingId}.`);
  }
}
