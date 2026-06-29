import { sweepBookingMemoryStores } from '../services/booking.service';
import { sweepStockSearchCaches } from '../services/cms-media.service';
import { sweepFormTokenStore } from '../services/form-phone-verification.service';
import { sweepPhoneAuthRateStores } from '../services/phone-auth.service';
import { sweepRateLimitStores } from '../middlewares/rate-limit.middleware';

const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

/** Evict stale in-memory Map entries so long-running PM2 processes do not grow without bound. */
export function startRuntimeMemoryMaintenance(): void {
  const sweep = () => {
    try {
      sweepRateLimitStores();
      sweepPhoneAuthRateStores();
      sweepBookingMemoryStores();
      sweepFormTokenStore();
      sweepStockSearchCaches();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[runtime-memory] sweep failed:', err);
    }
  };

  sweep();
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}
