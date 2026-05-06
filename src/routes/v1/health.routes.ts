import { Router } from 'express';
import { supabase } from '../../lib/supabase';
import { env } from '../../config/env';

const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  let supabase_ok = false;
  let crm_ok = false;
  let supabase_error: string | null = null;
  let crm_error: string | null = null;

  try {
    const { error } = await supabase.from('tours').select('id').limit(1);
    if (error) {
      supabase_error = error.message;
    } else {
      supabase_ok = true;
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
    },
    checks: [
      { service: 'supabase', ok: supabase_ok, error: supabase_error },
      { service: 'crm', ok: crm_ok, error: crm_error },
    ],
  });
});

export { healthRouter };

