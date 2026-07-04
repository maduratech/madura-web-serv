import 'dotenv/config';
import { app as expressApp } from './app';
import { probeCatalogTourCount } from './lib/supabase';
import { startRuntimeMemoryMaintenance } from './lib/runtime-memory';

/* ------------------------------------------------------------------ */
/*  Global crash handlers — without these, an unhandled rejection or  */
/*  uncaught exception silently kills the process.  PM2 restarts it,  */
/*  but we lose all context about what actually went wrong.           */
/* ------------------------------------------------------------------ */

process.on('uncaughtException', (err, origin) => {
  console.error(`[FATAL] uncaughtException (${origin}):`, err);
  // Give the log line a moment to flush, then exit so PM2 restarts cleanly.
  setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] unhandledRejection at:', promise, 'reason:', reason);
  setTimeout(() => process.exit(1), 500);
});

startRuntimeMemoryMaintenance();

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
      console.log(`[catalog-health] tours indexed: ${count}`);
    }
  });
});
