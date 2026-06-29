import 'dotenv/config';
import { app as expressApp } from './app';
import { probeCatalogTourCount } from './lib/supabase';
import { startRuntimeMemoryMaintenance } from './lib/runtime-memory';

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
