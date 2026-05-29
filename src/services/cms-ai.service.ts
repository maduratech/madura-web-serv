import { env } from '../config/env';

export type CmsTourAiDestinationHint = { id: number; name: string };

export type CmsTourAiParseRequest = {
  pastedText: string;
  context?: {
    destinations?: CmsTourAiDestinationHint[];
    currentTitle?: string;
  };
};

function requireCrmIntegration(): { base: string; secret: string } {
  const base = String(env.CRM_API_URL || '').replace(/\/$/, '');
  const secret = String(env.CRM_WEB_INTEGRATION_SECRET || '').trim();
  if (!base || !secret) {
    throw new Error(
      'CRM web integration not configured (set CRM_API_URL and CRM_WEB_INTEGRATION_SECRET).'
    );
  }
  return { base, secret };
}

const CRM_AI_TIMEOUT_MS = 120_000;

export async function parseTourSupplierContentForCms(
  body: CmsTourAiParseRequest
): Promise<Record<string, unknown>> {
  const { base, secret } = requireCrmIntegration();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CRM_AI_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/api/integration/cms/tour/parse-supplier`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-integration-secret': secret,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown> & {
      message?: string;
    };
    if (!response.ok) {
      throw new Error(
        typeof data.message === 'string' ? data.message : 'AI parse failed. Please try again.'
      );
    }
    return data;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('AI request timed out. Try a shorter paste or try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
