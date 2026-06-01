import { supabase } from '../lib/supabase';

export type HeaderMarqueeRow = {
  id: number;
  text: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
};

const SELECT_COLS = 'id,text,sort_order,is_active,created_at';

function isMissingTable(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('cms_header_marquee') &&
    (m.includes('does not exist') || m.includes('could not find') || m.includes('schema cache'))
  );
}

function normalizeText(raw: string): string {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

export async function listHeaderMarqueeAll(): Promise<HeaderMarqueeRow[]> {
  const { data, error } = await supabase
    .from('cms_header_marquee')
    .select(SELECT_COLS)
    .order('sort_order', { ascending: true })
    .order('id', { ascending: true });
  if (error) {
    if (isMissingTable(error.message)) return [];
    throw new Error(error.message);
  }
  return (data || []) as HeaderMarqueeRow[];
}

export async function listHeaderMarqueePublic(): Promise<string[]> {
  const rows = await listHeaderMarqueeAll();
  return rows.filter((r) => r.is_active).map((r) => r.text);
}

export async function createHeaderMarquee(text: string): Promise<HeaderMarqueeRow> {
  const trimmed = normalizeText(text);
  if (!trimmed) throw new Error('Message text is required.');

  const existing = await listHeaderMarqueeAll();
  const maxOrder = existing.reduce((m, r) => Math.max(m, r.sort_order), 0);

  const { data, error } = await supabase
    .from('cms_header_marquee')
    .insert({ text: trimmed, sort_order: maxOrder + 10, is_active: true })
    .select(SELECT_COLS)
    .single();
  if (error) {
    if (isMissingTable(error.message)) {
      throw new Error('Header ticker table is missing. Run sql/cms_header_marquee.sql on Supabase.');
    }
    throw new Error(error.message);
  }
  return data as HeaderMarqueeRow;
}

export async function updateHeaderMarquee(
  id: number,
  patch: Partial<Pick<HeaderMarqueeRow, 'text' | 'is_active' | 'sort_order'>>
): Promise<HeaderMarqueeRow> {
  const db: Record<string, unknown> = {};
  if (patch.text !== undefined) {
    const trimmed = normalizeText(patch.text);
    if (!trimmed) throw new Error('Message text is required.');
    db.text = trimmed;
  }
  if (patch.is_active !== undefined) db.is_active = Boolean(patch.is_active);
  if (patch.sort_order !== undefined) db.sort_order = Number(patch.sort_order);

  const { data, error } = await supabase
    .from('cms_header_marquee')
    .update(db)
    .eq('id', id)
    .select(SELECT_COLS)
    .single();
  if (error) throw new Error(error.message);
  return data as HeaderMarqueeRow;
}

export async function deleteHeaderMarquee(id: number): Promise<void> {
  const { error } = await supabase.from('cms_header_marquee').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function reorderHeaderMarquee(ids: number[]): Promise<HeaderMarqueeRow[]> {
  const unique = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!unique.length) throw new Error('No valid ids to reorder.');

  let order = 10;
  for (const id of unique) {
    const { error } = await supabase.from('cms_header_marquee').update({ sort_order: order }).eq('id', id);
    if (error) throw new Error(error.message);
    order += 10;
  }
  return listHeaderMarqueeAll();
}
