import { supabase } from '../lib/supabase';
import {
  joinOverviewWithMeta,
  splitOverviewWithMeta,
  type CrmDefaultRoom,
  type TourCmsMeta,
} from '../lib/tour-overview-meta';
import type { TourVisibilityStatus } from '../lib/tour-visibility';
import { createDestination } from './cms.service';
import { searchStockImages } from './cms-media.service';
import { getInrPerUsd } from '../lib/fx-rates';
import { fetchFxRatesToInr, foreignAmountToInr } from '../lib/fx-rates-to-inr';
import type { TourMarketPricing } from '../lib/tour-market-audience';

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
  lead_requirements?: {
    adults?: number;
    children?: number;
    babies?: number;
    child_ages?: number[];
    rooms?: Array<{
      adults?: number;
      children?: number;
      child_ages?: number[];
    }>;
  } | null;
  /** CRM manual costing currency (e.g. AUD). Amounts in costing are in this currency. */
  display_currency?: string | null;
};

type CrmSharingPrices = {
  twin_sharing_price: number | null;
  triple_sharing_price: number | null;
  single_sharing_price: number | null;
  quad_sharing_price: number | null;
  sales_price: number | null;
  child_price: number | null;
  infant_price: number | null;
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
    child_price: null,
    infant_price: null,
  };

  const isManualCosting =
    opt?.isManualCosting === true || String(opt?.isManualCosting || '').toLowerCase() === 'true';

  if (isManualCosting && opt) {
    const markup = Number(opt.markup) || 0;
    const markupMultiplier = markup > 0 ? 1 + markup / 100 : 1;
    const twinRaw = Number(opt.manualPerAdultTwin || opt.manualPerAdult || 0);
    const singleRaw = Number(opt.manualPerAdultSingle || 0);
    const tripleRaw = Number(opt.manualPerAdultTriple || 0);
    const quadRaw = Number(opt.manualPerAdultQuad || 0);
    const childRaw = Number(opt.manualPerChild || 0);
    const infantRaw = Number(opt.manualPerInfant || 0);
    const childPrice = childRaw ? roundInr(childRaw * markupMultiplier) : null;
    const infantPrice = infantRaw ? roundInr(infantRaw * markupMultiplier) : null;

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
        child_price: childPrice,
        infant_price: infantPrice,
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
          child_price: childPrice,
          infant_price: infantPrice,
        };
      }
    }
  }

  const grand = Number(input.grand_total || 0);
  if (grand > 0) {
    const co = opt as Record<string, unknown> | undefined;
    const allocated =
      (Number(co?.manualAdultsSingle) || 0) +
      (Number(co?.manualAdultsDouble) || 0) +
      (Number(co?.manualAdultsTriple) || 0) +
      (Number(co?.manualAdultsQuad) || 0);
    const divisor = allocated > 0 ? allocated : adults;
    const perPerson = roundInr(grand / divisor);
    if (perPerson) {
      return {
        twin_sharing_price: perPerson,
        triple_sharing_price: perPerson,
        single_sharing_price: null,
        quad_sharing_price: null,
        sales_price: perPerson,
        child_price: null,
        infant_price: null,
      };
    }
  }

  return empty;
}

function normalizeDisplayCurrency(raw: unknown): string {
  return String(raw || 'INR').toUpperCase().trim() || 'INR';
}

function inrToShelfUsd(inr: number | null | undefined, inrPerUsd: number): number | null {
  const n = Number(inr);
  if (!Number.isFinite(n) || n <= 0 || !Number.isFinite(inrPerUsd) || inrPerUsd <= 0) return null;
  return Math.round(n / inrPerUsd);
}

function sourceAmountToUsd(
  amount: number | null | undefined,
  displayCurrency: string,
  rates: Record<string, number>,
  inrPerUsd: number
): number | null {
  const inr = foreignAmountToInr(amount, displayCurrency, rates);
  return inrToShelfUsd(inr, inrPerUsd);
}

/** CRM amounts (AUD, etc.) → INR DB columns + USD meta for global storefront. */
async function convertCrmSharingPricesForWeb(
  source: CrmSharingPrices,
  displayCurrency: string
): Promise<{ inr: CrmSharingPrices; usd: TourMarketPricing | null }> {
  const currency = normalizeDisplayCurrency(displayCurrency);
  const [rates, inrPerUsd] = await Promise.all([fetchFxRatesToInr(), getInrPerUsd()]);

  const toInr = (amount: number | null) => foreignAmountToInr(amount, currency, rates);

  const inr: CrmSharingPrices = {
    twin_sharing_price: toInr(source.twin_sharing_price),
    triple_sharing_price: toInr(source.triple_sharing_price),
    single_sharing_price: toInr(source.single_sharing_price),
    quad_sharing_price: toInr(source.quad_sharing_price),
    sales_price: toInr(source.sales_price),
    child_price: toInr(source.child_price),
    infant_price: toInr(source.infant_price),
  };

  if (currency === 'INR') {
    return { inr, usd: null };
  }

  const usd: TourMarketPricing = {
    twin_sharing_price: sourceAmountToUsd(source.twin_sharing_price, currency, rates, inrPerUsd),
    triple_sharing_price: sourceAmountToUsd(source.triple_sharing_price, currency, rates, inrPerUsd),
    single_sharing_price: sourceAmountToUsd(source.single_sharing_price, currency, rates, inrPerUsd),
    quad_sharing_price: sourceAmountToUsd(source.quad_sharing_price, currency, rates, inrPerUsd),
    infant_price: sourceAmountToUsd(source.infant_price, currency, rates, inrPerUsd),
    child_price: sourceAmountToUsd(source.child_price, currency, rates, inrPerUsd),
    price_from:
      sourceAmountToUsd(source.twin_sharing_price ?? source.sales_price, currency, rates, inrPerUsd),
  };

  const hasUsd = Object.values(usd).some((v) => v != null && Number(v) > 0);
  return { inr, usd: hasUsd ? usd : null };
}

/** INR costing → India storefront; AUD/USD/etc. → Global storefront (USD display). */
function marketAudienceForCrmCurrency(displayCurrency: string): TourCmsMeta['market_audience'] {
  return normalizeDisplayCurrency(displayCurrency) === 'INR' ? 'india' : 'global';
}

function isSchemaColumnMismatch(errMsg: string): boolean {
  const m = String(errMsg || '').toLowerCase();
  return (
    m.includes('does not exist') ||
    m.includes('could not find') ||
    m.includes('schema cache') ||
    m.includes('unknown column')
  );
}

/** Insert or update tour; drops quad_sharing_price if column not migrated yet. */
async function writeTourRow(
  tourId: number | null,
  payload: Record<string, unknown>,
  mode: 'insert' | 'update'
): Promise<number> {
  const attempts: Record<string, unknown>[] = [payload];
  if (payload.quad_sharing_price !== undefined) {
    const { quad_sharing_price: _q, ...withoutQuad } = payload;
    attempts.push(withoutQuad);
  }

  let lastErr = '';
  for (const row of attempts) {
    if (mode === 'update' && tourId != null) {
      const { error } = await supabase.from('tours').update(row).eq('id', tourId);
      if (!error) return tourId;
      lastErr = String(error.message || '');
      if (!isSchemaColumnMismatch(lastErr)) throw new Error(lastErr);
      continue;
    }
    const { data, error } = await supabase.from('tours').insert(row).select('id').single();
    if (!error && data?.id) return Number(data.id);
    lastErr = String(error?.message || '');
    if (!isSchemaColumnMismatch(lastErr)) throw new Error(lastErr);
  }
  throw new Error(lastErr || 'Failed to save tour.');
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
        departure_airport_name: String(
          seg.from_airport_name || seg.from_airport || '',
        ).trim(),
        arrival_date: arr.slice(0, 10),
        arrival_time: arr.length > 10 ? arr.slice(11, 16) : '',
        arrival_airport_code: String(seg.to_airport || '').trim(),
        arrival_airport_name: String(seg.to_airport_name || seg.to_airport || '').trim(),
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

function storefrontMarketPrefix(marketAudience: TourCmsMeta['market_audience']): 'in' | 'au' {
  return marketAudience === 'global' ? 'au' : 'in';
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
  destSlugFallback: string | null | undefined,
  marketPrefix: 'in' | 'au'
): string {
  const base = String(baseUrl || 'https://web.maduratravel.com').replace(/\/$/, '');
  const embed = tourRow?.destination_ref ?? tourRow?.destinations;
  const embedSlug = Array.isArray(embed) ? embed[0]?.slug : embed?.slug;
  const destSlug = embedSlug || destSlugFallback || slugify(String(tourRow?.destination || ''));
  const titleSlug = tourRow?.slug;
  if (destSlug && titleSlug) {
    return `${base}/${marketPrefix}/${destSlug}/${titleSlug}`;
  }
  return `${base}/tours/${tourId}`;
}

function mapDefaultRoomsForPublish(
  input: PublishItineraryPayload,
  sourceTwin: number | null
): CrmDefaultRoom[] | undefined {
  const fromLead = mapLeadRequirementsToDefaultRooms(
    input.lead_requirements,
    input.adults,
    input.children
  );
  if (fromLead?.length) return fromLead;

  const opts = Array.isArray(input.costing_options) ? input.costing_options : [];
  const opt = opts[0] as Record<string, unknown> | undefined;
  const doubleAlloc = Number(opt?.manualAdultsDouble) || 0;
  const tripleAlloc = Number(opt?.manualAdultsTriple) || 0;
  const singleAlloc = Number(opt?.manualAdultsSingle) || 0;
  const quadAlloc = Number(opt?.manualAdultsQuad) || 0;
  const totalAlloc = doubleAlloc + tripleAlloc + singleAlloc + quadAlloc;

  if (doubleAlloc >= 2) {
    const roomCount = Math.max(1, Math.ceil(doubleAlloc / 2));
    const rooms: CrmDefaultRoom[] = [];
    let remaining = doubleAlloc;
    for (let i = 0; i < roomCount; i++) {
      const a = Math.min(2, remaining);
      rooms.push({ adults: a, children: 0, child_ages: [] });
      remaining -= a;
    }
    return rooms;
  }

  if (tripleAlloc >= 3) {
    const roomCount = Math.max(1, Math.ceil(tripleAlloc / 3));
    const rooms: CrmDefaultRoom[] = [];
    let remaining = tripleAlloc;
    for (let i = 0; i < roomCount; i++) {
      const a = Math.min(3, remaining);
      rooms.push({ adults: a, children: 0, child_ages: [] });
      remaining -= a;
    }
    return rooms;
  }

  const adults = totalAlloc || Math.max(1, Number(input.adults) || 1);
  const perRoom = sourceTwin && sourceTwin > 0 ? Math.min(4, Math.max(1, adults)) : 2;
  const roomCount = Math.max(1, Math.ceil(adults / perRoom));
  const rooms: CrmDefaultRoom[] = [];
  let remaining = adults;
  for (let i = 0; i < roomCount; i++) {
    const a = Math.min(perRoom, remaining);
    rooms.push({ adults: a, children: 0, child_ages: [] });
    remaining -= a;
  }
  return rooms;
}

function mapLeadRequirementsToDefaultRooms(
  req: PublishItineraryPayload['lead_requirements'],
  metaAdults?: number | null,
  metaChildren?: number | null
): CrmDefaultRoom[] | undefined {
  const rooms = req?.rooms;
  if (Array.isArray(rooms) && rooms.length > 0) {
    const mapped = rooms
      .map((r) => ({
        adults: Math.max(1, Number(r.adults) || 1),
        children: Math.max(0, Number(r.children) || 0),
        child_ages: Array.isArray(r.child_ages)
          ? r.child_ages.map((a) => Math.max(0, Number(a) || 0))
          : [],
      }))
      .filter((r) => r.adults > 0 || r.children > 0);
    if (mapped.length) return mapped;
  }

  const adults = Math.max(0, Number(req?.adults ?? metaAdults) || 0);
  const children = Math.max(0, Number(req?.children ?? metaChildren) || 0);
  if (adults + children <= 0) return undefined;

  const childAges = Array.isArray(req?.child_ages)
    ? req.child_ages.map((a) => Math.max(0, Number(a) || 0))
    : [];
  while (childAges.length < children) childAges.push(0);

  return [{ adults: Math.max(1, adults), children, child_ages: childAges.slice(0, children) }];
}

async function fetchExistingTourMedia(tourId: number): Promise<{
  hero_image_url: string | null;
  gallery_image_urls: string[];
}> {
  const { data } = await supabase
    .from('tours')
    .select('hero_image_url,gallery_image_urls')
    .eq('id', tourId)
    .maybeSingle();
  const hero = String(data?.hero_image_url || '').trim() || null;
  const gallery = Array.isArray(data?.gallery_image_urls)
    ? data.gallery_image_urls.map((u) => String(u || '').trim()).filter(Boolean).slice(0, 4)
    : [];
  return { hero_image_url: hero, gallery_image_urls: gallery };
}

async function pickStockImageUrls(query: string, count: number): Promise<string[]> {
  const q = String(query || 'travel destination').trim() || 'travel';
  try {
    const { items } = await searchStockImages(q, 1);
    const urls: string[] = [];
    for (const item of items) {
      const url = String(item.full_url || item.preview_url || '').trim();
      if (!url || urls.includes(url)) continue;
      urls.push(url);
      if (urls.length >= count) break;
    }
    return urls;
  } catch (err) {
    console.warn('[publish-itinerary] stock image search skipped:', err);
    return [];
  }
}

async function resolvePublishMedia(input: {
  cover_image_url?: string | null;
  gallery_image_urls?: string[] | null;
  destination?: string | null;
  creative_title?: string | null;
  existingTourId?: number | null;
}): Promise<{ hero_image_url: string | null; gallery_image_urls: string[] }> {
  let hero = String(input.cover_image_url || '').trim();
  let gallery = Array.isArray(input.gallery_image_urls)
    ? input.gallery_image_urls.map((u) => String(u || '').trim()).filter(Boolean).slice(0, 4)
    : [];

  if (input.existingTourId && (!hero || gallery.length < 4)) {
    const existing = await fetchExistingTourMedia(input.existingTourId);
    if (!hero && existing.hero_image_url) hero = existing.hero_image_url;
    for (const url of existing.gallery_image_urls) {
      if (gallery.length >= 4) break;
      if (url && url !== hero && !gallery.includes(url)) gallery.push(url);
    }
  }

  const need = (hero ? 0 : 1) + Math.max(0, 4 - gallery.length);
  if (need > 0) {
    const stockQuery = [input.destination, input.creative_title, 'travel'].filter(Boolean).join(' ');
    const stock = await pickStockImageUrls(stockQuery, need + 4);
    if (!hero && stock[0]) {
      hero = stock[0];
      gallery = gallery.filter((u) => u !== hero);
    }
    for (const url of stock) {
      if (gallery.length >= 4) break;
      if (!url || url === hero || gallery.includes(url)) continue;
      gallery.push(url);
    }
  }

  return {
    hero_image_url: hero || null,
    gallery_image_urls: gallery.slice(0, 4),
  };
}

export async function publishItineraryToTour(
  input: PublishItineraryPayload,
  webPublicBaseUrl: string
): Promise<{
  tourId: number;
  slug: string;
  publicUrl: string;
  publicUrlIn: string;
  publicUrlAu: string;
  market_audience: TourCmsMeta['market_audience'];
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

  const existingTourId = await findExistingTourForItinerary(itineraryId);

  let priorMeta: TourCmsMeta = {};
  if (existingTourId) {
    const { data: existingRow } = await supabase
      .from('tours')
      .select('overview')
      .eq('id', existingTourId)
      .maybeSingle();
    priorMeta = splitOverviewWithMeta(existingRow?.overview).meta;
  }

  const displayCurrency = normalizeDisplayCurrency(input.display_currency);
  const sourceSharingPrices = deriveCrmSharingPrices({
    costing_options: input.costing_options,
    adults: input.adults,
    children: input.children,
    infants: input.infants,
    grand_total: input.grand_total,
  });
  const defaultRooms = mapDefaultRoomsForPublish(input, sourceSharingPrices.twin_sharing_price);
  const costingOpt = Array.isArray(input.costing_options)
    ? (input.costing_options[0] as Record<string, unknown> | undefined)
    : undefined;
  const snapshotAdults =
    Number(costingOpt?.manualAdultsDouble) ||
    Number(costingOpt?.manualAdultsTriple) ||
    Number(costingOpt?.manualAdultsSingle) ||
    Number(costingOpt?.manualAdultsQuad) ||
    Math.max(1, Number(input.adults) || 1);
  const snapshotPerPerson = sourceSharingPrices.twin_sharing_price;
  const snapshotTotal =
    Number(input.grand_total) > 0
      ? Number(input.grand_total)
      : snapshotPerPerson && snapshotAdults > 0
        ? Math.round(snapshotPerPerson * snapshotAdults * 100) / 100
        : null;

  const { inr: sharingPrices, usd: pricingUsd } = await convertCrmSharingPricesForWeb(
    sourceSharingPrices,
    displayCurrency
  );

  const marketAudience = marketAudienceForCrmCurrency(displayCurrency);
  const cmsMeta: TourCmsMeta = {
    ...priorMeta,
    crm_itinerary_id: itineraryId,
    crm_engagement_enabled: true,
    crm_source_currency: displayCurrency,
    crm_display_prices: {
      currency: displayCurrency,
      twin_sharing_price: sourceSharingPrices.twin_sharing_price,
      triple_sharing_price: sourceSharingPrices.triple_sharing_price,
      single_sharing_price: sourceSharingPrices.single_sharing_price,
      quad_sharing_price: sourceSharingPrices.quad_sharing_price,
      child_price: sourceSharingPrices.child_price,
      infant_price: sourceSharingPrices.infant_price,
    },
    crm_costing_snapshot: {
      currency: displayCurrency,
      per_person: snapshotPerPerson,
      total: snapshotTotal,
      adults: snapshotAdults,
      children: Math.max(0, Number(input.children) || 0),
      sharing_label: 'Twin sharing',
    },
    market_audience: marketAudience,
    tour_program_type: 'flexible',
    tour_category: priorMeta.tour_category || 'Family',
    flights: webFlights.length ? webFlights : undefined,
    hotels: webHotels.length ? webHotels : undefined,
    default_rooms: defaultRooms?.length ? defaultRooms : priorMeta.default_rooms,
  };
  if (marketAudience === 'global' && pricingUsd) {
    cmsMeta.pricing_usd = pricingUsd;
  } else {
    delete cmsMeta.pricing_usd;
  }

  const overview = joinOverviewWithMeta(overviewBody, cmsMeta);

  const baseSlug = titleTourSlug(title, itineraryId);
  const slug = await uniqueSlug(baseSlug, existingTourId ?? undefined);

  const media = await resolvePublishMedia({
    cover_image_url: input.cover_image_url,
    gallery_image_urls: input.gallery_image_urls,
    destination: input.destination,
    creative_title: input.creative_title,
    existingTourId,
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
    hero_image_url: media.hero_image_url,
    gallery_image_urls: media.gallery_image_urls,
    overview,
    tour_includes: tourIncludes,
    tour_exclusions: splitBulletLines(String(input.exclusions || '')),
    itinerary_days: itineraryDays,
    twin_sharing_price: sharingPrices.twin_sharing_price,
    triple_sharing_price: sharingPrices.triple_sharing_price,
    single_sharing_price: sharingPrices.single_sharing_price,
    quad_sharing_price: sharingPrices.quad_sharing_price,
    sales_price: sharingPrices.sales_price,
    child_price: sharingPrices.child_price,
    infant_price: sharingPrices.infant_price,
  };

  let tourId: number;
  let updated = false;
  if (existingTourId) {
    tourId = existingTourId;
    await writeTourRow(tourId, payload, 'update');
    updated = true;
  } else {
    tourId = await writeTourRow(null, payload, 'insert');
  }

  const { data: tourRow } = await supabase
    .from('tours')
    .select(
      'id,slug,destination,destination_ref:destinations(slug),destinations(slug)'
    )
    .eq('id', tourId)
    .maybeSingle();

  const tourForUrl = tourRow as Parameters<typeof buildPublicTourUrl>[2];
  const publicUrlIn = buildPublicTourUrl(webPublicBaseUrl, tourId, tourForUrl, dest.slug, 'in');
  const publicUrlAu = buildPublicTourUrl(webPublicBaseUrl, tourId, tourForUrl, dest.slug, 'au');
  const canonicalUrl =
    marketAudience === 'global' ? publicUrlAu : publicUrlIn;

  return {
    tourId,
    slug,
    publicUrl: canonicalUrl,
    publicUrlIn,
    publicUrlAu,
    market_audience: marketAudience,
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
  publicUrlIn?: string;
  publicUrlAu?: string;
  market_audience?: TourCmsMeta['market_audience'];
  directUrl?: string;
}> {
  const tourId = await findExistingTourForItinerary(itineraryId);
  if (!tourId) return { published: false };

  const { data: tour } = await supabase
    .from('tours')
    .select(
      'id,slug,visibility_status,overview,destination,destination_id,destination_ref:destinations(slug),destinations(slug)'
    )
    .eq('id', tourId)
    .maybeSingle();
  if (!tour?.id) return { published: false };

  const linkMeta = splitOverviewWithMeta(
    (tour as { overview?: string | null }).overview
  ).meta;
  const marketPrefix = storefrontMarketPrefix(linkMeta.market_audience);

  let destSlug: string | null = null;
  if (tour.destination_id) {
    const { data: d } = await supabase
      .from('destinations')
      .select('slug')
      .eq('id', tour.destination_id)
      .maybeSingle();
    destSlug = d?.slug ?? null;
  }

  const tourForUrl = tour as Parameters<typeof buildPublicTourUrl>[2];
  const publicUrlIn = buildPublicTourUrl(
    webPublicBaseUrl,
    Number(tour.id),
    tourForUrl,
    destSlug,
    'in'
  );
  const publicUrlAu = buildPublicTourUrl(
    webPublicBaseUrl,
    Number(tour.id),
    tourForUrl,
    destSlug,
    'au'
  );

  return {
    published: true,
    tourId: Number(tour.id),
    slug: tour.slug,
    visibility_status: (tour.visibility_status as TourVisibilityStatus) || 'unlisted',
    publicUrl: marketPrefix === 'au' ? publicUrlAu : publicUrlIn,
    publicUrlIn,
    publicUrlAu,
    market_audience: linkMeta.market_audience,
    directUrl: `${webPublicBaseUrl.replace(/\/$/, '')}/tours/${tour.id}`,
  };
}
