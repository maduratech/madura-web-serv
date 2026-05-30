import { supabase } from '../lib/supabase';

export type TourTaxonomyKind = 'tour_type' | 'tour_experience';

export type TourTaxonomyRow = {
  id: number;
  kind: TourTaxonomyKind;
  label: string;
  sort_order: number;
  created_at: string;
};

function isMissingTaxonomyTable(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('cms_tour_taxonomy') &&
    (m.includes('does not exist') || m.includes('could not find') || m.includes('schema cache'))
  );
}

function normalizeKind(raw: string): TourTaxonomyKind {
  const kind = String(raw || '').trim();
  if (kind === 'tour_type' || kind === 'tour_experience') return kind;
  throw new Error('Invalid taxonomy kind.');
}

function normalizeLabel(raw: string): string {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

export async function listTourTaxonomy(kind: TourTaxonomyKind): Promise<TourTaxonomyRow[]> {
  const { data, error } = await supabase
    .from('cms_tour_taxonomy')
    .select('id,kind,label,sort_order,created_at')
    .eq('kind', kind)
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  if (error) {
    if (isMissingTaxonomyTable(error.message)) return [];
    throw new Error(error.message);
  }
  return (data || []) as TourTaxonomyRow[];
}

export async function addTourTaxonomy(kind: TourTaxonomyKind, label: string): Promise<TourTaxonomyRow> {
  const trimmed = normalizeLabel(label);
  if (!trimmed) throw new Error('Label is required.');

  const existing = await supabase
    .from('cms_tour_taxonomy')
    .select('id,kind,label,sort_order,created_at')
    .eq('kind', kind)
    .ilike('label', trimmed)
    .maybeSingle();
  if (existing.error && !isMissingTaxonomyTable(existing.error.message)) {
    throw new Error(existing.error.message);
  }
  if (existing.data) return existing.data as TourTaxonomyRow;

  const { data, error } = await supabase
    .from('cms_tour_taxonomy')
    .insert({ kind, label: trimmed, sort_order: 0 })
    .select('id,kind,label,sort_order,created_at')
    .single();
  if (error) {
    if (isMissingTaxonomyTable(error.message)) {
      throw new Error('Tour taxonomy table is missing. Run sql/cms_tour_taxonomy.sql on Supabase.');
    }
    throw new Error(error.message);
  }
  return data as TourTaxonomyRow;
}

export async function deleteTourTaxonomy(id: number): Promise<void> {
  const { error } = await supabase.from('cms_tour_taxonomy').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function ensureTourTaxonomyFromMeta(meta: {
  tour_type?: string | null;
  tour_experience?: string | null;
}): Promise<void> {
  const typeLabel = normalizeLabel(meta.tour_type || '');
  const experienceLabel = normalizeLabel(meta.tour_experience || '');
  try {
    if (typeLabel) await addTourTaxonomy('tour_type', typeLabel);
    if (experienceLabel) await addTourTaxonomy('tour_experience', experienceLabel);
  } catch (err) {
    if (err instanceof Error && isMissingTaxonomyTable(err.message)) return;
    throw err;
  }
}

export function parseTourTaxonomyKindParam(raw: string): TourTaxonomyKind {
  return normalizeKind(raw);
}
