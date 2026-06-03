import { splitOverviewWithMeta } from '../lib/tour-overview-meta';
import {
  addSidebarBadge,
  deleteSidebarBadge,
  listSidebarBadges,
  type SidebarBadgeRow,
} from '../lib/sidebar-badge';
import { supabase } from '../lib/supabase';

export type { SidebarBadgeRow };

export { addSidebarBadge, deleteSidebarBadge, listSidebarBadges };

async function usageCountsByBadgeId(): Promise<Map<number, number>> {
  const { data, error } = await supabase.from('tours').select('overview');
  if (error) throw new Error(error.message);
  const counts = new Map<number, number>();
  for (const row of data || []) {
    const { meta } = splitOverviewWithMeta(row.overview);
    const id = meta.promo_badge_id != null ? Number(meta.promo_badge_id) : NaN;
    if (!Number.isFinite(id) || id <= 0) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return counts;
}

export async function listSidebarBadgesWithUsage(): Promise<SidebarBadgeRow[]> {
  const rows = await listSidebarBadges();
  let counts = new Map<number, number>();
  try {
    counts = await usageCountsByBadgeId();
  } catch {
    counts = new Map();
  }
  return rows.map((row) => ({
    ...row,
    usage_count: counts.get(Number(row.id)) || 0,
  }));
}
