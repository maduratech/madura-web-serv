import { supabase } from '../lib/supabase';

export type CmsDeparture = {
  id?: number;
  city: string;
  start_date: string;
  end_date: string;
  price: number;
  twin_sharing_price?: number | null;
  triple_sharing_price?: number | null;
  single_sharing_price?: number | null;
  child_with_bed_price?: number | null;
  child_without_bed_price?: number | null;
  max_travellers?: number | null;
};

const DEPARTURE_SELECT_TRIES = [
  'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,child_with_bed_price,child_without_bed_price,max_travellers',
  'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,child_with_bed_price,child_without_bed_price',
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
    child_with_bed_price: Number(row.child_with_bed_price) || null,
    child_without_bed_price: Number(row.child_without_bed_price) || null,
    max_travellers: row.max_travellers != null ? Number(row.max_travellers) : null,
  };
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

export async function listTourDepartures(tourId: number): Promise<CmsDeparture[]> {
  const data = await selectDepartures(tourId);
  return data.map((row) => mapDepartureRow(row as unknown as Record<string, unknown>));
}

export async function replaceTourDepartures(tourId: number, rows: CmsDeparture[]): Promise<CmsDeparture[]> {
  const { error: delErr } = await supabase.from('departures').delete().eq('tour_id', tourId);
  if (delErr) throw new Error(delErr.message);

  const cleaned = rows
    .map((r) => {
      const twin = Number(r.twin_sharing_price ?? r.price) || 0;
      const start = String(r.start_date || '').slice(0, 10);
      const endRaw = String(r.end_date || '').slice(0, 10);
      return {
        tour_id: tourId,
        city: r.city.trim(),
        start_date: start,
        end_date: endRaw || start,
        price: twin,
        twin_sharing_price: twin,
        triple_sharing_price: Number(r.triple_sharing_price) || null,
        single_sharing_price: Number(r.single_sharing_price) || null,
        child_with_bed_price: Number(r.child_with_bed_price) || null,
        child_without_bed_price: Number(r.child_without_bed_price) || null,
        max_travellers: r.max_travellers != null ? Number(r.max_travellers) : null,
      };
    })
    .filter((r) => r.city && r.start_date && r.price > 0);

  if (!cleaned.length) return [];

  const insertTries = [
    'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,child_with_bed_price,child_without_bed_price,max_travellers',
    'id,tour_id,city,start_date,end_date,price,twin_sharing_price,triple_sharing_price,single_sharing_price,child_with_bed_price,child_without_bed_price',
    'id,tour_id,city,start_date,end_date,price',
  ];

  let lastErr = '';
  for (const returning of insertTries) {
    const payload = cleaned.map((row) => {
      if (returning.includes('twin_sharing_price')) return row;
      const { twin_sharing_price, triple_sharing_price, single_sharing_price, child_with_bed_price, child_without_bed_price, max_travellers, ...rest } = row;
      return rest;
    });
    const { data, error } = await supabase.from('departures').insert(payload).select(returning);
    if (!error) {
      return (data || []).map((row) => mapDepartureRow(row as unknown as Record<string, unknown>));
    }
    lastErr = String(error.message || '');
    if (!/column .* does not exist/i.test(lastErr)) throw new Error(lastErr);
  }
  throw new Error(lastErr || 'Failed to save departures');
}
