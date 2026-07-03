/** Minimum calendar days between today and the travel / departure date for online booking. */
export const BOOKING_MIN_ADVANCE_DAYS = 7;

export const BOOKING_ADVANCE_NOTICE =
  'Online booking is available when your travel date is at least 7 days from today. For departures within the next 7 days, please send an enquiry.';

function isoDateLocal(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function earliestBookableTravelDate(from: Date = new Date()): string {
  const d = new Date(from);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + BOOKING_MIN_ADVANCE_DAYS);
  return isoDateLocal(d);
}

export function isTravelDateBookable(travelDate: string, from: Date = new Date()): boolean {
  const normalized = String(travelDate || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  return normalized >= earliestBookableTravelDate(from);
}

export function assertBookableTravelDate(travelDate: string): void {
  const normalized = String(travelDate || '').trim().slice(0, 10);
  if (!normalized) return;
  if (!isTravelDateBookable(normalized)) {
    throw new Error(BOOKING_ADVANCE_NOTICE);
  }
}
