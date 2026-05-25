import { supabase } from '../lib/supabase';
import { joinOverviewWithMeta, splitOverviewWithMeta, type TourCmsMeta } from '../lib/tour-overview-meta';
import type { TourVisibilityStatus } from '../lib/tour-visibility';
import { createDestination } from './cms.service';

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
  detailed_hotels?: unknown[] | null;
  detailed_flights?: unknown[] | null;
  costing_options?: unknown;
  adults?: number | null;
  children?: number | null;
  infants?: number | null;
  grand_total?: number | null;
};

type CrmSharingPrices = {
  twin_sharing_price: number | null;
  triple_sharing_price: number | null;
  single_sharing_price: number | null;
  quad_sharing_price: number | null;
  sales_price: number | null;
};

function roundInr(n: number): number | null {
  return n > 0 ? Math.round(n) : null;
}

/** Map CRM itinerary costing to web tour price columns (twin/single/triple/quad). */
function deriveCrmSharingPrices(input: {
  costing_options?: unknown;
  adults?: number | null;
  children?: number | null;
  infants?: number | null;
  grand_total?: number | null;
}): CrmSharingPrices {
  const adults = Math.max(1, Number(input.adults) || 2);
  const children = Number(input.children) || 0;
  const infants = Number(input.infants) || 0;
  const opts = Array.isArray(input.costing_options) ? input.costing_options : [];
  const opt = opts[0] as Record<string, unknown> | undefined;
  const empty: CrmSharingPrices = {
    twin_sharing_price: null,
    triple_sharing_price: null,
    single_sharing_price: null,
    quad_sharing_price: null,
    sales_price: null,
  };

  if (opt?.isManualCosting) {
    const markup = Number(opt.markup) || 0;
    const markupMultiplier = markup > 0 ? 1 + markup / 100 : 1;
    const twinRaw = Number(opt.manualPerAdultTwin || opt.manualPerAdult || 0);
    const singleRaw = Number(opt.manualPerAdultSingle || 0);
    const tripleRaw = Number(opt.manualPerAdultTriple || 0);
    const quadRaw = Number(opt.manualPerAdultQuad || 0);

    if (twinRaw || singleRaw || tripleRaw || quadRaw) {
      const twin = twinRaw ? roundInr(twinRaw * markupMultiplier) : null;
      const single = singleRaw ? roundInr(singleRaw * markupMultiplier) : null;
      const triple = tripleRaw ? roundInr(tripleRaw * markupMultiplier) : null;
      const quad = quadRaw ? roundInr(quadRaw * markupMultiplier) : null;
      const sales = twin ?? single ?? triple ?? quad ?? null;
      return {
        twin_sharing_price: twin,
        single_sharing_price: single,
        triple_sharing_price: triple,
        quad_sharing_price: quad,
        sales_price: sales,
      };
    }

    let subtotal = Number(opt.manualPackageCost || 0);
    if (subtotal > 0) {
      if (opt.isGstApplied) {
        subtotal += subtotal * (Number(opt.gstPercentage) || 5) / 100;
      }
      if (opt.isTcsApplied) {
        const gstPortion = opt.isGstApplied
          ? Number(opt.manualPackageCost || 0) * (Number(opt.gstPercentage) || 5) / 100
          : 0;
        subtotal += (Number(opt.manualPackageCost || 0) + gstPortion) * (Number(opt.tcsPercentage) || 2) / 100;
      }
      const flightFee =
        (Number(opt.manualFlightPerAdult) || 0) * adults +
        (Number(opt.manualFlightPerChild) || 0) * children +
        (Number(opt.manualFlightPerInfant) || 0) * infants;
      const perPerson = roundInr((subtotal + flightFee) / adults);
      if (perPerson) {
        return {
          twin_sharing_price: perPerson,
          triple_sharing_price: perPerson,
          single_sharing_price: null,
          quad_sharing_price: null,
          sales_price: perPerson,
        };
      }
    }
  }

  const grand = Number(input.grand_total || 0);
  if (grand > 0) {
    const perPerson = roundInr(grand / adults);
    if (perPerson) {
      return {
        twin_sharing_price: perPerson,
        triple_sharing_price: perPerson,
        single_sharing_price: null,
        quad_sharing_price: null,
        sales_price: perPerson,
      };
    }
  }

  return empty;
}

const BOOKED_LEAD_STATUSES = new Set([
  'Confirmed',
  'Partial / On-Credit',
  'Billing Completed',
  'Voucher',
  'On Travel',
  'Feedback',
  'Completed',
]);

const CARD_INCLUDES = ['Flight', 'Hotel', 'Transfer', 'Sightseeing', 'Visa', 'Insurance'] as const;

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

function looksLikeConcatenatedDayOverview(text: string): boolean {
  const t = stripHtml(text);
  const hits = t.match(/Day\s*\d+\s*[–—-]/gi) || [];
  return hits.length >= 2;
}

function buildTripOverviewHtml(
  versionOverview: string | null | undefined,
  dayWisePlan: PublishItineraryPayload['day_wise_plan'],
  meta: { creative_title?: string | null; destination?: string | null; duration?: string | null }
): string {
  const raw = String(versionOverview || '').trim();
  if (raw && !looksLikeConcatenatedDayOverview(raw)) {
    if (/<[a-z][\s\S]*>/i.test(raw)) return raw;
    return `<p>${raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`;
  }

  const dest = String(meta.destination || 'your destination').trim();
  const title = String(meta.creative_title || '').trim();
  const duration = String(meta.duration || '').trim();
  const days = Array.isArray(dayWisePlan) ? dayWisePlan : [];
  const firstDesc = days[0]?.description ? stripHtml(String(days[0].description)) : '';
  const intro = title
    ? `<p><strong>${title}</strong> — a ${duration || 'custom'} journey to ${dest}, crafted by Madura Travel Service.</p>`
    : `<p>Discover ${dest} on a ${duration || 'curated'} itinerary with Madura Travel Service.</p>`;
  const teaser =
    firstDesc.length > 60
      ? `<p>${firstDesc.slice(0, 480)}${firstDesc.length > 480 ? '…' : ''}</p>`
      : '';
  return `${intro}${teaser}`;
}

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

/** Legacy slug — used to find tours published before title-based slugs. */
export function legacyItineraryTourSlug(itineraryId: number): string {
  return `mts-itinerary-${itineraryId}`;
}

export function titleTourSlug(creativeTitle: string, itineraryId: number): string {
  const base = slugify(creativeTitle);
  return base && base !== 'tour' ? base : `custom-tour-${itineraryId}`;
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

type WebHotelStay = {
  title: string;
  address: string;
  check_in_date: string;
  check_in_time: string;
  check_out_date: string;
  check_out_time: string;
  room_type: string;
  city: string;
  meal_plan: string;
  notes?: string | undefined;
};

function formatDateRange(checkIn: string, checkOut: string, nights?: number): string {
  const ci = checkIn?.slice(0, 10) || '';
  const co = checkOut?.slice(0, 10) || '';
  if (ci && co) return `${ci} – ${co}${nights ? `, ${nights} Night${nights === 1 ? '' : 's'}` : ''}`;
  return ci || co || '';
}

function mapCrmHotelsToWeb(hotels: unknown[] | null | undefined): WebHotelStay[] {
  if (!Array.isArray(hotels)) return [];
  const out: WebHotelStay[] = [];
  for (const entry of hotels) {
      const h = entry as Record<string, unknown>;
      const name = String(h.name || '').trim();
      if (!name) continue;
      const rooms = Array.isArray(h.rooms) ? (h.rooms as Record<string, unknown>[]) : [];
      const adults = rooms.reduce((s, r) => s + (Number(r.adults) || 0), 0);
      const roomSplit =
        rooms.length > 0
          ? rooms
              .map((r) => {
                const n = String(r.name || 'Room').trim();
                const a = Number(r.adults) || 0;
                const c = Number(r.children) || 0;
                return `${n}: ${a}A${c ? `+${c}C` : ''}`;
              })
              .join('; ')
          : String(h.room_type || 'N/A');
      const mealPlans = rooms
        .map((r) => String(r.meal_plan || h.meal_plan || '').trim())
        .filter(Boolean);
      const mealPlan = mealPlans.length ? [...new Set(mealPlans)].join(', ') : String(h.meal_plan || 'EP');
      const confLines = rooms
        .map((r, i) => {
          const cn = String(r.confirmation_number || '').trim();
          return cn ? `Room ${i + 1}: ${cn}` : null;
        })
        .filter(Boolean) as string[];
      const nights = Number(h.nights) || 0;
      const notes = [
        formatDateRange(String(h.check_in_date || ''), String(h.check_out_date || ''), nights),
        adults > 0 ? `Total Pax: ${adults} adult${adults === 1 ? '' : 's'}` : null,
        `Room split: ${roomSplit}`,
        `Meal plan: ${mealPlan}`,
        confLines.length ? `Confirmation: ${confLines.join('; ')}` : null,
      ]
        .filter(Boolean)
        .join('\n');

      out.push({
        title: name.startsWith('Stay at') ? name : `Stay at ${name}`,
        address: '',
        city: String(h.city || '').trim(),
        check_in_date: String(h.check_in_date || '').slice(0, 10),
        check_out_date: String(h.check_out_date || '').slice(0, 10),
        check_in_time: String(h.check_in_time || '12:00').trim() || '12:00',
        check_out_time: String(h.check_out_time || '12:00').trim() || '12:00',
        room_type: String(h.room_type || roomSplit),
        meal_plan: mealPlan,
        notes: notes || undefined,
      });
  }
  return out;
}

type WebFlightLeg = {
  leg_type: 'onward' | 'return' | 'inter_city';
  airline: string;
  flight_number: string;
  departure_date: string;
  departure_airport_code: string;
  departure_time: string;
  departure_airport_name: string;
  arrival_date: string;
  arrival_airport_code: string;
  arrival_time: string;
  arrival_airport_name: string;
  duration: string;
  cost_inr?: number | null;
};

function mapCrmFlightsToWeb(flights: unknown[] | null | undefined): WebFlightLeg[] {
  if (!Array.isArray(flights)) return [];
  const out: WebFlightLeg[] = [];
  for (const entry of flights) {
    const f = entry as Record<string, unknown>;
    const direction = String(f.direction || 'onward');
    const legType =
      direction === 'return' ? 'return' : direction === 'intercity' ? 'inter_city' : 'onward';
    const segments = Array.isArray(f.segments) ? (f.segments as Record<string, unknown>[]) : [];
    for (const seg of segments) {
      const dep = String(seg.departure_time || '');
      const arr = String(seg.arrival_time || '');
      out.push({
        leg_type: legType as WebFlightLeg['leg_type'],
        airline: String(seg.airline || '').trim(),
        flight_number: String(seg.flight_number || '').trim(),
        departure_date: dep.slice(0, 10),
        departure_time: dep.length > 10 ? dep.slice(11, 16) : '',
        departure_airport_code: String(seg.from_airport || '').trim(),
        departure_airport_name: String(seg.from_airport || '').trim(),
        arrival_date: arr.slice(0, 10),
        arrival_time: arr.length > 10 ? arr.slice(11, 16) : '',
        arrival_airport_code: String(seg.to_airport || '').trim(),
        arrival_airport_name: String(seg.to_airport || '').trim(),
        duration: String(seg.duration || f.totalDuration || '').trim(),
        cost_inr: f.price != null ? Number(f.price) : null,
      });
    }
  }
  return out.filter((l) => l.airline || l.flight_number || l.departure_airport_code);
}

function buildTourIncludes(
  inclusionsText: string,
  hotels: WebHotelStay[],
  flights: WebFlightLeg[]
): string[] {
  const fromText = splitBulletLines(inclusionsText);
  const set = new Set<string>(fromText);
  if (flights.length) set.add('Flight');
  if (hotels.length) set.add('Hotel');
  return Array.from(set).filter((x) =>
    CARD_INCLUDES.some((c) => c.toLowerCase() === x.toLowerCase()) || x.length > 0
  );
}

async function resolveDestinationId(destinationName: string | null | undefined): Promise<{
  id: number | null;
  name: string | null;
  slug: string | null;
}> {
  const name = String(destinationName || '').trim();
  if (!name) {
    throw new Error('Destination is required. Set destination on the itinerary before publishing.');
  }
  const { data } = await supabase
    .from('destinations')
    .select('id,name,slug')
    .ilike('name', name)
    .limit(1)
    .maybeSingle();
  if (data?.id) {
    return { id: Number(data.id), name: data.name, slug: data.slug };
  }
  const { data: partial } = await supabase
    .from('destinations')
    .select('id,name,slug')
    .ilike('name', `%${name}%`)
    .limit(1)
    .maybeSingle();
  if (partial?.id) {
    return { id: Number(partial.id), name: partial.name, slug: partial.slug };
  }
  const created = await createDestination({ name, slug: slugify(name) });
  return { id: created.id, name: created.name, slug: created.slug };
}

async function findExistingTourForItinerary(itineraryId: number): Promise<number | null> {
  const legacy = legacyItineraryTourSlug(itineraryId);
  const { data: byLegacy } = await supabase
    .from('tours')
    .select('id')
    .eq('slug', legacy)
    .maybeSingle();
  if (byLegacy?.id) return Number(byLegacy.id);

  const { data: rows } = await supabase
    .from('tours')
    .select('id,overview')
    .ilike('overview', `%crm_itinerary_id":${itineraryId}%`)
    .limit(5);
  for (const row of rows || []) {
    const { meta } = splitOverviewWithMeta(row.overview);
    if (Number(meta.crm_itinerary_id) === itineraryId) return Number(row.id);
  }
  return null;
}

async function uniqueSlug(base: string, excludeTourId?: number): Promise<string> {
  let candidate = base;
  let n = 0;
  while (n < 50) {
    const { data } = await supabase.from('tours').select('id').eq('slug', candidate).maybeSingle();
    if (!data?.id || (excludeTourId && Number(data.id) === excludeTourId)) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
  return `${base}-${Date.now()}`;
}

function buildPublicTourUrl(
  baseUrl: string,
  tourId: number,
  tourRow: {
    slug?: string | null;
    destination?: string | null;
    destination_ref?: { slug?: string | null } | { slug?: string | null }[] | null;
    destinations?: { slug?: string | null } | { slug?: string | null }[] | null;
  } | null,
  destSlugFallback?: string | null
): string {
  const base = String(baseUrl || 'https://web.maduratravel.com').replace(/\/$/, '');
  const embed = tourRow?.destination_ref ?? tourRow?.destinations;
  const embedSlug = Array.isArray(embed) ? embed[0]?.slug : embed?.slug;
  const destSlug = embedSlug || destSlugFallback || slugify(String(tourRow?.destination || ''));
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

  const title =
    String(input.creative_title || '').trim() ||
    `${input.destination || 'Custom'} ${input.duration || 'Tour'}`.trim();
  const itineraryDays = mapDayWisePlanToWeb(input.day_wise_plan);
  if (!itineraryDays.length) {
    throw new Error(
      'Add at least one day with title or description before publishing to the website.'
    );
  }

  const dest = await resolveDestinationId(input.destination);
  const visibility_status = resolveTourVisibility(
    input.itinerary_status,
    input.lead_status
  );

  const webHotels = mapCrmHotelsToWeb(input.detailed_hotels);
  const webFlights = mapCrmFlightsToWeb(input.detailed_flights);
  const tourIncludes = buildTourIncludes(String(input.inclusions || ''), webHotels, webFlights);

  const overviewBody = buildTripOverviewHtml(input.overview, input.day_wise_plan, {
    creative_title: input.creative_title,
    destination: input.destination,
    duration: input.duration,
  });

  const cmsMeta: TourCmsMeta = {
    crm_itinerary_id: itineraryId,
    tour_program_type: 'flexible',
    tour_category: 'Family',
    flights: webFlights.length ? webFlights : undefined,
    hotels: webHotels.length ? webHotels : undefined,
  };

  const overview = joinOverviewWithMeta(overviewBody, cmsMeta);

  const existingTourId = await findExistingTourForItinerary(itineraryId);
  const baseSlug = titleTourSlug(title, itineraryId);
  const slug = await uniqueSlug(baseSlug, existingTourId ?? undefined);

  const gallery = Array.isArray(input.gallery_image_urls)
    ? input.gallery_image_urls.filter((u) => String(u || '').trim()).slice(0, 4)
    : [];

  const sharingPrices = deriveCrmSharingPrices({
    costing_options: input.costing_options,
    adults: input.adults,
    children: input.children,
    infants: input.infants,
    grand_total: input.grand_total,
  });

  const payload: Record<string, unknown> = {
    title,
    slug,
    destination: dest.name || String(input.destination || '').trim(),
    destination_id: dest.id,
    duration_days: parseDurationDays(input.duration),
    flow_type: 'booking',
    visibility_status,
    tour_region: 'International',
    starting_city: String(input.starting_point || '').trim() || null,
    hero_image_url: input.cover_image_url || null,
    gallery_image_urls: gallery,
    overview,
    tour_includes: tourIncludes,
    tour_exclusions: splitBulletLines(String(input.exclusions || '')),
    itinerary_days: itineraryDays,
    twin_sharing_price: sharingPrices.twin_sharing_price,
    triple_sharing_price: sharingPrices.triple_sharing_price,
    single_sharing_price: sharingPrices.single_sharing_price,
    quad_sharing_price: sharingPrices.quad_sharing_price,
    sales_price: sharingPrices.sales_price,
  };

  let tourId: number;
  let updated = false;
  if (existingTourId) {
    tourId = existingTourId;
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
    tourRow as Parameters<typeof buildPublicTourUrl>[2],
    dest.slug
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
  const tourId = await findExistingTourForItinerary(itineraryId);
  if (!tourId) return { published: false };

  const { data: tour } = await supabase
    .from('tours')
    .select(
      'id,slug,visibility_status,destination,destination_id,destination_ref:destinations(slug),destinations(slug)'
    )
    .eq('id', tourId)
    .maybeSingle();
  if (!tour?.id) return { published: false };

  let destSlug: string | null = null;
  if (tour.destination_id) {
    const { data: d } = await supabase
      .from('destinations')
      .select('slug')
      .eq('id', tour.destination_id)
      .maybeSingle();
    destSlug = d?.slug ?? null;
  }

  return {
    published: true,
    tourId: Number(tour.id),
    slug: tour.slug,
    visibility_status: (tour.visibility_status as TourVisibilityStatus) || 'unlisted',
    publicUrl: buildPublicTourUrl(
      webPublicBaseUrl,
      Number(tour.id),
      tour as Parameters<typeof buildPublicTourUrl>[2],
      destSlug
    ),
    directUrl: `${webPublicBaseUrl.replace(/\/$/, '')}/tours/${tour.id}`,
  };
}
