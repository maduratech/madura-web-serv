import type { DestinationHierarchyRow } from './tour-destinations';

type CacheEntry<T> = { value: T; at: number };

/** In-process listing cache — per market, short TTL for spike absorption. */
const TOURS_LISTING_TTL_MS = 60_000;
const DESTINATION_HIERARCHY_TTL_MS = 5 * 60_000;

const toursListingCache = new Map<string, CacheEntry<unknown[]>>();
let destinationHierarchyCache: CacheEntry<Map<number, DestinationHierarchyRow>> | null = null;

/**
 * Stores the last successful non-empty result per market.  When Supabase goes
 * stale or PostgREST briefly returns 0 rows, we fall back to this instead of
 * serving an empty listing that breaks the entire website.
 */
const lastKnownGoodListing = new Map<string, unknown[]>();

function normalizeListingMarketKey(marketCountry: string): string {
  const raw = String(marketCountry || 'in').trim().toLowerCase();
  return raw.split('-')[0] || 'in';
}

export function getCachedToursListing<T>(marketCountry: string): T[] | null {
  const key = normalizeListingMarketKey(marketCountry);
  const hit = toursListingCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > TOURS_LISTING_TTL_MS) {
    toursListingCache.delete(key);
    return null;
  }
  return hit.value as T[];
}

export function setCachedToursListing(marketCountry: string, value: unknown[]): void {
  if (value.length === 0) {
    // Never cache an empty listing — keeps retrying Supabase and allows lastKnownGood fallback.
    return;
  }
  const key = normalizeListingMarketKey(marketCountry);
  toursListingCache.set(key, { value, at: Date.now() });
  lastKnownGoodListing.set(key, value);
}

export function getLastKnownGoodListing<T>(marketCountry: string): T[] | null {
  const key = normalizeListingMarketKey(marketCountry);
  const stale = lastKnownGoodListing.get(key);
  return stale && stale.length > 0 ? (stale as T[]) : null;
}

export function getCachedDestinationHierarchy(): Map<number, DestinationHierarchyRow> | null {
  if (!destinationHierarchyCache) return null;
  if (Date.now() - destinationHierarchyCache.at > DESTINATION_HIERARCHY_TTL_MS) {
    destinationHierarchyCache = null;
    return null;
  }
  return destinationHierarchyCache.value;
}

export function setCachedDestinationHierarchy(map: Map<number, DestinationHierarchyRow>): void {
  destinationHierarchyCache = { value: map, at: Date.now() };
}

export function invalidateToursListingCache(): void {
  toursListingCache.clear();
}

export function invalidateDestinationHierarchyCache(): void {
  destinationHierarchyCache = null;
}
