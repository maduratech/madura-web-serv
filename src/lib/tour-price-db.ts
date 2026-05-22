/**
 * Child-band price fields — match Supabase column names on tours & departures.
 */

export type ChildBandPrices = {
  infant_price?: number | null;
  child_price?: number | null;
  youth_price?: number | null;
};

export function childPricesFromDb(row: ChildBandPrices | null | undefined): ChildBandPrices {
  if (!row) return {};
  return {
    infant_price: row.infant_price ?? null,
    child_price: row.child_price ?? null,
    youth_price: row.youth_price ?? null,
  };
}

export function childPricesToDb(prices: ChildBandPrices): Record<string, number | null | undefined> {
  const out: Record<string, number | null | undefined> = {};
  if (prices.infant_price !== undefined) out.infant_price = prices.infant_price;
  if (prices.child_price !== undefined) out.child_price = prices.child_price;
  if (prices.youth_price !== undefined) out.youth_price = prices.youth_price;
  return out;
}
