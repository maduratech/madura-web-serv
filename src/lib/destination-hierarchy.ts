export type DestinationKind = 'city' | 'state' | 'country' | 'continent' | 'other';

export type DestinationHierarchyRow = {
  id: number;
  name?: string | null;
  slug?: string | null;
  destination_type?: string | null;
  parent_id?: number | null;
};

export function destinationKind(row: DestinationHierarchyRow): DestinationKind {
  const raw = row.destination_type;
  if (raw == null || String(raw).trim() === '') {
    return 'other';
  }
  const t = String(raw).toLowerCase().trim();
  if (t === 'city') return 'city';
  if (t === 'state') return 'state';
  if (t === 'country') return 'country';
  if (t === 'continent') return 'continent';
  return 'other';
}

/** Seeded header region parents — must not be filtered as generic macro regions. */
export const HEADER_REGION_PARENT_SLUGS = new Set([
  'india',
  'mainland-europe',
  'australasia',
  'east-asia',
  'eastern-europe',
  'middle-east',
  'south-east-asia',
  'africa',
  'north-america',
  'central-asia',
]);

export function isExcludedMacroRegion(name: string, slug?: string | null): boolean {
  const slugKey = String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\s+/g, '-');
  if (slugKey && HEADER_REGION_PARENT_SLUGS.has(slugKey)) return false;

  const key = String(name || '').trim().toLowerCase();
  if (!key) return false;
  const exclusions = new Set([
    'africa',
    'asia',
    'europe',
    'antarctica',
    'oceania',
    'north america',
    'south america',
    'latin america',
    'middle east',
    'arab world',
    'caribbean',
    'central america',
    'scandinavia',
    'balkans',
    'south east asia',
    'southeast asia',
  ]);
  return exclusions.has(key);
}

export function isHeaderRegionParentRow(row: DestinationHierarchyRow): boolean {
  const slugKey = normalizeHeaderRegionSlug(row.slug);
  if (slugKey && HEADER_REGION_PARENT_SLUGS.has(slugKey)) return true;
  const nameKey = String(row.name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
  return HEADER_REGION_PARENT_SLUGS.has(nameKey);
}

function normalizeHeaderRegionSlug(slug?: string | null): string {
  return String(slug || '')
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\s+/g, '-');
}

function rowById(rows: DestinationHierarchyRow[]): Map<number, DestinationHierarchyRow> {
  const byId = new Map<number, DestinationHierarchyRow>();
  for (const row of rows) {
    byId.set(Number(row.id), row);
  }
  return byId;
}

export function resolveParentCountryRow(
  row: DestinationHierarchyRow,
  byId: Map<number, DestinationHierarchyRow>,
): DestinationHierarchyRow | null {
  let current: DestinationHierarchyRow | undefined = row;
  const seen = new Set<number>();
  while (current?.parent_id != null && !seen.has(Number(current.id))) {
    seen.add(Number(current.id));
    const parent = byId.get(Number(current.parent_id));
    if (!parent) return null;
    if (destinationKind(parent) === 'country' && !isHeaderRegionParentRow(parent)) return parent;
    current = parent;
  }
  return null;
}

export function resolveParentStateRow(
  row: DestinationHierarchyRow,
  byId: Map<number, DestinationHierarchyRow>,
): DestinationHierarchyRow | null {
  const parentId = row.parent_id;
  if (parentId == null) return null;
  const parent = byId.get(Number(parentId));
  if (!parent) return null;
  return destinationKind(parent) === 'state' ? parent : null;
}

/** Public label: Country | State, Country | City, State, Country | City, Country */
export function buildDestinationDisplayLabel(
  row: DestinationHierarchyRow,
  byId: Map<number, DestinationHierarchyRow>,
): string {
  const name = String(row.name || '').trim();
  if (!name) return '';

  const kind = destinationKind(row);
  if (kind === 'country' || kind === 'continent') return name;

  if (kind === 'state') {
    const country = resolveParentCountryRow(row, byId);
    const countryName = country?.name?.trim() || '';
    if (countryName && countryName.toLowerCase() !== name.toLowerCase()) {
      return `${name}, ${countryName}`;
    }
    return name;
  }

  if (kind === 'city') {
    const parts = [name];
    const state = resolveParentStateRow(row, byId);
    if (state?.name?.trim()) {
      parts.push(state.name.trim());
    }
    const country = resolveParentCountryRow(row, byId);
    const countryName = country?.name?.trim() || '';
    if (countryName && !parts.some((p) => p.toLowerCase() === countryName.toLowerCase())) {
      parts.push(countryName);
    }
    return parts.join(', ');
  }

  // Legacy / untyped rows
  const country = resolveParentCountryRow(row, byId);
  const countryName = country?.name?.trim() || '';
  if (countryName && countryName.toLowerCase() !== name.toLowerCase()) {
    return `${name}, ${countryName}`;
  }
  return name;
}

export function buildDestinationLabelIndex(rows: DestinationHierarchyRow[]): Map<number, string> {
  const byId = rowById(rows);
  const labels = new Map<number, string>();
  for (const row of rows) {
    labels.set(Number(row.id), buildDestinationDisplayLabel(row, byId));
  }
  return labels;
}

export type DestinationParentSelection = {
  country_id: number | null;
  state_id: number | null;
};

export function resolveDestinationParentSelection(
  row: DestinationHierarchyRow,
  byId: Map<number, DestinationHierarchyRow>,
): DestinationParentSelection {
  const kind = destinationKind(row);
  if (kind === 'country' || kind === 'continent') {
    return { country_id: null, state_id: null };
  }

  const country = resolveParentCountryRow(row, byId);
  if (kind === 'state') {
    return { country_id: country ? Number(country.id) : null, state_id: null };
  }

  const state = resolveParentStateRow(row, byId);
  return {
    country_id: country ? Number(country.id) : null,
    state_id: state ? Number(state.id) : null,
  };
}
