import { z } from 'zod';

const trimmedString = (max: number) => z.string().trim().min(1).max(max);
const optionalTrimmed = (max: number) => z.string().trim().max(max).optional().nullable();

export const websiteLeadBodySchema = z
  .object({
    name: trimmedString(120),
    phone: trimmedString(32),
    destination: trimmedString(240),
    tour_id: z.coerce.number().int().positive().optional(),
    email: z.string().trim().email().max(160).optional().nullable().or(z.literal('')),
    travel_date: optionalTrimmed(32),
    nationality: optionalTrimmed(80),
    enquiry_type: optionalTrimmed(80),
    services: z.array(z.string().trim().max(80)).max(20).optional().nullable(),
    adults: z.coerce.number().int().min(0).max(500).optional(),
    event_type: optionalTrimmed(120),
    event_date: optionalTrimmed(32),
    venue_location: optionalTrimmed(240),
    mice_requirements: optionalTrimmed(4000),
    message: optionalTrimmed(4000),
    page_url: optionalTrimmed(500),
    market: optionalTrimmed(16),
    forex_mode: z.enum(['buy', 'sell']).optional().nullable(),
    forex_currency_have: optionalTrimmed(12),
    forex_currency_required: optionalTrimmed(12),
    forex_amount: z.coerce.number().min(0).max(1_000_000_000).optional().nullable(),
    otp: optionalTrimmed(12),
    form_verification_token: optionalTrimmed(512),
    turnstile_token: optionalTrimmed(4096),
    'cf-turnstile-response': optionalTrimmed(4096),
  })
  .passthrough();

export const enquiryBodySchema = z
  .object({
    tour_id: z.coerce.number().int().positive(),
    departure_id: z.coerce.number().int().positive().optional().nullable(),
    name: trimmedString(120),
    phone: trimmedString(32),
    email: z.string().trim().email().max(160).optional().nullable().or(z.literal('')),
    departure_city: trimmedString(120),
    travel_date: trimmedString(32),
    destination: optionalTrimmed(240),
    duration: optionalTrimmed(80),
    adults: z.coerce.number().int().min(0).max(100),
    children: z.coerce.number().int().min(0).max(100),
    infants: z.coerce.number().int().min(0).max(100),
    rooms: z.coerce.number().int().min(0).max(50).optional(),
    tour_title: optionalTrimmed(240),
    page_url: optionalTrimmed(500),
    enquiry_type: optionalTrimmed(80),
    market: optionalTrimmed(16),
    nationality: optionalTrimmed(80),
    otp: optionalTrimmed(12),
    form_verification_token: optionalTrimmed(512),
    turnstile_token: optionalTrimmed(4096),
    'cf-turnstile-response': optionalTrimmed(4096),
  })
  .passthrough();

export const profilePatchBodySchema = z
  .object({
    full_name: optionalTrimmed(120),
    phone: optionalTrimmed(32),
    avatar_url: optionalTrimmed(500),
    salutation: optionalTrimmed(20),
    company: optionalTrimmed(160),
    nationality: optionalTrimmed(80),
    gst_number: optionalTrimmed(32),
    pan_number: optionalTrimmed(16),
    date_of_birth: optionalTrimmed(16),
    passport_number: optionalTrimmed(32),
    passport_expiry_date: optionalTrimmed(16),
    address_street: optionalTrimmed(240),
    address_city: optionalTrimmed(120),
    address_state: optionalTrimmed(120),
    address_country: optionalTrimmed(80),
    address_zip: optionalTrimmed(20),
  })
  .strict();

export const authPhoneBodySchema = z.object({
  phone: trimmedString(32),
  turnstile_token: optionalTrimmed(4096),
  'cf-turnstile-response': optionalTrimmed(4096),
});
