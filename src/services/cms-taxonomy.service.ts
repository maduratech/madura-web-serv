import { supabase } from '../lib/supabase';
import { splitOverviewWithMeta } from '../lib/tour-overview-meta';
import {
  parseTourThemeMetaJson,
  resolveTourThemeDescriptionForMarket,
  serializeTourThemeMeta,
  type TourThemeCmsMeta,
} from '../lib/tour-theme-cms-meta';
import { normalizeDestinationSlug } from '../lib/destination-slug';

export type TourTaxonomyKind = 'tour_type' | 'tour_experience';

export type TourTaxonomyRow = {
  id: number;
  kind: TourTaxonomyKind;
  label: string;
  sort_order: number;
  created_at: string;
  usage_count?: number;
  meta?: TourThemeCmsMeta;
};

export type TourThemePageInfo = {
  id: number;
  label: string;
  slug: string;
  banner_image_url: string | null;
  description: string;
};

const LEGACY_TOUR_TYPE_MAP: Record<string, string> = {
  Family: 'Family Holidays',
  Honeymoon: 'Honeymoon Packages',
  Friends: 'Friends Getaway Tours',
  'Group Tour': 'Group Tours',
};

function taxonomyRowRecord(row: unknown): Record<string, unknown> {
  if (row && typeof row === 'object') return row as Record<string, unknown>;
  return {};
}

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

function isMissingTaxonomyMetaColumn(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return m.includes('meta') && (m.includes('does not exist') || m.includes('could not find') || m.includes('schema cache'));
}

async function listTourTaxonomyRows(kind: TourTaxonomyKind): Promise<TourTaxonomyRow[]> {
  const selectWithMeta = 'id,kind,label,sort_order,created_at,meta';
  const selectBase = 'id,kind,label,sort_order,created_at';

  let data: unknown[] | null = null;
  let errorMessage = '';

  for (const cols of [selectWithMeta, selectBase]) {
    const { data: rows, error } = await supabase
      .from('cms_tour_taxonomy')
      .select(cols)
      .eq('kind', kind)
      .order('sort_order', { ascending: true })
      .order('label', { ascending: true });
    if (!error) {
      data = rows;
      break;
    }
    errorMessage = error.message;
    if (!isMissingTaxonomyTable(error.message) && !isMissingTaxonomyMetaColumn(error.message)) {
      throw new Error(error.message);
    }
  }

  if (!data) {
    if (isMissingTaxonomyTable(errorMessage)) return [];
    throw new Error(errorMessage || 'Failed to load tour taxonomy.');
  }

  return (data || []).map((row) => {
    const typed = taxonomyRowRecord(row);
    return {
      id: Number(typed.id),
      kind: typed.kind as TourTaxonomyKind,
      label: String(typed.label || ''),
      sort_order: Number(typed.sort_order) || 0,
      created_at: String(typed.created_at || ''),
      meta: parseTourThemeMetaJson(typed.meta),
    };
  });
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

export async function getTourTaxonomyById(id: number): Promise<TourTaxonomyRow | null> {
  if (!Number.isFinite(id) || id <= 0) return null;

  for (const cols of ['id,kind,label,sort_order,created_at,meta', 'id,kind,label,sort_order,created_at']) {
    const { data, error } = await supabase.from('cms_tour_taxonomy').select(cols).eq('id', id).maybeSingle();
    if (error) {
      if (isMissingTaxonomyTable(error.message)) return null;
      if (isMissingTaxonomyMetaColumn(error.message)) continue;
      throw new Error(error.message);
    }
    if (!data) return null;
    const row = taxonomyRowRecord(data);
    return {
      id: Number(row.id),
      kind: row.kind as TourTaxonomyKind,
      label: String(row.label || ''),
      sort_order: Number(row.sort_order) || 0,
      created_at: String(row.created_at || ''),
      meta: parseTourThemeMetaJson(row.meta),
    };
  }

  return null;
}

export async function getTourTaxonomyByLabel(
  kind: TourTaxonomyKind,
  label: string
): Promise<TourTaxonomyRow | null> {
  const trimmed = normalizeLabel(label);
  if (!trimmed) return null;

  const rows = await listTourTaxonomyRows(kind);
  const match = rows.find((row) => labelKey(row.label) === labelKey(trimmed));
  return match ?? null;
}

export type UpdateTourTaxonomyInput = {
  meta?: TourThemeCmsMeta;
};

export async function updateTourTaxonomy(id: number, input: UpdateTourTaxonomyInput): Promise<TourTaxonomyRow> {
  if (!Number.isFinite(id) || id <= 0) throw new Error('Invalid id.');

  const meta = serializeTourThemeMeta((input.meta || {}) as Record<string, unknown>);
  const payload = { meta };

  const { data, error } = await supabase
    .from('cms_tour_taxonomy')
    .update(payload)
    .eq('id', id)
    .select('id,kind,label,sort_order,created_at,meta')
    .single();

  if (error) {
    if (isMissingTaxonomyMetaColumn(error.message)) {
      throw new Error(
        'Tour taxonomy meta column is missing. Run sql/cms_tour_taxonomy_meta.sql on Supabase.'
      );
    }
    throw new Error(error.message);
  }

  const row = taxonomyRowRecord(data);
  return {
    id: Number(row.id),
    kind: row.kind as TourTaxonomyKind,
    label: String(row.label || ''),
    sort_order: Number(row.sort_order) || 0,
    created_at: String(row.created_at || ''),
    meta: parseTourThemeMetaJson(row.meta),
  };
}

/** Public theme hub page copy keyed by experience label (e.g. Senior Citizen Tours). */
export async function getTourThemePageByLabel(
  themeLabel: string,
  marketCountry: 'in' | 'au' = 'in'
): Promise<TourThemePageInfo | null> {
  const label = normalizeLabel(themeLabel);
  if (!label) return null;

  const match = await getTourTaxonomyByLabel('tour_experience', label);
  const meta = match?.meta || {};
  const description = resolveTourThemeDescriptionForMarket(meta, marketCountry);

  return {
    id: match?.id || 0,
    label,
    slug: normalizeDestinationSlug(label),
    banner_image_url: meta.banner_image_url?.trim() || null,
    description,
  };
}

/** Public theme hub page copy keyed by nav slug (e.g. senior-citizen-tours). */
export async function getTourThemePageBySlug(
  slug: string,
  marketCountry: 'in' | 'au' = 'in'
): Promise<TourThemePageInfo | null> {
  const normalized = normalizeDestinationSlug(slug).replace(/-packages$/i, '');
  if (!normalized) return null;

  const rows = await listTourTaxonomyRows('tour_experience');
  const match =
    rows.find((row) => normalizeDestinationSlug(row.label) === normalized) ||
    rows.find((row) => {
      const rowSlug = normalizeDestinationSlug(row.label);
      return rowSlug.includes(normalized) || normalized.includes(rowSlug);
    });

  if (!match) return null;
  return getTourThemePageByLabel(match.label, marketCountry);
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
