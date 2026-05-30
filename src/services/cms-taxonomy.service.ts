import { supabase } from '../lib/supabase';
import { splitOverviewWithMeta } from '../lib/tour-overview-meta';

export type TourTaxonomyKind = 'tour_type' | 'tour_experience';

export type TourTaxonomyRow = {
  id: number;
  kind: TourTaxonomyKind;
  label: string;
  sort_order: number;
  created_at: string;
  usage_count?: number;
};

const LEGACY_TOUR_TYPE_MAP: Record<string, string> = {
  Family: 'Family Holidays',
  Honeymoon: 'Honeymoon Packages',
  Friends: 'Friends Getaway Tours',
  'Group Tour': 'Group Tours',
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

function tourTypeLabelFromMeta(meta: Record<string, unknown>): string {
  const direct = normalizeLabel(typeof meta.tour_type === 'string' ? meta.tour_type : '');
  if (direct) return direct;
  const legacy = typeof meta.tour_category === 'string' ? meta.tour_category.trim() : '';
  if (legacy && LEGACY_TOUR_TYPE_MAP[legacy]) return LEGACY_TOUR_TYPE_MAP[legacy];
  return normalizeLabel(legacy);
}

async function usageCountsForKind(kind: TourTaxonomyKind): Promise<Map<string, number>> {
  const { data, error } = await supabase.from('tours').select('overview');
  if (error) throw new Error(error.message);
  const counts = new Map<string, number>();
  for (const row of data || []) {
    const { meta } = splitOverviewWithMeta(row.overview);
    const label =
      kind === 'tour_type'
        ? tourTypeLabelFromMeta(meta as Record<string, unknown>)
        : normalizeLabel(typeof meta.tour_experience === 'string' ? meta.tour_experience : '');
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return counts;
}

function labelKey(label: string): string {
  return label.trim().toLowerCase();
}

async function listTourTaxonomyRows(kind: TourTaxonomyKind): Promise<TourTaxonomyRow[]> {
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

export async function listTourTaxonomy(kind: TourTaxonomyKind): Promise<TourTaxonomyRow[]> {
  const rows = await listTourTaxonomyRows(kind);
  let counts = new Map<string, number>();
  try {
    counts = await usageCountsForKind(kind);
  } catch {
    counts = new Map();
  }

  const seen = new Set<string>();
  const withUsage: TourTaxonomyRow[] = rows.map((row) => {
    seen.add(labelKey(row.label));
    return { ...row, usage_count: counts.get(row.label) || 0 };
  });

  for (const [label, usage_count] of counts.entries()) {
    if (usage_count <= 0 || seen.has(labelKey(label))) continue;
    withUsage.push({
      id: 0,
      kind,
      label,
      sort_order: 0,
      created_at: '',
      usage_count,
    });
  }

  return withUsage;
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
