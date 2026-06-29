export type SupabaseKeyKind = 'service_role' | 'anon' | 'publishable' | 'unknown';

/** Classify the Supabase API key — publishable/anon keys cannot read catalog tables under RLS. */
export function classifySupabaseKey(key: string | undefined | null): SupabaseKeyKind {
  const trimmed = String(key || '').trim();
  if (!trimmed) return 'unknown';
  if (trimmed.startsWith('sb_publishable_')) return 'publishable';

  const parts = trimmed.split('.');
  if (parts.length !== 3) return 'unknown';

  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) as {
      role?: string;
    };
    if (payload.role === 'service_role') return 'service_role';
    if (payload.role === 'anon') return 'anon';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function supabaseProjectRef(key: string | undefined | null): string | null {
  const trimmed = String(key || '').trim();
  if (!trimmed || trimmed.startsWith('sb_publishable_')) return null;
  const parts = trimmed.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8')) as {
      ref?: string;
    };
    return payload.ref || null;
  } catch {
    return null;
  }
}

export function catalogKeyMisconfigured(serviceRoleKey: string | undefined | null): string | null {
  if (!serviceRoleKey?.trim()) {
    return 'SUPABASE_SERVICE_ROLE_KEY is missing — catalog reads will be empty (RLS blocks anon/publishable keys).';
  }
  const kind = classifySupabaseKey(serviceRoleKey);
  if (kind === 'publishable') {
    return 'SUPABASE_SERVICE_ROLE_KEY is a publishable key — use the service_role secret from Supabase → Settings → API.';
  }
  if (kind === 'anon') {
    return 'SUPABASE_SERVICE_ROLE_KEY is the anon key — use the service_role secret from Supabase → Settings → API.';
  }
  if (kind !== 'service_role') {
    return 'SUPABASE_SERVICE_ROLE_KEY is not a valid service_role JWT.';
  }
  return null;
}
