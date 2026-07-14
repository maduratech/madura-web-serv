import { env } from '../config/env';
import { HttpError } from '../lib/http-error';

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
    throw new HttpError(
      503,
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
      const upstreamMessage =
        typeof data.message === 'string' && data.message.trim()
          ? data.message.trim()
          : 'AI parse failed. Please try again.';
      // Don't forward CRM auth failures as website 401 (staff is already signed in to CMS).
      let status = response.status;
      if (status === 401 || status === 403) status = 502;
      if (status < 400 || status >= 600) status = 502;
      throw new HttpError(status, upstreamMessage);
    }
    return data;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (err instanceof Error && err.name === 'AbortError') {
      // 400 so sanitizePublicError can surface the message (5xx are always generic).
      throw new HttpError(400, 'AI request timed out. Try a shorter paste or try again.');
    }
    const msg = err instanceof Error ? err.message : 'AI parse failed. Please try again.';
    // Network / upstream gateway failures — keep 502; clients see a generic retry message.
    throw new HttpError(502, msg);
  } finally {
    clearTimeout(timer);
  }
}
