import { supabase } from './supabase';

export type SidebarBadgeRow = {
  id: number;
  label: string;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  usage_count?: number;
};

export type PromoBadgeMeta = {
  promo_badge_id?: number | null;
  promo_badge?: string | null;
};

function isMissingSidebarBadgeTable(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('cms_sidebar_badges') &&
    (m.includes('does not exist') || m.includes('could not find') || m.includes('schema cache'))
  );
}

function normalizeLabel(raw: string): string {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

export function resolvePromoBadgeLabel(
  meta: PromoBadgeMeta,
  badgeById: Map<number, string>
): string | null {
  const id = meta.promo_badge_id != null ? Number(meta.promo_badge_id) : NaN;
  if (Number.isFinite(id) && id > 0) {
    const fromId = badgeById.get(id);
    if (fromId) return fromId;
  }
  const legacy = normalizeLabel(meta.promo_badge || '');
  return legacy || null;
}

let activeBadgeMapCache: { map: Map<number, string>; at: number } | null = null;
const ACTIVE_BADGE_MAP_CACHE_MS = 5 * 60 * 1000;

function invalidateActiveSidebarBadgeMapCache(): void {
  activeBadgeMapCache = null;
}

export async function loadActiveSidebarBadgeMap(): Promise<Map<number, string>> {
  if (activeBadgeMapCache && Date.now() - activeBadgeMapCache.at < ACTIVE_BADGE_MAP_CACHE_MS) {
    return activeBadgeMapCache.map;
  }

  const { data, error } = await supabase
    .from('cms_sidebar_badges')
    .select('id,label')
    .eq('is_active', true)
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  if (error) {
    if (isMissingSidebarBadgeTable(error.message)) return new Map();
    throw new Error(error.message);
  }
  const map = new Map<number, string>();
  for (const row of data || []) {
    const id = Number(row.id);
    const label = normalizeLabel(row.label);
    if (Number.isFinite(id) && id > 0 && label) map.set(id, label);
  }
  activeBadgeMapCache = { map, at: Date.now() };
  return map;
}

export async function listSidebarBadges(): Promise<SidebarBadgeRow[]> {
  const { data, error } = await supabase
    .from('cms_sidebar_badges')
    .select('id,label,sort_order,is_active,created_at')
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  if (error) {
    if (isMissingSidebarBadgeTable(error.message)) return [];
    throw new Error(error.message);
  }
  return (data || []) as SidebarBadgeRow[];
}

export async function addSidebarBadge(label: string): Promise<SidebarBadgeRow> {
  const trimmed = normalizeLabel(label);
  if (!trimmed) throw new Error('Label is required.');

  const existing = await supabase
    .from('cms_sidebar_badges')
    .select('id,label,sort_order,is_active,created_at')
    .ilike('label', trimmed)
    .maybeSingle();
  if (existing.error && !isMissingSidebarBadgeTable(existing.error.message)) {
    throw new Error(existing.error.message);
  }
  if (existing.data) return existing.data as SidebarBadgeRow;

  const { data, error } = await supabase
    .from('cms_sidebar_badges')
    .insert({ label: trimmed, sort_order: 0, is_active: true })
    .select('id,label,sort_order,is_active,created_at')
    .single();
  if (error) {
    if (isMissingSidebarBadgeTable(error.message)) {
      throw new Error(
        'Sidebar badges table is missing. Run madura-web/scripts/sql/cms_sidebar_badges.sql on Supabase.'
      );
    }
    throw new Error(error.message);
  }
  invalidateActiveSidebarBadgeMapCache();
  return data as SidebarBadgeRow;
}

export async function deleteSidebarBadge(id: number): Promise<void> {
  const { error } = await supabase.from('cms_sidebar_badges').delete().eq('id', id);
  if (error) throw new Error(error.message);
  invalidateActiveSidebarBadgeMapCache();
}
