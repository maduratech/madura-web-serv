export type TourFlightLeg = { cost_inr?: number | null };

export function tourFlightCostPerPerson(
  legs: TourFlightLeg[] | undefined,
  packageCostInr?: number | null
): number {
  const pkg = Number(packageCostInr);
  if (Number.isFinite(pkg) && pkg > 0) return Math.round(pkg);
  const sum = (legs || []).reduce((acc, leg) => {
    const n = Number(leg.cost_inr);
    return acc + (Number.isFinite(n) && n > 0 ? n : 0);
  }, 0);
  return sum > 0 ? Math.round(sum) : 0;
}

export function countPayingTravellers(
  rooms: Array<{ adults: number; children: number }>
): number {
  return rooms.reduce((acc, r) => acc + Math.max(0, r.adults) + Math.max(0, r.children), 0);
}

export function bookingTotalWithFlightOption(
  totalInr: number,
  flightCostPerPerson: number,
  includeFlight: boolean,
  payingTravellers: number
): number {
  if (includeFlight || flightCostPerPerson <= 0 || payingTravellers <= 0) return totalInr;
  return Math.max(0, Math.round(totalInr - flightCostPerPerson * payingTravellers));
}
