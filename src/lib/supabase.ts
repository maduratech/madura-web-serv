import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env';

const supabaseKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY;

if (!env.SUPABASE_URL || !supabaseKey) {
  // Keep startup explicit for missing env; avoids silent failures at runtime.
  // eslint-disable-next-line no-console
  console.warn('[supabase] SUPABASE_URL and key are required (service role key preferred).');
}

export const supabase = createClient(env.SUPABASE_URL, supabaseKey, {
  auth: { persistSession: false },
});

