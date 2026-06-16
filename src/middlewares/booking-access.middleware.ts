import type { NextFunction, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { HttpError } from '../lib/http-error';

function normalizeEmail(value: string | null | undefined): string {
  return String(value || '').trim().toLowerCase();
}

async function bookingOwnedByTravellerEmail(bookingId: number, authEmail: string): Promise<boolean> {
  const normalizedAuthEmail = normalizeEmail(authEmail);
  if (!normalizedAuthEmail) return false;

  const { data: travellers, error } = await supabase
    .from('travellers')
    .select('email')
    .eq('booking_id', bookingId);

  if (error) {
    throw new HttpError(500, 'Could not verify booking access.');
  }

  return (travellers || []).some((row) => {
    const travellerEmail = normalizeEmail((row as { email?: string | null }).email);
    return travellerEmail.length > 0 && travellerEmail === normalizedAuthEmail;
  });
}

/**
 * Ensures the signed-in user owns the booking referenced in `:bookingId`.
 * Matches `bookings.user_id` when present, otherwise primary traveller email.
 */
export async function requireBookingAccess(req: Request, _res: Response, next: NextFunction) {
  try {
    const bookingId = Number(req.params.bookingId || req.body?.booking_id || 0);
    if (!bookingId) {
      throw new HttpError(400, 'Booking id is required.');
    }
    const userId = req.auth?.userId;
    if (!userId) {
      throw new HttpError(401, 'You must be signed in to access this booking.');
    }

    const { data, error } = await supabase
      .from('bookings')
      .select('user_id')
      .eq('id', bookingId)
      .maybeSingle();

    if (error) {
      throw new HttpError(500, 'Could not verify booking access.');
    }
    if (!data) {
      throw new HttpError(404, 'Booking not found.');
    }

    const ownerId = String((data as { user_id?: string | null }).user_id || '').trim();
    if (ownerId) {
      if (ownerId !== userId) {
        throw new HttpError(403, 'You do not have access to this booking.');
      }
      next();
      return;
    }

    const ownsViaEmail = await bookingOwnedByTravellerEmail(bookingId, req.auth?.email || '');
    if (!ownsViaEmail) {
      throw new HttpError(403, 'You do not have access to this booking.');
    }

    next();
  } catch (err) {
    next(err);
  }
}
