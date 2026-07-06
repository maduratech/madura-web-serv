import {
  invalidateDestinationHierarchyCache,
  invalidateToursListingCache,
} from './catalog-cache';
import { probeCatalogTourCount, refreshSupabaseClient } from './supabase';

const PROBE_INTERVAL_MS = 3 * 60 * 1000;
const FAILURES_BEFORE_REFRESH = 2;
const ON_DEMAND_COOLDOWN_MS = 60 * 1000;

let lastGoodTourCount = 0;
let consecutiveFailures = 0;
let lastOnDemandRecoveryAt = 0;

/** Called after a successful startup or recovery probe. */
export function recordCatalogProbeSuccess(tourCount: number): void {
  if (tourCount > 0) {
    lastGoodTourCount = tourCount;
    consecutiveFailures = 0;
  }
}

async function refreshClientAndProbe(): Promise<number> {
  refreshSupabaseClient();
  invalidateToursListingCache();
  invalidateDestinationHierarchyCache();
  return probeCatalogTourCount();
}

/** Recreate the Supabase client and verify catalog reads work again. */
export async function attemptSupabaseRecovery(reason: string): Promise<boolean> {
  const retry = await refreshClientAndProbe();
  if (retry > 0) {
    recordCatalogProbeSuccess(retry);
    // eslint-disable-next-line no-console
    console.log(`[supabase-recovery] recovered (${reason}) — tours indexed: ${retry}`);
    return true;
  }
  consecutiveFailures += 1;
  // eslint-disable-next-line no-console
  console.error(`[supabase-recovery] refresh did not help (${reason}), probe=${retry}`);
  return false;
}

/** Background check — runs every few minutes while the process is alive. */
export async function runSupabaseRecoveryProbe(): Promise<void> {
  const count = await probeCatalogTourCount();
  if (count > 0) {
    recordCatalogProbeSuccess(count);
    return;
  }

  consecutiveFailures += 1;
  const reason = count === -1 ? 'probe error' : '0 tours returned';
  // eslint-disable-next-line no-console
  console.error(
    `[supabase-recovery] periodic check failed (${reason}), ` +
      `failure ${consecutiveFailures}/${FAILURES_BEFORE_REFRESH}, last good count: ${lastGoodTourCount}`
  );

  if (lastGoodTourCount > 0 && consecutiveFailures >= FAILURES_BEFORE_REFRESH) {
    consecutiveFailures = 0;
    await attemptSupabaseRecovery('periodic probe');
  }
}

/**
 * Fast path when a live request sees empty catalog data but we know tours existed
 * earlier in this process lifetime. Debounced to avoid refresh storms.
 */
export function requestSupabaseRecoveryOnCatalogStale(reason: string): void {
  if (lastGoodTourCount <= 0) return;
  const now = Date.now();
  if (now - lastOnDemandRecoveryAt < ON_DEMAND_COOLDOWN_MS) return;
  lastOnDemandRecoveryAt = now;
  void attemptSupabaseRecovery(reason);
}

export function startSupabaseRecoveryMaintenance(): void {
  const timer = setInterval(() => {
    void runSupabaseRecoveryProbe().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[supabase-recovery] probe threw:', err);
    });
  }, PROBE_INTERVAL_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}
