import { env } from '../config/env';

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

async function crmPost(path: string, body: Record<string, unknown>) {
  const { base, secret } = requireCrmIntegration();
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-integration-secret': secret,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { message?: string }).message || `CRM request failed (${res.status}).`);
  }
  return data;
}

async function crmGet(path: string) {
  const { base, secret } = requireCrmIntegration();
  const res = await fetch(`${base}${path}`, {
    headers: { 'x-integration-secret': secret },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { message?: string }).message || `CRM request failed (${res.status}).`);
  }
  return data;
}

export type EngagementGateStatus = {
  requires_gate: boolean;
  published: boolean;
  tracking_enabled?: boolean;
  engagement_state?: string;
  approved_at?: string | null;
  modification_requested?: boolean;
};

export async function fetchEngagementGateStatus(
  itineraryId: number
): Promise<EngagementGateStatus> {
  return crmGet(
    `/api/integration/itinerary-engagement/${itineraryId}/gate-status`
  ) as Promise<EngagementGateStatus>;
}

export async function verifyItineraryCode(input: {
  itineraryId: number;
  code?: string;
  previewToken?: string;
  userAgent?: string;
  ip?: string;
}) {
  return crmPost('/api/integration/itinerary-engagement/verify-code', {
    itineraryId: input.itineraryId,
    code: input.code,
    previewToken: input.previewToken,
    userAgent: input.userAgent,
    ip: input.ip,
  });
}

export async function recordItineraryView(input: {
  itineraryId: number;
  sessionId: string;
  viewerUserId?: string | null;
  userAgent?: string;
  isStaffPreview?: boolean;
}) {
  return crmPost('/api/integration/itinerary-engagement/record-view', input);
}

export async function recordItineraryHeartbeat(input: {
  itineraryId: number;
  sessionId: string;
  activeSeconds: number;
  isStaffPreview?: boolean;
}) {
  return crmPost('/api/integration/itinerary-engagement/heartbeat', input);
}

export async function approveItineraryEngagement(input: {
  itineraryId: number;
  userId: string;
  crmCustomerId?: number | null;
  email?: string | null;
  phone?: string | null;
}) {
  return crmPost('/api/integration/itinerary-engagement/approve', input);
}

export async function requestItineraryChanges(input: {
  itineraryId: number;
  userId: string;
  crmCustomerId?: number | null;
  email?: string | null;
  phone?: string | null;
  text: string;
}) {
  return crmPost('/api/integration/itinerary-engagement/request-changes', input);
}

export type ItineraryViewerAccess = {
  allowed: boolean;
  role?: 'primary' | 'traveler';
  customer_id?: number;
  reason?: string;
};

export async function fetchItineraryViewerAccess(input: {
  itineraryId: number;
  crmCustomerId?: number | null;
  email?: string | null;
  phone?: string | null;
}): Promise<ItineraryViewerAccess> {
  return crmPost('/api/integration/itinerary-engagement/viewer-access', input) as Promise<ItineraryViewerAccess>;
}
