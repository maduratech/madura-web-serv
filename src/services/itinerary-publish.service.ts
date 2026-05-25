import { supabase } from '../lib/supabase';
import type { TourVisibilityStatus } from '../lib/tour-visibility';

export type WebItineraryDay = { day: string; title: string; details: string };

export type PublishItineraryPayload = {
  itineraryId: number;
  creative_title?: string | null;
  destination?: string | null;
  duration?: string | null;
  starting_point?: string | null;
  cover_image_url?: string | null;
  gallery_image_urls?: string[] | null;
  itinerary_status?: string | null;
  lead_status?: string | null;
  day_wise_plan?: Array<{
    day?: number;
    title?: string;
    description?: string;
  }>;
  overview?: string | null;
  inclusions?: string | null;
  exclusions?: string | null;
};

const BOOKED_LEAD_STATUSES = new Set([
  'Confirmed',
  'Partial / On-Credit',
  'Billing Completed',
  'Voucher',
  'On Travel',
  'Feedback',
  'Completed',
]);

function slugify(text: string): string {
  return (
    String(text || '')
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'tour'
  );
}

function stripHtml(html: string): string {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitBulletLines(text: string): string[] {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(/\n|<br\s*\/?>|<\/p>|<\/li>/gi)
    .map((s) => stripHtml(s).replace(/^[\s•\-*✔✓–—]+/i, '').trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out.slice(0, 40);
}

function parseDurationDays(duration: string | null | undefined): number {
  const s = String(duration || '');
  const m = s.match(/(\d+)\s*(?:day|night|n\b|d\b)/i);
  if (m) return Math.max(1, Math.min(60, Number(m[1])));
  const n = Number(s.replace(/\D/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.min(60, n) : 7;
}

/** Map CRM day_wise_plan (numeric day, title, description) → website itinerary_days. */
export function mapDayWisePlanToWeb(
  dayWisePlan: PublishItineraryPayload['day_wise_plan']
): WebItineraryDay[] {
  const days = Array.isArray(dayWisePlan) ? dayWisePlan : [];
  return days
    .map((d, idx) => {
      const dayNum = Number(d.day) || idx + 1;
      const title = String(d.title || '').trim() || `Day ${dayNum}`;
      const desc = String(d.description || '').trim();
      if (!desc && !title) return null;
      return {
        day: `Day ${dayNum}`,
        title,
        details: desc || title,
      };
    })
    .filter((d): d is WebItineraryDay => d != null);
}

export function tourSlugForItinerary(itineraryId: number): string {
  return `mts-itinerary-${itineraryId}`;
}

export function resolveTourVisibility(
  itineraryStatus?: string | null,
  leadStatus?: string | null
): TourVisibilityStatus {
  if (String(itineraryStatus || '').trim() === 'Confirmed') return 'active';
  const lead = String(leadStatus || '').trim();
  if (lead && BOOKED_LEAD_STATUSES.has(lead)) return 'active';
  return 'unlisted';
}

async function resolveDestinationId(destinationName: string | null | undefined): Promise<number | null> {
  const name = String(destinationName || '').trim();
  if (!name) return null;
  const { data } = await supabase
    .from('destinations')
    .select('id,name')
    .ilike('name', name)
    .limit(1)
    .maybeSingle();
  if (data?.id) return Number(data.id);
  const { data: partial } = await supabase
    .from('destinations')
    .select('id,name')
    .ilike('name', `%${name}%`)
    .limit(1)
    .maybeSingle();
  return partial?.id ? Number(partial.id) : null;
}

function buildPublicTourUrl(
  baseUrl: string,
  tourId: number,
  tourRow: {
    slug?: string | null;
    destination?: string | null;
    destination_ref?: { slug?: string | null } | null;
    destinations?: { slug?: string | null } | null;
  } | null
): string {
  const base = String(baseUrl || 'https://web.maduratravel.com').replace(/\/$/, '');
  const destSlug =
    tourRow?.destination_ref?.slug ||
    tourRow?.destinations?.slug ||
    slugify(String(tourRow?.destination || ''));
  const titleSlug = tourRow?.slug;
  if (destSlug && titleSlug) {
    return `${base}/in/${destSlug}/${titleSlug}`;
  }
  return `${base}/tours/${tourId}`;
}

export async function publishItineraryToTour(
  input: PublishItineraryPayload,
  webPublicBaseUrl: string
): Promise<{
  tourId: number;
  slug: string;
  publicUrl: string;
  directUrl: string;
  visibility_status: TourVisibilityStatus;
  updated: boolean;
  itinerary_days_count: number;
}> {
  const itineraryId = Number(input.itineraryId);
  if (!itineraryId) throw new Error('itineraryId is required.');

  const slug = tourSlugForItinerary(itineraryId);
  const title =
    String(input.creative_title || '').trim() ||
    `${input.destination || 'Custom'} ${input.duration || 'Tour'}`.trim();
  const itineraryDays = mapDayWisePlanToWeb(input.day_wise_plan);
  if (!itineraryDays.length) {
    throw new Error(
      'Add at least one day with title or description before publishing to the website.'
    );
  }

  const visibility_status = resolveTourVisibility(
    input.itinerary_status,
    input.lead_status
  );
  const destinationId = await resolveDestinationId(input.destination);

  const payload: Record<string, unknown> = {
    title,
    slug,
    destination: String(input.destination || '').trim() || null,
    destination_id: destinationId,
    duration_days: parseDurationDays(input.duration),
    flow_type: 'enquiry',
    visibility_status,
    tour_region: 'International',
    starting_city: String(input.starting_point || '').trim() || null,
    hero_image_url: input.cover_image_url || null,
    gallery_image_urls: input.gallery_image_urls || [],
    overview: String(input.overview || '').trim() || null,
    tour_includes: splitBulletLines(String(input.inclusions || '')),
    tour_exclusions: splitBulletLines(String(input.exclusions || '')),
    itinerary_days: itineraryDays,
  };

  const { data: existing } = await supabase
    .from('tours')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();

  let tourId: number;
  let updated = false;
  if (existing?.id) {
    tourId = Number(existing.id);
    const { error: upErr } = await supabase.from('tours').update(payload).eq('id', tourId);
    if (upErr) throw new Error(upErr.message);
    updated = true;
  } else {
    const { data: inserted, error: insErr } = await supabase
      .from('tours')
      .insert(payload)
      .select('id')
      .single();
    if (insErr) throw new Error(insErr.message);
    tourId = Number(inserted.id);
  }

  const { data: tourRow } = await supabase
    .from('tours')
    .select(
      'id,slug,destination,destination_ref:destinations(slug),destinations(slug)'
    )
    .eq('id', tourId)
    .maybeSingle();

  const canonicalUrl = buildPublicTourUrl(
    webPublicBaseUrl,
    tourId,
    tourRow as Parameters<typeof buildPublicTourUrl>[2]
  );

  return {
    tourId,
    slug,
    publicUrl: canonicalUrl,
    directUrl: `${webPublicBaseUrl.replace(/\/$/, '')}/tours/${tourId}`,
    visibility_status,
    updated,
    itinerary_days_count: itineraryDays.length,
  };
}

export async function getPublishedTourLink(
  itineraryId: number,
  webPublicBaseUrl: string
): Promise<{
  published: boolean;
  tourId?: number;
  slug?: string;
  visibility_status?: TourVisibilityStatus;
  publicUrl?: string;
  directUrl?: string;
}> {
  const slug = tourSlugForItinerary(itineraryId);
  const { data: tour } = await supabase
    .from('tours')
    .select(
      'id,slug,visibility_status,destination,destination_ref:destinations(slug),destinations(slug)'
    )
    .eq('slug', slug)
    .maybeSingle();
  if (!tour?.id) return { published: false };
  const tourId = Number(tour.id);
  return {
    published: true,
    tourId,
    slug: tour.slug,
    visibility_status: (tour.visibility_status as TourVisibilityStatus) || 'unlisted',
    publicUrl: buildPublicTourUrl(
      webPublicBaseUrl,
      tourId,
      tour as Parameters<typeof buildPublicTourUrl>[2]
    ),
    directUrl: `${webPublicBaseUrl.replace(/\/$/, '')}/tours/${tourId}`,
  };
}
