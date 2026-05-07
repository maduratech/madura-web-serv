import { supabase } from '../lib/supabase';
import { env } from '../config/env';
import type { AuthContext } from '../middlewares/auth.middleware';

/** Lead-shaped record returned by CRM `/api/customer/by-phone/:phone`. */
export type CrmHistoryLead = {
  lead_id: number;
  mts_id: string | null;
  destination: string | null;
  status: string | null;
  priority: string | null;
  lead_type: string | null;
  services: string[] | null;
  starting_point: string | null;
  tour_region: string | null;
  travel_date: string | null;
  return_date: string | null;
  duration: string | null;
  assigned_staff_name: string | null;
  source: string | null;
  summary: string | null;
  booking_id_in_requirements: number | string | null;
  created_at: string;
  last_updated: string;
};

export type CrmHistoryCustomer = {
  id: number;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
  date_added: string | null;
};

export type CrmHistoryResult = {
  customer: CrmHistoryCustomer | null;
  leads: CrmHistoryLead[];
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

/**
 * Fetch the customer's lead history from the CRM.
 * Returns null-customer when there's no CRM record yet (new user).
 */
export async function fetchCrmHistoryForPhone(phone: string): Promise<CrmHistoryResult> {
  const { base, secret } = requireCrmIntegration();
  const cleaned = String(phone || '').replace(/\D/g, '');
  if (cleaned.length < 10) {
    return { customer: null, leads: [] };
  }
  const response = await fetch(`${base}/api/customer/by-phone/${encodeURIComponent(cleaned)}`, {
    method: 'GET',
    headers: { 'x-integration-secret': secret },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`CRM history fetch failed: ${response.status} ${text}`.trim());
  }
  return (await response.json()) as CrmHistoryResult;
}

/** Fields sent to CRM on profile save (phone match takes priority over email on the CRM side). */
export type ProfileCrmSnapshot = {
  full_name?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
  email?: string | null;
};

/**
 * Push a profile change to the CRM customers table. Persists the resolved
 * crm_customer_id on the local profile so subsequent syncs stay in lockstep.
 *
 * Pass a **full snapshot** after saving to Supabase (`profile` row + auth email)
 * so name, phone, avatar, and email are all pushed together — not only the
 * fields that changed in the last PATCH.
 */
export async function syncProfileToCrm(
  ctx: AuthContext,
  patch: ProfileCrmSnapshot
): Promise<{ crm_customer_id: number; action: 'created' | 'updated' } | null> {
  const { base, secret } = requireCrmIntegration();
  const fullName = String(patch.full_name ?? ctx.fullName ?? '').trim();
  const phone = String(patch.phone ?? ctx.phone ?? '').trim();
  const avatarUrl = String(patch.avatar_url ?? ctx.avatarUrl ?? '').trim();
  const email = String(patch.email ?? ctx.email ?? '').trim();

  if (!fullName && !phone && !email) return null;

  const response = await fetch(`${base}/api/customer/sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-integration-secret': secret,
    },
    body: JSON.stringify({
      crm_customer_id: ctx.crmCustomerId || undefined,
      full_name: fullName || undefined,
      email: email || undefined,
      phone: phone || undefined,
      avatar_url: avatarUrl || undefined,
      /** Hint for CRM: resolve duplicate rows by phone before email. */
      match_priority: 'phone_then_email',
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`CRM customer sync failed: ${response.status} ${text}`.trim());
  }
  const payload = (await response.json()) as {
    customer_id?: number;
    action?: 'created' | 'updated';
  };
  if (!payload.customer_id) return null;

  // Persist crm_customer_id on profiles so future calls don't re-resolve.
  if (payload.customer_id !== ctx.crmCustomerId) {
    try {
      await supabase
        .from('profiles')
        .update({ crm_customer_id: payload.customer_id })
        .eq('id', ctx.userId);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[account] crm_customer_id persist skipped:', err);
    }
  }
  return { crm_customer_id: payload.customer_id, action: payload.action || 'updated' };
}

export type DashboardBooking = {
  id: number;
  status: string | null;
  payment_status: string | null;
  total_price: number | null;
  payment_amount: number | null;
  payment_currency: string | null;
  display_currency: string | null;
  display_fx_rate: number | null;
  mts_id: string | null;
  crm_lead_id: number | null;
  rooms: number | null;
  room_details: unknown;
  created_at: string;
  payment_verified_at: string | null;
  tour: { id: number; title: string; destination: string | null } | null;
  departure: {
    id: number;
    city: string | null;
    start_date: string | null;
    end_date: string | null;
  } | null;
};

/** Bookings + tour/departure info for a given user. Service-role read so RLS doesn't matter here. */
export async function fetchBookingsForUser(userId: string): Promise<DashboardBooking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select(
      'id,status,payment_status,total_price,payment_amount,payment_currency,display_currency,display_fx_rate,mts_id,crm_lead_id,rooms,room_details,created_at,payment_verified_at,tour:tours(id,title,destination),departure:departures(id,city,start_date,end_date)'
    )
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw new Error(`Failed to load bookings: ${error.message}`);
  return ((data || []) as unknown) as DashboardBooking[];
}

export type DashboardEnquiry = {
  id: number;
  destination: string | null;
  travel_date: string | null;
  duration: string | null;
  adults: number | null;
  children: number | null;
  rooms: number | null;
  tour_title: string | null;
  created_at: string;
};

export async function fetchEnquiriesForUser(userId: string): Promise<DashboardEnquiry[]> {
  // The enquiries table varies by deployment age — pick conservative columns.
  const select =
    'id,destination,travel_date,duration,adults,children,rooms,tour_title,created_at';
  const { data, error } = await supabase
    .from('enquiries')
    .select(select)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) {
    // Forward-compatible: drop unknown columns if any are missing.
    if (/column .* does not exist/i.test(String(error.message || ''))) {
      const fallback = await supabase
        .from('enquiries')
        .select('id,destination,travel_date,created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false })
        .limit(100);
      if (fallback.error) throw new Error(`Failed to load enquiries: ${fallback.error.message}`);
      return ((fallback.data || []) as unknown) as DashboardEnquiry[];
    }
    throw new Error(`Failed to load enquiries: ${error.message}`);
  }
  return ((data || []) as unknown) as DashboardEnquiry[];
}

/** Update profile + push to CRM. Returns the patched profile. */
export async function updateProfileAndSyncToCrm(
  ctx: AuthContext,
  patch: { full_name?: string; phone?: string; avatar_url?: string }
) {
  const cleaned: Record<string, string | null> = {};
  if (typeof patch.full_name === 'string') cleaned.full_name = patch.full_name.trim() || null;
  if (typeof patch.phone === 'string') cleaned.phone = patch.phone.trim() || null;
  if (typeof patch.avatar_url === 'string') cleaned.avatar_url = patch.avatar_url.trim() || null;

  if (Object.keys(cleaned).length === 0) {
    throw new Error('Nothing to update.');
  }

  const { data: updated, error } = await supabase
    .from('profiles')
    .update(cleaned)
    .eq('id', ctx.userId)
    .select('id,email,full_name,phone,avatar_url,crm_customer_id')
    .single();
  if (error || !updated) {
    throw new Error(`Failed to update profile: ${error?.message || 'unknown error'}`);
  }

  let crmResult: Awaited<ReturnType<typeof syncProfileToCrm>> = null;
  try {
    const u = updated as {
      full_name?: string | null;
      phone?: string | null;
      avatar_url?: string | null;
      email?: string | null;
      crm_customer_id?: number | null;
    };
    crmResult = await syncProfileToCrm(
      {
        ...ctx,
        fullName: u.full_name ?? null,
        phone: u.phone ?? null,
        avatarUrl: u.avatar_url ?? null,
        crmCustomerId: u.crm_customer_id ?? null,
      },
      {
        full_name: u.full_name,
        phone: u.phone,
        avatar_url: u.avatar_url,
        email: u.email ?? ctx.email,
      }
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[account] CRM profile sync failed (kept local update):', err);
  }
  return { profile: updated, crm: crmResult };
}
