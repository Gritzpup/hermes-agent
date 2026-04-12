/**
 * Derivatives Intelligence — Fix #11
 *
 * Polls free Binance futures endpoints for funding rate and open interest.
 * When funding is extreme + flow already aligned, blocks trend-chasing entries
 * (the move is already crowded/exhausted).
 */

const BINANCE_FUNDING_URL = 'https://fapi.binance.com/fapi/v1/premiumIndex';
const BINANCE_OI_URL = 'https://fapi.binance.com/fapi/v1/openInterest';
const POLL_MS = 60_000; // 1 minute

// Map Hermes symbols to Binance futures symbols
const SYMBOL_MAP: Record<string, string> = {
  'BTC-USD': 'BTCUSDT',
  'ETH-USD': 'ETHUSDT',
  'SOL-USD': 'SOLUSDT',
  'XRP-USD': 'XRPUSDT'
};

export interface FundingSnapshot {
  symbol: string;
  fundingRate: number; // current funding rate (-0.01 to 0.01 typically)
  openInterest: number; // total open interest in contracts
  crowded: boolean; // true when funding extreme + same direction as flow
  direction: 'long-crowded' | 'short-crowded' | 'neutral';
  updatedAt: string;
}

export class DerivativesIntel {
  private snapshots = new Map<string, FundingSnapshot>();
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    if (this.timer) return;
    console.log('[derivatives-intel] Starting Binance funding rate + OI polling');
    void this.poll();
    this.timer = setInterval(() => { void this.poll(); }, POLL_MS);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Check if a symbol's trade direction is crowded (everyone already positioned) */
  isCrowded(hermesSymbol: string): FundingSnapshot | null {
    return this.snapshots.get(hermesSymbol) ?? null;
  }

  /** Block entry if the market is crowded in the same direction */
  shouldBlockEntry(hermesSymbol: string, entryDirection: 'long' | 'short'): boolean {
    const snap = this.snapshots.get(hermesSymbol);
    if (!snap || !snap.crowded) return false;
    // Block if trying to go long when longs are crowded, or short when shorts are crowded
    if (entryDirection === 'long' && snap.direction === 'long-crowded') return true;
    if (entryDirection === 'short' && snap.direction === 'short-crowded') return true;
    return false;
  }

  getSnapshot(): FundingSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  private async poll(): Promise<void> {
    for (const [hermesSymbol, binanceSymbol] of Object.entries(SYMBOL_MAP)) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);

        // Funding rate
        const fundingResp = await fetch(`${BINANCE_FUNDING_URL}?symbol=${binanceSymbol}`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!fundingResp.ok) continue;
        const fundingData = await fundingResp.json() as { lastFundingRate: string; markPrice: string };
        const fundingRate = parseFloat(fundingData.lastFundingRate ?? '0');

        // Open interest
        const controller2 = new AbortController();
        const timeout2 = setTimeout(() => controller2.abort(), 5_000);
        const oiResp = await fetch(`${BINANCE_OI_URL}?symbol=${binanceSymbol}`, { signal: controller2.signal });
        clearTimeout(timeout2);
        const oiData = oiResp.ok ? await oiResp.json() as { openInterest: string } : { openInterest: '0' };
        const openInterest = parseFloat(oiData.openInterest ?? '0');

        // Determine if crowded: extreme funding = everyone positioned one way
        // Positive funding > 0.01% = longs paying shorts (longs crowded)
        // Negative funding < -0.01% = shorts paying longs (shorts crowded)
        const extremeThreshold = 0.0005; // 0.05% per 8h = very high
        const crowded = Math.abs(fundingRate) > extremeThreshold;
        const direction: FundingSnapshot['direction'] = !crowded ? 'neutral'
          : fundingRate > 0 ? 'long-crowded' : 'short-crowded';

        this.snapshots.set(hermesSymbol, {
          symbol: hermesSymbol,
          fundingRate,
          openInterest,
          crowded,
          direction,
          updatedAt: new Date().toISOString()
        });
      } catch {
        // Non-critical — Binance may block some regions
      }
    }
  }
}

let instance: DerivativesIntel | undefined;

export function getDerivativesIntel(): DerivativesIntel {
  if (!instance) {
    instance = new DerivativesIntel();
    instance.start();
  }
  return instance;
}
