import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';
import { catalogKeyMisconfigured, classifySupabaseKey } from './supabase-key';

const usingServiceRole = Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY;
const configuredKeyKind = classifySupabaseKey(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY);

if (!env.SUPABASE_URL || !supabaseKey) {
  // Keep startup explicit for missing env; avoids silent failures at runtime.
  // eslint-disable-next-line no-console
  console.warn('[supabase] SUPABASE_URL and key are required (service role key preferred).');
} else {
  const misconfig = catalogKeyMisconfigured(env.SUPABASE_SERVICE_ROLE_KEY);
  if (misconfig) {
    // eslint-disable-next-line no-console
    console.error(`[supabase] ${misconfig}`);
  } else if (!usingServiceRole) {
    // Catalog reads (tours, destinations) require the service role — anon/publishable keys
    // are blocked by RLS and return empty arrays with no error.
    // eslint-disable-next-line no-console
    console.error(
      '[supabase] SUPABASE_SERVICE_ROLE_KEY is missing — falling back to SUPABASE_KEY. ' +
        'Tours and destinations will appear empty on the website.'
    );
  }
}

export { configuredKeyKind };

export const supabase = createClient(env.SUPABASE_URL, supabaseKey, {
  auth: { persistSession: false },
});

/** Quick probe: returns tour row count or -1 on failure. Used at startup for catalog health. */
export async function probeCatalogTourCount(): Promise<number> {
  const { count, error } = await supabase
    .from('tours')
    .select('id', { count: 'exact', head: true });
  if (error) return -1;
  return count ?? 0;
}

