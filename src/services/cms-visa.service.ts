import { supabase } from '../lib/supabase';
import { sanitizeCmsHtml } from '../lib/html-sanitize';
import { computeVisaListingMetaFromVisaTypes, inferFilterVisaTypeFromName } from './visa-listing-meta';

export type VisaFilterVisaType = 'visa_free' | 'visa_on_arrival' | 'e_visa' | 'sticker';
export type VisaFilterDocumentLevel =
  | 'any'
  | 'passport_only'
  | 'passport_bank'
  | 'passport_bank_itr'
  | 'with_us_uk_schengen';
export type VisaFilterDeliveryBucket =
  | 'any'
  | 'instant'
  | 'within_24h'
  | '3_5_days'
  | '6_7_days'
  | '8_30_days';

export type VisaDocumentSection = {
  title?: string | null;
  items: string[];
};

export type VisaDocumentsRequired = {
  sections: VisaDocumentSection[];
};

export type VisaPartner = {
  name: string;
  logo_url: string;
};

export type VisaFaq = {
  question: string;
  answer: string;
};

export type VisaTypeOption = {
  id: string;
  name: string;
  visa_format: string;
  processing_time: string;
  stay_period: string;
  validity: string;
  entry: string;
  fees_inr: number;
  is_popular?: boolean;
  documents_required: VisaDocumentsRequired;
  visa_requirements: string[];
  sample_visa_image_url: string | null;
};

export type CmsVisaPage = {
  id: number;
  slug: string;
  title: string;
  country_name: string;
  flag_iso: string | null;
  is_published: boolean;
  sort_order: number;
  market: string;
  hero_images: string[];
  delivery_promise_text: string | null;
  starting_price_inr: number | null;
  validity_label: string | null;
  overview_html: string | null;
  visa_type_label: string | null;
  validity_period: string | null;
  length_of_stay: string | null;
  entry_type: string | null;
  visa_method: string | null;
  documents_required: VisaDocumentsRequired;
  visa_requirements: string[];
  travel_checklist: string[];
  partners: VisaPartner[];
  faqs: VisaFaq[];
  filter_visa_type: VisaFilterVisaType;
  filter_document_level: VisaFilterDocumentLevel;
  filter_delivery_bucket: VisaFilterDeliveryBucket;
  processing_days: number | null;
  visa_types: VisaTypeOption[];
  created_at: string | null;
  updated_at: string | null;
};

export type VisaListingFilters = {
  filter_visa_type?: VisaFilterVisaType | 'all';
  filter_document_level?: VisaFilterDocumentLevel | 'all';
  filter_delivery_bucket?: VisaFilterDeliveryBucket | 'all';
};

export type VisaFilterFacetOption = {
  value: string;
  label: string;
  count: number;
};

export type VisaFilterFacets = {
  visa_type: VisaFilterFacetOption[];
  document_level: VisaFilterFacetOption[];
  delivery_bucket: VisaFilterFacetOption[];
};

export const VISA_FILTER_VISA_TYPE_OPTIONS: VisaFilterFacetOption[] = [
  { value: 'all', label: 'All Visa Types', count: 0 },
  { value: 'visa_free', label: 'Visa Free', count: 0 },
  { value: 'visa_on_arrival', label: 'Visa on Arrival', count: 0 },
  { value: 'e_visa', label: 'e-Visa', count: 0 },
  { value: 'sticker', label: 'Sticker Visa', count: 0 },
];

export const VISA_FILTER_DOCUMENT_OPTIONS: VisaFilterFacetOption[] = [
  { value: 'all', label: 'Any Documents', count: 0 },
  { value: 'passport_only', label: 'Only Passport', count: 0 },
  { value: 'passport_bank', label: 'Passport & Bank Statements', count: 0 },
  { value: 'passport_bank_itr', label: 'Passport, Bank Statements & Income Tax Return', count: 0 },
  { value: 'with_us_uk_schengen', label: 'With US/UK/Schengen visa', count: 0 },
];

export const VISA_FILTER_DELIVERY_OPTIONS: VisaFilterFacetOption[] = [
  { value: 'all', label: 'Any Time', count: 0 },
  { value: 'instant', label: 'Instant', count: 0 },
  { value: 'within_24h', label: 'Within 24 Hours', count: 0 },
  { value: '3_5_days', label: '3–5 Days', count: 0 },
  { value: '6_7_days', label: '6–7 Days', count: 0 },
  { value: '8_30_days', label: '8–30 Days', count: 0 },
];

type VisaRow = {
  id: number;
  slug: string;
  title: string;
  country_name: string;
  flag_iso?: string | null;
  is_published?: boolean | null;
  sort_order?: number | null;
  market?: string | null;
  hero_images?: unknown;
  delivery_promise_text?: string | null;
  starting_price_inr?: number | null;
  validity_label?: string | null;
  overview_html?: string | null;
  visa_type_label?: string | null;
  validity_period?: string | null;
  length_of_stay?: string | null;
  entry_type?: string | null;
  visa_method?: string | null;
  documents_required?: unknown;
  visa_requirements?: unknown;
  travel_checklist?: unknown;
  partners?: unknown;
  faqs?: unknown;
  filter_visa_type?: string | null;
  filter_document_level?: string | null;
  filter_delivery_bucket?: string | null;
  processing_days?: number | null;
  visa_types?: unknown;
  created_at?: string | null;
  updated_at?: string | null;
};

const SELECT_COLS =
  'id,slug,title,country_name,flag_iso,is_published,sort_order,market,hero_images,delivery_promise_text,starting_price_inr,validity_label,overview_html,visa_type_label,validity_period,length_of_stay,entry_type,visa_method,documents_required,visa_requirements,travel_checklist,partners,faqs,filter_visa_type,filter_document_level,filter_delivery_bucket,processing_days,visa_types,created_at,updated_at';

function isMissingVisaTable(message: string): boolean {
  const m = String(message || '').toLowerCase();
  return (
    m.includes('cms_visa_pages') &&
    (m.includes('does not exist') || m.includes('could not find') || m.includes('schema cache'))
  );
}

export function normalizeVisaSlug(raw: string): string {
  return String(raw || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizeDocumentsRequired(raw: unknown): VisaDocumentsRequired {
  if (!raw || typeof raw !== 'object') return { sections: [] };
  const obj = raw as { sections?: unknown };
  if (!Array.isArray(obj.sections)) return { sections: [] };
  return {
    sections: obj.sections
      .map((section) => {
        if (!section || typeof section !== 'object') return null;
        const s = section as { title?: unknown; items?: unknown };
        const items = normalizeStringList(s.items);
        if (items.length === 0 && !String(s.title || '').trim()) return null;
        return {
          title: String(s.title || '').trim() || null,
          items,
        };
      })
      .filter(Boolean) as VisaDocumentSection[],
  };
}

function normalizePartners(raw: unknown): VisaPartner[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const p = item as { name?: unknown; logo_url?: unknown };
      const name = String(p.name || '').trim();
      const logo_url = String(p.logo_url || '').trim();
      if (!name && !logo_url) return null;
      return { name, logo_url };
    })
    .filter(Boolean) as VisaPartner[];
}

function normalizeFaqs(raw: unknown): VisaFaq[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const f = item as { question?: unknown; answer?: unknown };
      const question = String(f.question || '').trim();
      if (!question) return null;
      return { question, answer: String(f.answer || '').trim() };
    })
    .filter(Boolean) as VisaFaq[];
}

function sameStringList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

function dedupeTypeRequirements(types: VisaTypeOption[], globalRequirements: string[]): VisaTypeOption[] {
  return types.map((type) => ({
    ...type,
    visa_requirements:
      type.visa_requirements.length > 0 && sameStringList(type.visa_requirements, globalRequirements)
        ? []
        : type.visa_requirements,
  }));
}

function visaFormatLabelFromFilter(format: VisaFilterVisaType): string {
  const map: Record<VisaFilterVisaType, string> = {
    visa_free: 'Visa Free',
    visa_on_arrival: 'Visa on Arrival',
    e_visa: 'E-Visa',
    sticker: 'Sticker Visa',
  };
  return map[format];
}

function normalizeVisaFormatText(raw: unknown, name: string): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return visaFormatLabelFromFilter(inferFilterVisaTypeFromName(name));
  const slugLabels: Record<string, string> = {
    e_visa: 'E-Visa',
    sticker: 'Sticker Visa',
    visa_on_arrival: 'Visa on Arrival',
    visa_free: 'Visa Free',
  };
  return slugLabels[trimmed] || slugLabels[trimmed.toLowerCase()] || trimmed;
}

function newVisaTypeId(): string {
  return `vt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeVisaTypes(raw: unknown): VisaTypeOption[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const v = item as {
        id?: unknown;
        name?: unknown;
        visa_format?: unknown;
        processing_time?: unknown;
        stay_period?: unknown;
        validity?: unknown;
        entry?: unknown;
        fees_inr?: unknown;
        is_popular?: unknown;
        documents_required?: unknown;
        visa_requirements?: unknown;
        sample_visa_image_url?: unknown;
      };
      const name = String(v.name || '').trim();
      if (!name) return null;
      const fees = Number(v.fees_inr);
      return {
        id: String(v.id || '').trim() || newVisaTypeId(),
        name,
        visa_format: normalizeVisaFormatText(v.visa_format, name),
        processing_time: String(v.processing_time || '').trim(),
        stay_period: String(v.stay_period || '').trim(),
        validity: String(v.validity || '').trim(),
        entry: String(v.entry || '').trim(),
        fees_inr: Number.isFinite(fees) ? fees : 0,
        is_popular: v.is_popular === true,
        documents_required: normalizeDocumentsRequired(v.documents_required),
        visa_requirements: normalizeStringList(v.visa_requirements),
        sample_visa_image_url: String(v.sample_visa_image_url || '').trim() || null,
      };
    })
    .filter(Boolean) as VisaTypeOption[];
}

export function computeStartingPriceFromVisaTypes(types: VisaTypeOption[]): number | null {
  return computeVisaListingMetaFromVisaTypes(types).starting_price_inr;
}

function applyListingMetaToRow(row: Record<string, unknown>, visaTypes: VisaTypeOption[]): void {
  const meta = computeVisaListingMetaFromVisaTypes(visaTypes);
  row.starting_price_inr = meta.starting_price_inr;
  row.validity_label = meta.validity_label;
  row.processing_days = meta.processing_days;
  row.filter_visa_type = meta.filter_visa_type;
  row.filter_document_level = meta.filter_document_level;
  row.filter_delivery_bucket = meta.filter_delivery_bucket;
  row.visa_type_label = meta.visa_type_label;
  row.validity_period = null;
  row.length_of_stay = null;
  row.entry_type = null;
  row.visa_method = null;
  row.documents_required = { sections: [] };
}

function assertVisaTypesProvided(raw: unknown): VisaTypeOption[] {
  const visaTypes = normalizeVisaTypes(raw);
  if (visaTypes.length === 0) {
    throw new Error('Add at least one visa type with a name.');
  }
  return visaTypes;
}

function normalizeHeroImages(raw: unknown): string[] {
  return normalizeStringList(raw);
}

const VISA_TYPE_VALUES = new Set<string>(['visa_free', 'visa_on_arrival', 'e_visa', 'sticker']);
const DOCUMENT_LEVEL_VALUES = new Set<string>([
  'any',
  'passport_only',
  'passport_bank',
  'passport_bank_itr',
  'with_us_uk_schengen',
]);
const DELIVERY_BUCKET_VALUES = new Set<string>([
  'any',
  'instant',
  'within_24h',
  '3_5_days',
  '6_7_days',
  '8_30_days',
]);

function normalizeFilterVisaType(raw: unknown): VisaFilterVisaType {
  const v = String(raw || 'e_visa').trim();
  return VISA_TYPE_VALUES.has(v) ? (v as VisaFilterVisaType) : 'e_visa';
}

function normalizeFilterDocumentLevel(raw: unknown): VisaFilterDocumentLevel {
  const v = String(raw || 'any').trim();
  return DOCUMENT_LEVEL_VALUES.has(v) ? (v as VisaFilterDocumentLevel) : 'any';
}

function normalizeFilterDeliveryBucket(raw: unknown): VisaFilterDeliveryBucket {
  const v = String(raw || 'any').trim();
  return DELIVERY_BUCKET_VALUES.has(v) ? (v as VisaFilterDeliveryBucket) : 'any';
}

function normalizeMarket(raw: unknown): string {
  const v = String(raw || 'in').trim().toLowerCase();
  if (v === 'au' || v === 'all') return v;
  return 'in';
}

function mapVisaRow(row: VisaRow): CmsVisaPage {
  const visaTypes = normalizeVisaTypes(row.visa_types);
  const listingMeta = visaTypes.length > 0 ? computeVisaListingMetaFromVisaTypes(visaTypes) : null;

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    country_name: row.country_name,
    flag_iso: row.flag_iso ?? null,
    is_published: row.is_published === true,
    sort_order: Number(row.sort_order) || 0,
    market: normalizeMarket(row.market),
    hero_images: normalizeHeroImages(row.hero_images),
    delivery_promise_text: row.delivery_promise_text ?? null,
    starting_price_inr: listingMeta?.starting_price_inr ??
      (row.starting_price_inr != null && Number.isFinite(Number(row.starting_price_inr))
        ? Number(row.starting_price_inr)
        : null),
    validity_label: listingMeta?.validity_label ?? row.validity_label ?? null,
    overview_html: row.overview_html ?? null,
    visa_type_label: listingMeta?.visa_type_label ?? row.visa_type_label ?? null,
    validity_period: row.validity_period ?? null,
    length_of_stay: row.length_of_stay ?? null,
    entry_type: row.entry_type ?? null,
    visa_method: row.visa_method ?? null,
    documents_required: normalizeDocumentsRequired(row.documents_required),
    visa_requirements: normalizeStringList(row.visa_requirements),
    travel_checklist: normalizeStringList(row.travel_checklist),
    partners: normalizePartners(row.partners),
    faqs: normalizeFaqs(row.faqs),
    filter_visa_type: listingMeta?.filter_visa_type ?? normalizeFilterVisaType(row.filter_visa_type),
    filter_document_level:
      listingMeta?.filter_document_level ?? normalizeFilterDocumentLevel(row.filter_document_level),
    filter_delivery_bucket:
      listingMeta?.filter_delivery_bucket ?? normalizeFilterDeliveryBucket(row.filter_delivery_bucket),
    processing_days:
      listingMeta?.processing_days ??
      (row.processing_days != null && Number.isFinite(Number(row.processing_days))
        ? Number(row.processing_days)
        : null),
    visa_types: visaTypes,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
  };
}

function marketMatches(pageMarket: string, requestMarket: string): boolean {
  const m = normalizeMarket(requestMarket);
  const pm = normalizeMarket(pageMarket);
  return pm === 'all' || pm === m;
}

async function selectVisaPages(opts?: { publishedOnly?: boolean; market?: string }): Promise<VisaRow[]> {
  let query = supabase.from('cms_visa_pages').select(SELECT_COLS);
  if (opts?.publishedOnly) query = query.eq('is_published', true);
  const result = await query.order('sort_order', { ascending: true }).order('country_name', { ascending: true });
  if (result.error) {
    if (isMissingVisaTable(result.error.message)) {
      throw new Error('Visa pages table is missing. Run sql/cms_visa_pages.sql on Supabase.');
    }
    throw new Error(result.error.message);
  }
  let rows = ((result.data || []) as unknown) as VisaRow[];
  if (opts?.market) {
    rows = rows.filter((row) => marketMatches(String(row.market || 'in'), opts.market!));
  }
  return rows;
}

async function selectVisaPageById(id: number): Promise<VisaRow | null> {
  const result = await supabase.from('cms_visa_pages').select(SELECT_COLS).eq('id', id).maybeSingle();
  if (result.error) {
    if (isMissingVisaTable(result.error.message)) return null;
    throw new Error(result.error.message);
  }
  return (result.data as VisaRow | null) ?? null;
}

async function selectVisaPageBySlug(slug: string): Promise<VisaRow | null> {
  const result = await supabase.from('cms_visa_pages').select(SELECT_COLS).eq('slug', slug).maybeSingle();
  if (result.error) {
    if (isMissingVisaTable(result.error.message)) return null;
    throw new Error(result.error.message);
  }
  return (result.data as VisaRow | null) ?? null;
}

export async function listVisaPages(opts?: { publishedOnly?: boolean; market?: string }): Promise<CmsVisaPage[]> {
  const rows = await selectVisaPages(opts);
  return rows.map((row) => mapVisaRow(row));
}

export async function getVisaPage(id: number): Promise<CmsVisaPage | null> {
  const row = await selectVisaPageById(id);
  return row ? mapVisaRow(row) : null;
}

export async function getVisaPageBySlug(slug: string): Promise<CmsVisaPage | null> {
  const normalized = normalizeVisaSlug(slug);
  if (!normalized) return null;
  const row = await selectVisaPageBySlug(normalized);
  return row ? mapVisaRow(row) : null;
}

export async function getPublishedVisaPageBySlug(slug: string, market: string): Promise<CmsVisaPage | null> {
  const row = await getVisaPageBySlug(slug);
  if (!row || !row.is_published) return null;
  if (!marketMatches(row.market, market)) return null;
  return row;
}

function applyListingFilters(rows: CmsVisaPage[], filters?: VisaListingFilters): CmsVisaPage[] {
  if (!filters) return rows;
  return rows.filter((row) => {
    if (filters.filter_visa_type && filters.filter_visa_type !== 'all') {
      if (row.filter_visa_type !== filters.filter_visa_type) return false;
    }
    if (filters.filter_document_level && filters.filter_document_level !== 'all') {
      if (row.filter_document_level !== filters.filter_document_level) return false;
    }
    if (filters.filter_delivery_bucket && filters.filter_delivery_bucket !== 'all') {
      if (row.filter_delivery_bucket !== filters.filter_delivery_bucket) return false;
    }
    return true;
  });
}

function countByField(rows: CmsVisaPage[], field: keyof CmsVisaPage, options: VisaFilterFacetOption[]): VisaFilterFacetOption[] {
  return options.map((opt) => {
    if (opt.value === 'all') {
      return { ...opt, count: rows.length };
    }
    const count = rows.filter((row) => String(row[field]) === opt.value).length;
    return { ...opt, count };
  });
}

export function computeVisaFilterFacets(rows: CmsVisaPage[]): VisaFilterFacets {
  return {
    visa_type: countByField(rows, 'filter_visa_type', VISA_FILTER_VISA_TYPE_OPTIONS),
    document_level: countByField(rows, 'filter_document_level', VISA_FILTER_DOCUMENT_OPTIONS),
    delivery_bucket: countByField(rows, 'filter_delivery_bucket', VISA_FILTER_DELIVERY_OPTIONS),
  };
}

export async function listPublishedVisas(
  market: string,
  filters?: VisaListingFilters
): Promise<{ items: CmsVisaPage[]; facets: VisaFilterFacets }> {
  const all = await listVisaPages({ publishedOnly: true, market });
  const facets = computeVisaFilterFacets(all);
  const items = applyListingFilters(all, filters);
  return { items, facets };
}

export async function getVisaFilterFacets(market: string): Promise<VisaFilterFacets> {
  const all = await listVisaPages({ publishedOnly: true, market });
  return computeVisaFilterFacets(all);
}

async function ensureUniqueSlug(base: string, excludeId?: number): Promise<string> {
  let slug = normalizeVisaSlug(base);
  if (!slug) slug = `visa-${Date.now().toString(36)}`;
  let candidate = slug;
  let n = 2;
  while (true) {
    const existing = await getVisaPageBySlug(candidate);
    if (!existing || (excludeId != null && existing.id === excludeId)) return candidate;
    candidate = `${slug}-${n}`;
    n += 1;
  }
}

function visaInputToDb(input: Partial<CmsVisaPage>, existing?: CmsVisaPage): Record<string, unknown> {
  const now = new Date().toISOString();
  const row: Record<string, unknown> = { updated_at: now };
  if (input.slug !== undefined) row.slug = input.slug ? normalizeVisaSlug(input.slug) : null;
  if (input.title !== undefined) row.title = String(input.title || '').trim();
  if (input.country_name !== undefined) row.country_name = String(input.country_name || '').trim();
  if (input.flag_iso !== undefined) row.flag_iso = input.flag_iso?.trim() || null;
  if (input.is_published !== undefined) row.is_published = input.is_published === true;
  if (input.sort_order !== undefined) row.sort_order = Number(input.sort_order) || 0;
  if (input.market !== undefined) row.market = normalizeMarket(input.market);
  if (input.hero_images !== undefined) row.hero_images = normalizeHeroImages(input.hero_images);
  if (input.delivery_promise_text !== undefined) {
    row.delivery_promise_text = input.delivery_promise_text?.trim() || null;
  }
  if (input.starting_price_inr !== undefined) {
    row.starting_price_inr =
      input.starting_price_inr != null && Number.isFinite(Number(input.starting_price_inr))
        ? Number(input.starting_price_inr)
        : null;
  }
  if (input.validity_label !== undefined) row.validity_label = input.validity_label?.trim() || null;
  if (input.overview_html !== undefined) row.overview_html = sanitizeCmsHtml(input.overview_html);
  if (input.visa_type_label !== undefined) row.visa_type_label = input.visa_type_label?.trim() || null;
  if (input.validity_period !== undefined) row.validity_period = input.validity_period?.trim() || null;
  if (input.length_of_stay !== undefined) row.length_of_stay = input.length_of_stay?.trim() || null;
  if (input.entry_type !== undefined) row.entry_type = input.entry_type?.trim() || null;
  if (input.visa_method !== undefined) row.visa_method = input.visa_method?.trim() || null;
  if (input.documents_required !== undefined) {
    row.documents_required = normalizeDocumentsRequired(input.documents_required);
  }
  if (input.visa_requirements !== undefined) {
    row.visa_requirements = normalizeStringList(input.visa_requirements);
  }
  if (input.travel_checklist !== undefined) {
    row.travel_checklist = normalizeStringList(input.travel_checklist);
  }
  if (input.partners !== undefined) row.partners = normalizePartners(input.partners);
  if (input.faqs !== undefined) row.faqs = normalizeFaqs(input.faqs);
  if (input.filter_visa_type !== undefined) {
    row.filter_visa_type = normalizeFilterVisaType(input.filter_visa_type);
  }
  if (input.filter_document_level !== undefined) {
    row.filter_document_level = normalizeFilterDocumentLevel(input.filter_document_level);
  }
  if (input.filter_delivery_bucket !== undefined) {
    row.filter_delivery_bucket = normalizeFilterDeliveryBucket(input.filter_delivery_bucket);
  }
  if (input.processing_days !== undefined) {
    row.processing_days =
      input.processing_days != null && Number.isFinite(Number(input.processing_days))
        ? Number(input.processing_days)
        : null;
  }
  if (input.visa_types !== undefined) {
    const visaTypes = assertVisaTypesProvided(input.visa_types);
    const globalRequirements =
      input.visa_requirements !== undefined
        ? normalizeStringList(input.visa_requirements)
        : normalizeStringList(existing?.visa_requirements);
    row.visa_types = dedupeTypeRequirements(visaTypes, globalRequirements);
    applyListingMetaToRow(row, row.visa_types as VisaTypeOption[]);
  }
  return row;
}

export async function createVisaPage(input: Partial<CmsVisaPage>): Promise<CmsVisaPage> {
  const title = String(input.title || '').trim();
  const country_name = String(input.country_name || '').trim();
  if (!title) throw new Error('Visa page title is required.');
  if (!country_name) throw new Error('Country name is required.');
  const globalRequirements = normalizeStringList(input.visa_requirements);
  const visaTypes = dedupeTypeRequirements(assertVisaTypesProvided(input.visa_types), globalRequirements);
  const listingMeta = computeVisaListingMetaFromVisaTypes(visaTypes);
  const slug = await ensureUniqueSlug(input.slug || title);
  const now = new Date().toISOString();
  const payload = {
    slug,
    title,
    country_name,
    flag_iso: input.flag_iso?.trim() || null,
    is_published: input.is_published === true,
    sort_order: Number(input.sort_order) || 0,
    market: normalizeMarket(input.market),
    hero_images: normalizeHeroImages(input.hero_images),
    delivery_promise_text: input.delivery_promise_text?.trim() || null,
    starting_price_inr: listingMeta.starting_price_inr,
    validity_label: listingMeta.validity_label,
    overview_html: sanitizeCmsHtml(input.overview_html),
    visa_type_label: listingMeta.visa_type_label,
    validity_period: null,
    length_of_stay: null,
    entry_type: null,
    visa_method: null,
    documents_required: { sections: [] },
    visa_requirements: globalRequirements,
    travel_checklist: normalizeStringList(input.travel_checklist),
    partners: normalizePartners(input.partners),
    faqs: normalizeFaqs(input.faqs),
    filter_visa_type: listingMeta.filter_visa_type,
    filter_document_level: listingMeta.filter_document_level,
    filter_delivery_bucket: listingMeta.filter_delivery_bucket,
    processing_days: listingMeta.processing_days,
    visa_types: visaTypes,
    created_at: now,
    updated_at: now,
  };
  const { data, error } = await supabase.from('cms_visa_pages').insert(payload).select(SELECT_COLS).single();
  if (error) {
    if (isMissingVisaTable(error.message)) {
      throw new Error('Visa pages table is missing. Run sql/cms_visa_pages.sql on Supabase.');
    }
    throw new Error(error.message);
  }
  return mapVisaRow(data as VisaRow);
}

export async function updateVisaPage(id: number, input: Partial<CmsVisaPage>): Promise<CmsVisaPage> {
  const existing = await getVisaPage(id);
  if (!existing) throw new Error('Visa page not found.');
  const patch = visaInputToDb(input, existing);
  if (input.title !== undefined && !String(input.title).trim()) {
    throw new Error('Visa page title is required.');
  }
  if (input.country_name !== undefined && !String(input.country_name).trim()) {
    throw new Error('Country name is required.');
  }
  if (input.slug !== undefined) {
    patch.slug = await ensureUniqueSlug(String(input.slug || existing.title), id);
  }
  const { data, error } = await supabase
    .from('cms_visa_pages')
    .update(patch)
    .eq('id', id)
    .select(SELECT_COLS)
    .single();
  if (error) throw new Error(error.message);
  return mapVisaRow(data as VisaRow);
}

export async function deleteVisaPage(id: number): Promise<void> {
  const { error } = await supabase.from('cms_visa_pages').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function duplicateVisaPage(id: number): Promise<CmsVisaPage> {
  const src = await getVisaPage(id);
  if (!src) throw new Error('Visa page not found.');
  const stamp = Date.now().toString(36);
  return createVisaPage({
    ...src,
    title: `${src.title} (Copy)`,
    slug: `${src.slug}-copy-${stamp}`,
    is_published: false,
  });
}
