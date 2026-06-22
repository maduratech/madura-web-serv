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

export type VisaTypeListingInput = {
  name: string;
  processing_time: string;
  validity: string;
  fees_inr: number;
  is_popular?: boolean;
  documents_required: { sections: { items: string[] }[] };
};

export type VisaListingMeta = {
  starting_price_inr: number | null;
  validity_label: string | null;
  processing_days: number | null;
  filter_visa_type: VisaFilterVisaType;
  filter_document_level: VisaFilterDocumentLevel;
  filter_delivery_bucket: VisaFilterDeliveryBucket;
  visa_type_label: string | null;
};

function primaryVisaType(types: VisaTypeListingInput[]): VisaTypeListingInput | null {
  if (!types.length) return null;
  return types.find((t) => t.is_popular) ?? types[0];
}

/** Parse processing time text like "Upto 5 days" or "Within 48 hours" into working days. */
export function parseProcessingDaysFromText(text: string): number | null {
  const t = text.toLowerCase().trim();
  if (!t) return null;
  if (/instant|same\s*day|immediately|on\s*the\s*spot/.test(t)) return 0;

  const hours = t.match(/(\d+)\s*(?:hours?|hrs?)/);
  if (hours) return Math.max(1, Math.ceil(Number(hours[1]) / 24));

  const days =
    t.match(/(\d+)\s*(?:working\s*)?days?/) ||
    t.match(/upto\s*(\d+)/) ||
    t.match(/within\s*(\d+)/);
  if (days) return Number(days[1]);

  return null;
}

function inferFilterVisaType(name: string): VisaFilterVisaType {
  const n = name.toLowerCase();
  if (/visa\s*free|no\s*visa\s*required/.test(n)) return 'visa_free';
  if (/on\s*arrival|\bvoa\b/.test(n)) return 'visa_on_arrival';
  if (/sticker|embassy|consulate|physical\s*visa/.test(n)) return 'sticker';
  if (/e[\s-]?visa|electronic\s*visa|online\s*visa/.test(n)) return 'e_visa';
  if (/transit|tourist|business|multiple\s*entry|single\s*entry/.test(n)) return 'e_visa';
  return 'e_visa';
}

function collectDocumentText(types: VisaTypeListingInput[]): string {
  return types
    .flatMap((type) => (type.documents_required?.sections || []).flatMap((section) => section.items || []))
    .join(' ')
    .toLowerCase();
}

function inferDocumentLevel(types: VisaTypeListingInput[]): VisaFilterDocumentLevel {
  const text = collectDocumentText(types);
  if (!text.trim()) return 'any';

  if (/schengen|us visa|uk visa|united states|united kingdom|valid\s+(us|uk)/.test(text)) {
    return 'with_us_uk_schengen';
  }
  if (/\bitr\b|income\s*tax|tax\s*return/.test(text)) return 'passport_bank_itr';
  if (/bank\s*statement|financial\s*statement|bank\s*account/.test(text)) return 'passport_bank';
  if (/passport/.test(text)) return 'passport_only';
  return 'any';
}

function inferDeliveryBucket(days: number | null): VisaFilterDeliveryBucket {
  if (days == null) return 'any';
  if (days <= 0) return 'instant';
  if (days <= 1) return 'within_24h';
  if (days <= 5) return '3_5_days';
  if (days <= 7) return '6_7_days';
  if (days <= 30) return '8_30_days';
  return 'any';
}

function formatValidityLabel(validity: string): string | null {
  const trimmed = validity.trim();
  if (!trimmed) return null;
  return trimmed;
}

function inferVisaTypeLabel(type: VisaTypeListingInput | null): string | null {
  if (!type?.name.trim()) return null;
  const name = type.name.trim();
  if (name.length <= 24) return name;
  return `${name.slice(0, 21)}…`;
}

export function computeVisaListingMetaFromVisaTypes(types: VisaTypeListingInput[]): VisaListingMeta {
  const primary = primaryVisaType(types);

  const starting_price_inr = types
    .map((t) => t.fees_inr)
    .filter((fee) => Number.isFinite(fee) && fee > 0)
    .reduce<number | null>((min, fee) => (min == null || fee < min ? fee : min), null);

  const validity_label =
    formatValidityLabel(primary?.validity || '') ||
    formatValidityLabel(types.find((t) => t.validity.trim())?.validity || '');

  const processingDaysList = types
    .map((t) => parseProcessingDaysFromText(t.processing_time))
    .filter((d): d is number => d != null);
  const processing_days = processingDaysList.length > 0 ? Math.min(...processingDaysList) : null;

  const filter_visa_type = primary ? inferFilterVisaType(primary.name) : 'e_visa';
  const filter_document_level = inferDocumentLevel(types);
  const filter_delivery_bucket = inferDeliveryBucket(processing_days);
  const visa_type_label = inferVisaTypeLabel(primary);

  return {
    starting_price_inr,
    validity_label,
    processing_days,
    filter_visa_type,
    filter_document_level,
    filter_delivery_bucket,
    visa_type_label,
  };
}
