import { env } from '../config/env';

type CrmSyncPayload = {
  bookingId: number;
  tourId: number;
  departureId: number;
  totalPrice: number;
  travellerCount: number;
  primaryTravellerEmail?: string;
  primaryTravellerPhone?: string;
};

/**
 * Async fire-and-forget CRM sync job.
 * This MUST never block booking response.
 */
export function enqueueCrmBookingSync(payload: CrmSyncPayload): void {
  setTimeout(async () => {
    try {
      // Mocked integration for MVP. Replace with real CRM API call later.
      // eslint-disable-next-line no-console
      console.info('[crm.job] Syncing booking to CRM:', payload);

      // Simulate non-blocking integration side effect.
      await Promise.resolve({
        crmUrl: `${env.CRM_API_URL}/api/v1/bookings/sync`,
      });
    } catch (error) {
      // Never throw to request lifecycle.
      // eslint-disable-next-line no-console
      console.error('[crm.job] Failed to sync booking to CRM:', error);
    }
  }, 0);
}

