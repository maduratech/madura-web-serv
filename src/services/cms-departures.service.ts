import { supabase } from '../lib/supabase';
import { childPricesFromDb, childPricesToDb } from '../lib/tour-price-db';

export type CmsDeparture = {
  id?: number;
  city: string;
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
};

type DepartureDbRow = {
  tour_id: number;
  city: string;
  start_date: string;
  end_date: string;
  price: number;
  twin_sharing_price: number;
  triple_sharing_price: number | null;
  single_sharing_price: number | null;
  quad_sharing_price: number | null;
  infant_price?: number | null;
  child_price?: number | null;
  youth_price?: number | null;
  max_travellers: number | null;
};

type CleanedDepartureRow = DepartureDbRow & { id?: number };

const DEPARTURE_SELECT_TRIES = [
  'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,max_travellers',
  'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,infant_price,child_price,youth_price,max_travellers',
  'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,infant_price,child_price,youth_price',
  'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,child_price,youth_price',
  'id,tour_id,city,start_date,end_date,price',
];

const DEPARTURE_WRITE_TRIES = [
  'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,quad_sharing_price,infant_price,child_price,youth_price,max_travellers',
  'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,infant_price,child_price,youth_price,max_travellers',
  'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,infant_price,child_price,youth_price',
  'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,child_price,youth_price',
  'id,tour_id,city,start_date,end_date,price',
];

function mapDepartureRow(row: Record<string, unknown>): CmsDeparture {
  const legacyPrice = Number(row.price) || 0;
  const twin = Number(row.twin_sharing_price) || legacyPrice || 0;
  return {
    id: Number(row.id),
    city: String(row.city || '').trim(),
    start_date: String(row.start_date || '').slice(0, 10),
    end_date: String(row.end_date || '').slice(0, 10),
    price: twin,
    twin_sharing_price: twin || null,
    triple_sharing_price: Number(row.triple_sharing_price) || null,
    single_sharing_price: Number(row.single_sharing_price) || null,
    quad_sharing_price: Number(row.quad_sharing_price) || null,
    ...childPricesFromDb(row as Parameters<typeof childPricesFromDb>[0]),
    max_travellers: row.max_travellers != null ? Number(row.max_travellers) : null,
  };
}

function stripPayloadForColumns(row: DepartureDbRow, columns: string): Record<string, unknown> {
  if (columns.includes('twin_sharing_price')) return row;
  const legacy = row as Record<string, unknown>;
  const {
    twin_sharing_price: _twin,
    triple_sharing_price: _triple,
    single_sharing_price: _single,
    youth_price: _youth,
    child_price: _child,
    infant_price: _infant,
    max_travellers: _max,
    quad_sharing_price: _quad,
    ...rest
  } = legacy;
  return rest;
}

function cleanDepartureRows(tourId: number, rows: CmsDeparture[]): CleanedDepartureRow[] {
  return rows
    .map((r) => {
      const twin = Number(r.twin_sharing_price ?? r.price) || 0;
      const start = String(r.start_date || '').slice(0, 10);
      const endRaw = String(r.end_date || '').slice(0, 10);
      const id = r.id != null && Number(r.id) > 0 ? Number(r.id) : undefined;
      return {
        id,
        tour_id: tourId,
        city: r.city.trim(),
        start_date: start,
        end_date: endRaw || start,
        price: twin,
        twin_sharing_price: twin,
        triple_sharing_price: Number(r.triple_sharing_price) || null,
        single_sharing_price: Number(r.single_sharing_price) || null,
        quad_sharing_price: Number(r.quad_sharing_price) || null,
        ...childPricesToDb({
          infant_price: r.infant_price,
          child_price: r.child_price,
          youth_price: r.youth_price,
        }),
        max_travellers: r.max_travellers != null ? Number(r.max_travellers) : null,
      };
    })
    .filter((r) => r.city && r.start_date && r.price > 0);
}

function departureLabel(row: Record<string, unknown>): string {
  const city = String(row.city || 'Departure').trim() || 'Departure';
  const date = String(row.start_date || '').slice(0, 10);
  return date ? `${city} (${date})` : city;
}

async function selectDepartures(tourId: number) {
  let lastErr = '';
  for (const cols of DEPARTURE_SELECT_TRIES) {
    const { data, error } = await supabase
      .from('departures')
      .select(cols)
      .eq('tour_id', tourId)
      .order('start_date', { ascending: true });
    if (!error) return data || [];
    lastErr = String(error.message || '');
    if (!/column .* does not exist/i.test(lastErr)) throw new Error(lastErr);
  }
  throw new Error(lastErr || 'Failed to load departures');
}

async function countBookingsByDepartureIds(departureIds: number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (!departureIds.length) return counts;
  const { data, error } = await supabase.from('bookings').select('departure_id').in('departure_id', departureIds);
  if (error) throw new Error(error.message);
  for (const row of data || []) {
    const id = Number(row.departure_id);
    if (id > 0) counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

function blockedDepartureMessage(
  blockedIds: number[],
  existing: Record<string, unknown>[],
  bookingCounts: Map<number, number>
): string {
  const labels = existing
    .filter((row) => blockedIds.includes(Number(row.id)))
    .map((row) => departureLabel(row));
  const bookingTotal = blockedIds.reduce((sum, id) => sum + (bookingCounts.get(id) || 0), 0);
  const shown = labels.slice(0, 2).join(', ');
  const more = labels.length > 2 ? ` +${labels.length - 2} more` : '';
  const labelText = shown ? `${shown}${more}` : `${blockedIds.length} departure(s)`;
  return `Cannot remove ${labelText} — ${bookingTotal} booking(s) linked. Keep the date or cancel those bookings first.`;
}

async function updateDepartureRow(id: number, tourId: number, row: DepartureDbRow): Promise<void> {
  let lastErr = '';
  for (const cols of DEPARTURE_WRITE_TRIES) {
    const payload = stripPayloadForColumns(row, cols);
    const { error } = await supabase.from('departures').update(payload).eq('id', id).eq('tour_id', tourId);
    if (!error) return;
    lastErr = String(error.message || '');
    if (!/column .* does not exist/i.test(lastErr)) throw new Error(lastErr);
  }
  throw new Error(lastErr || 'Failed to update departure');
}

async function insertDepartureRows(rows: DepartureDbRow[]): Promise<void> {
  if (!rows.length) return;
  let lastErr = '';
  for (const returning of DEPARTURE_WRITE_TRIES) {
    const payload = rows.map((row) => stripPayloadForColumns(row, returning));
    const { error } = await supabase.from('departures').insert(payload).select(returning);
    if (!error) return;
    lastErr = String(error.message || '');
    if (!/column .* does not exist/i.test(lastErr)) throw new Error(lastErr);
  }
  throw new Error(lastErr || 'Failed to insert departures');
}

export async function listTourDepartures(tourId: number): Promise<CmsDeparture[]> {
  const data = await selectDepartures(tourId);
  return data.map((row) => mapDepartureRow(row as unknown as Record<string, unknown>));
}

/**
 * Sync departures for a tour without delete-all (bookings FK on `bookings.departure_id`).
 * Updates rows with ids, inserts new rows, deletes only removed rows that have no bookings.
 */
export async function replaceTourDepartures(tourId: number, rows: CmsDeparture[]): Promise<CmsDeparture[]> {
  const existing = await selectDepartures(tourId);
  const existingById = new Map<number, Record<string, unknown>>();
  for (const row of existing) {
    const mapped = row as unknown as Record<string, unknown>;
    const id = Number(mapped.id);
    if (id > 0) existingById.set(id, mapped);
  }
  const cleaned = cleanDepartureRows(tourId, rows);

  const incomingIds = new Set(
    cleaned.map((row) => row.id).filter((id): id is number => id != null && id > 0)
  );

  for (const id of incomingIds) {
    const row = existingById.get(id);
    if (!row || Number(row.tour_id) !== tourId) {
      throw new Error(`Departure #${id} does not belong to tour #${tourId}. Refresh the page and try again.`);
    }
  }

  const toDelete = [...existingById.keys()].filter((id) => !incomingIds.has(id));
  if (toDelete.length) {
    const bookingCounts = await countBookingsByDepartureIds(toDelete);
    const blocked = toDelete.filter((id) => (bookingCounts.get(id) || 0) > 0);
    if (blocked.length) {
      throw new Error(
        blockedDepartureMessage(
          blocked,
          existing.map((row) => row as unknown as Record<string, unknown>),
          bookingCounts
        )
      );
    }
    const { error: delErr } = await supabase.from('departures').delete().in('id', toDelete).eq('tour_id', tourId);
    if (delErr) throw new Error(delErr.message);
  }

  const toUpdate = cleaned.filter((row) => row.id != null && row.id > 0);
  const toInsert = cleaned.filter((row) => row.id == null || row.id <= 0);

  for (const row of toUpdate) {
    const { id: _id, ...payload } = row;
    await updateDepartureRow(Number(row.id), tourId, payload);
  }

  await insertDepartureRows(toInsert.map(({ id: _id, ...payload }) => payload));

  return listTourDepartures(tourId);
}
