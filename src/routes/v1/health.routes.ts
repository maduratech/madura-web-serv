import { Router } from 'express';
import { supabase } from '../../lib/supabase';
import { env } from '../../config/env';
import {
  catalogKeyMisconfigured,
  classifySupabaseKey,
  supabaseProjectRef,
} from '../../lib/supabase-key';

const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  let supabase_ok = false;
  let crm_ok = false;
  let supabase_error: string | null = null;
  let crm_error: string | null = null;
  let tours_count: number | null = null;
  let destinations_count: number | null = null;
  const using_service_role = Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
  const supabase_key_kind = classifySupabaseKey(
    env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY
  );
  const supabase_project_ref =
    supabaseProjectRef(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY) ||
    String(env.SUPABASE_URL || '')
      .replace(/^https?:\/\//, '')
      .split('.')[0] ||
    null;
  const key_misconfiguration = catalogKeyMisconfigured(env.SUPABASE_SERVICE_ROLE_KEY);

  const supabase_url_host = (() => {
    try {
      return new URL(env.SUPABASE_URL).host;
    } catch {
      return null;
    }
  })();

  try {
    if (key_misconfiguration) {
      supabase_error = key_misconfiguration;
    } else {
      const { count, error } = await supabase
        .from('tours')
        .select('id', { count: 'exact', head: true });
      if (error) {
        supabase_error = error.message;
      } else {
        tours_count = count ?? 0;
        const destProbe = await supabase
          .from('destinations')
          .select('id', { count: 'exact', head: true });
        destinations_count = destProbe.error ? null : destProbe.count ?? 0;

        if (tours_count === 0 && !using_service_role) {
          supabase_error =
            'tours table returned 0 rows — SUPABASE_SERVICE_ROLE_KEY is likely missing (anon key blocked by RLS)';
        } else if (tours_count === 0) {
          supabase_error =
            'PostgREST returned 0 tours/destinations. If SQL Editor shows rows, the api server SUPABASE_URL or ' +
            'SUPABASE_SERVICE_ROLE_KEY is wrong or stale — update .env on api1 and run: pm2 restart madura-web-serv --update-env';
        } else {
          supabase_ok = true;
        }
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
      supabase_key_kind,
      supabase_project_ref,
      supabase_url_host,
      tours_count,
      destinations_count,
    },
    checks: [
      {
        service: 'supabase',
        ok: supabase_ok,
        error: supabase_error,
        tours_count,
        destinations_count,
        supabase_url_host,
        using_service_role,
        supabase_key_kind,
        supabase_project_ref,
      },
      { service: 'crm', ok: crm_ok, error: crm_error },
    ],
  });
});

export { healthRouter };

