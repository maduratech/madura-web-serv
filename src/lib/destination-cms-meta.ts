export type DestinationHierarchyMeta = {
  destination_type?: 'country' | 'city' | 'state';
  country_id?: number | null;
  state_id?: number | null;
  parent_id?: number | null;
};

function normalizeHierarchyType(value: unknown): DestinationHierarchyMeta['destination_type'] | undefined {
  const t = String(value || '').trim().toLowerCase();
  if (t === 'country' || t === 'city' || t === 'state') return t;
  return undefined;
}

function toPositiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

export function parseDestinationMetaJson(raw: string | null | undefined): Record<string, unknown> | null {
  const text = String(raw || '').trim();
  const match = text.match(/^<!--dest-meta:([\s\S]*?)-->/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseHierarchyFromDescription(raw: string | null | undefined): DestinationHierarchyMeta {
  const meta = parseDestinationMetaJson(raw);
  if (!meta) return {};
  return {
    destination_type: normalizeHierarchyType(meta.destination_type),
    country_id: toPositiveInt(meta.country_id),
    state_id: toPositiveInt(meta.state_id),
    parent_id: toPositiveInt(meta.parent_id),
  };
}

export function mergeHierarchyIntoDescription(
  raw: string | null | undefined,
  hierarchy: DestinationHierarchyMeta,
): string | null {
  const text = String(raw || '').trim();
  const meta = parseDestinationMetaJson(text) || {};
  const next = { ...meta } as Record<string, unknown>;

  if (hierarchy.destination_type) next.destination_type = hierarchy.destination_type;
  if (hierarchy.country_id != null) next.country_id = hierarchy.country_id;
  if (hierarchy.state_id != null) next.state_id = hierarchy.state_id;
  if (hierarchy.parent_id != null) next.parent_id = hierarchy.parent_id;

  const body = text.replace(/^<!--dest-meta:[\s\S]*?-->\s*/, '').trim();
  const serialized = JSON.stringify(next);
  return body ? `<!--dest-meta:${serialized}-->${body}` : `<!--dest-meta:${serialized}-->`;
}
