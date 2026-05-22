import { supabase } from '../lib/supabase';

export type CmsDeparture = {
  id?: number;
  city: string;
  start_date: string;
  end_date: string;
  price: number;
};

export async function listTourDepartures(tourId: number): Promise<CmsDeparture[]> {
  const { data, error } = await supabase
    .from('departures')
    .select('id,tour_id,city,start_date,end_date,price')
    .eq('tour_id', tourId)
    .order('start_date', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map((row) => ({
    id: Number(row.id),
    city: String(row.city || '').trim(),
    start_date: String(row.start_date || '').slice(0, 10),
    end_date: String(row.end_date || '').slice(0, 10),
    price: Number(row.price) || 0,
  }));
}

export async function replaceTourDepartures(tourId: number, rows: CmsDeparture[]): Promise<CmsDeparture[]> {
  const { error: delErr } = await supabase.from('departures').delete().eq('tour_id', tourId);
  if (delErr) throw new Error(delErr.message);

  const cleaned = rows
    .map((r) => ({
      tour_id: tourId,
      city: r.city.trim(),
      start_date: r.start_date,
      end_date: r.end_date,
      price: Number(r.price) || 0,
    }))
    .filter((r) => r.city && r.start_date && r.end_date && r.price > 0);

  if (!cleaned.length) return [];

  const { data, error } = await supabase.from('departures').insert(cleaned).select('id,tour_id,city,start_date,end_date,price');
  if (error) throw new Error(error.message);
  return (data || []).map((row) => ({
    id: Number(row.id),
    city: String(row.city || ''),
    start_date: String(row.start_date || '').slice(0, 10),
    end_date: String(row.end_date || '').slice(0, 10),
    price: Number(row.price) || 0,
  }));
}
