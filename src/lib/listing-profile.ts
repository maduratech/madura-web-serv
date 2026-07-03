type ListingProfileExtra = {
  market: string;
  responseBytes: number;
  tourCount: number;
  cacheHit?: boolean;
};

export class ListingProfiler {
  private readonly market: string;
  private readonly t0 = performance.now();
  private last = this.t0;
  private readonly phases = new Map<string, number>();
  private readonly heapMb = new Map<string, number>();

  constructor(market: string) {
    this.market = market;
    this.mark('start');
  }

  mark(phase: string): void {
    const now = performance.now();
    this.phases.set(phase, Math.round((now - this.last) * 100) / 100);
    this.heapMb.set(phase, Math.round(process.memoryUsage().heapUsed / 1024 / 1024));
    this.last = now;
  }

  finish(extra: ListingProfileExtra): void {
    const totalMs = Math.round((performance.now() - this.t0) * 100) / 100;
    const phases = Object.fromEntries(this.phases);
    const heapMb = Object.fromEntries(this.heapMb);
  // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        tag: 'tours-listing-profile',
        market: extra.market || this.market,
        cacheHit: extra.cacheHit ?? false,
        totalMs,
        phases,
        heapMb,
        responseBytes: extra.responseBytes,
        responseKb: Math.round(extra.responseBytes / 1024),
        tourCount: extra.tourCount,
      })
    );
  }
}

export function isListingProfileEnabled(): boolean {
  return process.env.LISTING_PROFILE === '1';
}

export function createListingProfiler(market: string): ListingProfiler | null {
  return isListingProfileEnabled() ? new ListingProfiler(market) : null;
}
