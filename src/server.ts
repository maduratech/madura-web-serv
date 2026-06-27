import 'dotenv/config';
import { app as expressApp } from './app';
import { probeCatalogTourCount } from './lib/supabase';

const port = parseInt(process.env.PORT || '4000', 10);

expressApp.listen(port, () => {
  console.log(`travel-api ready on http://localhost:${port}`);
  void probeCatalogTourCount().then((count) => {
    if (count === 0) {
      console.error(
        '[catalog-health] tours table returned 0 rows — check SUPABASE_SERVICE_ROLE_KEY on this server. ' +
          'Without it, packages and destination images will not load on the website.'
      );
    } else if (count > 0) {
      console.log(`[catalog-health] tours indexed: ${count}`);
    }
  });
});
