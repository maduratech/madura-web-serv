import { Router } from 'express';
import { supabase } from '../../lib/supabase';
import { env } from '../../config/env';

const healthRouter = Router();

.healthRouter.get('/health', async (_req, res) => {
  let supabase_ok = false;
  let crm_ok = false;
  let supabase_error: string | null = null;
  let crm_error: string | null = null;
  let tours_count: number | null = null;
  const using_service_role = Boolean(env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    const { count, error } = await supabase
      .from('tours')
      .select('id', { count: 'exact', head: true });
    if (error) {
      supabase_error = error.message;
    } else {
      supabase_ok = true;
      tours_count = count ?? 0;
      if (tours_count === 0 && !using_service_role) {
        supabase_error =
          'tours table returned 0 rows — SUPABASE_SERVICE_ROLE_KEY is likely missing (anon key blocked by RLS)';
        supabase_ok = false;
      }
    }
  } catch (err) {
    supabase_error = err instanceof Error ? err.message : 'supabase check failed';
  }

  try {
    const base = String(env.CRM_API_URL || '').replace(/\/$/, '');
    if (!base) {
      crm_error = 'CRM_API_URL is missing';
    } else {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(`${base}/api/lead/website`, {
          method: 'OPTIONS',
          signal: controller.signal,
        });
        crm_ok = response.status < 500;
        if (!crm_ok) crm_error = `crm status ${response.status}`;
      } finally {
        clearTimeout(timeout);
      }
    }
  } catch (err) {
    crm_error = err instanceof Error ? err.message : 'crm check failed';
  }

  return res.status(200).json({
    summary: {
      supabase_ok,
      crm_ok,
      overall_ok: supabase_ok && crm_ok,
      using_service_role,
      tours_count,
    },
    checks: [
      { service: 'supabase', ok: supabase_ok, error: supabase_error, tours_count, using_service_role },
      { service: 'crm', ok: crm_ok, error: crm_error },
    ],
  });
});

export { healthRouter };

