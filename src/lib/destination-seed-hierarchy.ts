import { normalizeDestinationSlug } from './destination-slug';

/**
 * Canonical slug → type/country map for CMS listing.
 * Mirrors madura-web `header-destinations-nav-static.ts` (same nav seed).
 * Used at read time by cms.service when DB parent links are missing or wrong.
 */
export const HEADER_DESTINATIONS_NAV_REGION_ORDER = [
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
] as const;

export const STATIC_HEADER_REGION_TITLES: Record<string, string> = {
  india: 'India',
  'mainland-europe': 'Mainland Europe',
  australasia: 'Australasia',
  'east-asia': 'East Asia',
  'eastern-europe': 'Eastern Europe',
  'middle-east': 'Middle East',
  'south-east-asia': 'South East Asia',
  africa: 'Africa',
  'north-america': 'North America',
  'central-asia': 'Central Asia',
};

export const STATIC_HEADER_DESTINATION_ITEMS: Record<string, readonly string[]> = {
  india: [
    'Andaman',
    'Assam',
    'Arunachal Pradesh',
    'Golden Triangle',
    'Gujarat',
    'Himachal Pradesh',
    'Karnataka',
    'Kashmir',
    'Kerala',
    'Maharashtra',
    'Madhya Pradesh',
    'North East India',
    'Orissa',
    'Rajasthan',
    'Tamil Nadu',
    'Telangana',
    'Goa',
    'Sikkim',
    'Delhi',
    'Uttar Pradesh',
    'Uttarakhand',
    'West Bengal',
    'Chennai',
  ],
  'mainland-europe': [
    'Austria',
    'Belgium',
    'Finland',
    'France',
    'Germany',
    'Iceland',
    'Ireland',
    'Italy',
    'Luxembourg',
    'Netherlands',
    'Norway',
    'Poland',
    'Portugal',
    'Denmark',
    'Spain',
    'Sweden',
    'Switzerland',
    'United Kingdom',
    'Vatican City',
  ],
  australasia: ['Australia', 'New Zealand', 'Fiji', 'Queensland'],
  'east-asia': ['China', 'Japan', 'South Korea', 'Taiwan', 'Hong Kong'],
  'eastern-europe': ['Greece', 'Bulgaria', 'Czech Republic', 'Hungary', 'Russia', 'Croatia'],
  'middle-east': ['Jordan', 'Kuwait', 'Oman', 'Qatar', 'Saudi Arabia', 'Turkey', 'Dubai'],
  'south-east-asia': [
    'Bhutan',
    'Maldives',
    'Nepal',
    'Sri Lanka',
    'Cambodia',
    'Indonesia',
    'Malaysia',
    'Philippines',
    'Singapore',
    'Thailand',
    'Vietnam',
  ],
  africa: [
    'Egypt',
    'Kenya',
    'Madagascar',
    'Mauritius',
    'Morocco',
    'Mozambique',
    'Namibia',
    'Seychelles',
    'South Africa',
  ],
  'north-america': ['Canada', 'United States of America', 'Mexico'],
  'central-asia': ['Kazakhstan', 'Uzbekistan', 'Azerbaijan'],
};

const INDIAN_CITY_SLUGS = new Set(['chennai', 'delhi', 'goa']);

/** State/province rows that belong under a country (slug → country name). */
const STATE_UNDER_COUNTRY: Record<string, string> = {
  queensland: 'Australia',
};

/** City rows and their country (slug → country name). */
const CITY_COUNTRY: Record<string, string> = {
  chennai: 'India',
  delhi: 'India',
  goa: 'India',
  dubai: 'United Arab Emirates',
};

const indiaChildSlugs = new Set(
  (STATIC_HEADER_DESTINATION_ITEMS.india || []).map((name) => normalizeDestinationSlug(name)),
);

const standaloneCountrySlugs = new Set<string>();
for (const [regionSlug, names] of Object.entries(STATIC_HEADER_DESTINATION_ITEMS)) {
  if (regionSlug === 'india') continue;
  for (const name of names) {
    const slug = normalizeDestinationSlug(name);
    if (slug === 'queensland') continue;
    standaloneCountrySlugs.add(slug);
  }
}

export type SeedHierarchyHint = {
  destination_type: 'country' | 'city' | 'state';
  country_name: string | null;
  parent_country_slug: string | null;
};

export function resolveSeedHierarchyHint(
  slugInput: string | null | undefined,
  nameInput?: string | null,
): SeedHierarchyHint | null {
  const slug = normalizeDestinationSlug(String(slugInput || nameInput || ''));
  if (!slug) return null;

  if (CITY_COUNTRY[slug]) {
    const country = CITY_COUNTRY[slug];
    return {
      destination_type: 'city',
      country_name: country,
      parent_country_slug: normalizeDestinationSlug(country),
    };
  }

  if (STATE_UNDER_COUNTRY[slug]) {
    const country = STATE_UNDER_COUNTRY[slug];
    return {
      destination_type: 'state',
      country_name: country,
      parent_country_slug: normalizeDestinationSlug(country),
    };
  }

  if (standaloneCountrySlugs.has(slug)) {
    return { destination_type: 'country', country_name: null, parent_country_slug: null };
  }

  if (indiaChildSlugs.has(slug)) {
    const type = INDIAN_CITY_SLUGS.has(slug) ? 'city' : 'state';
    return {
      destination_type: type,
      country_name: 'India',
      parent_country_slug: 'india',
    };
  }

  return null;
}

/** Country label for CMS display when DB hierarchy is missing. */
export function resolveSeedCountryName(
  slugInput: string | null | undefined,
  nameInput?: string | null,
): string | null {
  const hint = resolveSeedHierarchyHint(slugInput, nameInput);
  if (!hint?.country_name) return null;
  return hint.country_name;
}

