import 'dotenv/config';
import { initSentry, captureServerException } from './lib/sentry';
import { app as expressApp } from './app';
import { env } from './config/env';
import { probeCatalogTourCount } from './lib/supabase';
import {
  recordCatalogProbeSuccess,
  startSupabaseRecoveryMaintenance,
} from './lib/supabase-recovery';
import { startRuntimeMemoryMaintenance } from './lib/runtime-memory';

initSentry();

/* ------------------------------------------------------------------ */
/*  Global crash handlers — without these, an unhandled rejection or  */
/*  uncaught exception silently kills the process.  PM2 restarts it,  */
/*  but we lose all context about what actually went wrong.           */
/* ------------------------------------------------------------------ */

process.on('uncaughtException', (err, origin) => {
  console.error(`[FATAL] uncaughtException (${origin}):`, err);
  captureServerException(err, { origin: String(origin) });
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] unhandledRejection at:', promise, 'reason:', reason);
  captureServerException(reason, { kind: 'unhandledRejection' });
  setTimeout(() => process.exit(1), 500);
});

startRuntimeMemoryMaintenance();
startSupabaseRecoveryMaintenance();

if (process.env.NODE_ENV === 'production' && !String(env.CORS_ORIGINS || '').trim()) {
  console.error(
    '[security] CORS_ORIGINS is empty in production. Mutating API routes may accept unintended browser origins. ' +
      'Set CORS_ORIGINS to your website origins (comma-separated).'
  );
}

const port = parseInt(process.env.PORT || '4000', 10);

expressApp.listen(port, () => {
  console.log(`travel-api ready on http://localhost:${port}`);
  void probeCatalogTourCount().then((count) => {
    if (count === 0) {
      console.error(
        '[catalog-health] tours table returned 0 rows. If SUPABASE_SERVICE_ROLE_KEY is set, restore tour data in Supabase. ' +
          'Without tours, packages, planner destinations, and listing pages will be empty or stale.'
      );
    } else if (count > 0) {
      recordCatalogProbeSuccess(count);
      console.log(`[catalog-health] tours indexed: ${count}`);
    }
  });
});
