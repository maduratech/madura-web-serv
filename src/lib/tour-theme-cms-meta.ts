export type TourThemeCmsMeta = {
  description_in?: string;
  description_au?: string;
  banner_image_url?: string;
};

export function parseTourThemeMetaJson(raw: unknown): TourThemeCmsMeta {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      return serializeTourThemeMeta(parsed);
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object') {
    return serializeTourThemeMeta(raw as Record<string, unknown>);
  }
  return {};
}

export function serializeTourThemeMeta(raw: Record<string, unknown>): TourThemeCmsMeta {
  const description_in = String(raw.description_in || '').trim();
  const description_au = String(raw.description_au || '').trim();
  const banner_image_url = String(raw.banner_image_url || '').trim();
  return {
    description_in: description_in || undefined,
    description_au: description_au || undefined,
    banner_image_url: banner_image_url || undefined,
  };
}

export function resolveTourThemeDescriptionForMarket(
  meta: TourThemeCmsMeta,
  marketCountry: 'in' | 'au'
): string {
  const description_in = String(meta.description_in || '').trim();
  const description_au = String(meta.description_au || '').trim();
  if (marketCountry === 'au') {
    return description_au || description_in;
  }
  return description_in || description_au;
}
