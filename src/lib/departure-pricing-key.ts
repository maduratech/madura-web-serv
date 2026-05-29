/** Stable meta key for per-departure USD (ids change when CMS replaces departures). */
export function departurePricingStableKey(row: {
  id?: number;
  city?: string | null;
  start_date?: string | null;
}): string | null {
  const city = String(row.city || '').trim().toLowerCase();
  const start = String(row.start_date || '').slice(0, 10);
  if (city && start) return `${city}|${start}`;
  if (row.id != null && Number(row.id) > 0) return String(row.id);
  return null;
}

export function lookupDeparturePricingUsd(
  map: Record<string, import('./tour-market-audience').TourMarketPricing> | undefined,
  row: { id?: number; city?: string | null; start_date?: string | null }
): import('./tour-market-audience').TourMarketPricing | undefined {
  if (!map) return undefined;
  const stable = departurePricingStableKey(row);
  if (stable && map[stable]) return map[stable];
  if (row.id != null && Number(row.id) > 0) return map[String(row.id)];
  return undefined;
}
