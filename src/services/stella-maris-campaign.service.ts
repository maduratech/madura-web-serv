import { env } from '../config/env';
import { HttpError } from '../lib/http-error';

function crmBaseUrl(): string {
  const base = String(env.CRM_API_URL || '').trim().replace(/\/$/, '');
  if (!base) {
    throw new HttpError(503, 'CRM is not configured (set CRM_API_URL).');
  }
  return base;
}

export type StellaMarisProxyResult = {
  status: number;
  data: Record<string, unknown>;
};

/**
 * Forward Stella Maris campaign calls to CRM (server-to-server — no browser CORS).
 * Preserves CRM status codes and JSON body (e.g. already_spun 409).
 */
export async function proxyStellaMarisCampaign(
  crmPath: string,
  body: Record<string, unknown>
): Promise<StellaMarisProxyResult> {
  const url = `${crmBaseUrl()}${crmPath.startsWith('/') ? crmPath : `/${crmPath}`}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body || {}),
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[stella-maris] CRM network error:', err);
    throw new HttpError(502, 'Could not reach campaign service. Please try again.');
  }

  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    data = { message: 'Invalid response from campaign service.' };
  }

  return { status: response.status, data };
}
