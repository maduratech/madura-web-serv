import type { DestinationHierarchyRow } from './tour-destinations';

type CacheEntry<T> = { value: T; at: number };

/** In-process listing cache — per market, short TTL for spike absorption. */
const TOURS_LISTING_TTL_MS = 60_000;
const DESTINATION_HIERARCHY_TTL_MS = 5 * 60_000;

const toursListingCache = new Map<string, CacheEntry<unknown[]>>();
let destinationHierarchyCache: CacheEntry<Map<number, DestinationHierarchyRow>> | null = null;

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
  const key = normalizeListingMarketKey(marketCountry);
  toursListingCache.set(key, { value, at: Date.now() });
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
