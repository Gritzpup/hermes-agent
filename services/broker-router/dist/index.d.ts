// Type declarations for @hermes/broker-router
// Manually maintained — broker-router uses tsx which doesn't emit .d.ts

export interface CoinbaseFeeTier {
  makerBps: number;
  takerBps: number;
  tierName: string;
  fetchedAt: string;
}

export function startFeeTierMonitor(): void;
export function stopFeeTierMonitor(): void;
export function getCurrentCoinbaseFeeTier(): CoinbaseFeeTier;
export function isMakerStrategiesBlocked(): boolean;
export function getTimeSinceLastFetch(): number;
export function getCoinbaseRateUtilization(): { public: number; private: number };

export function generateClientOrderId(
  agentId: string,
  symbol: string,
  side: string,
  notional: number,
  quantity: number
): string;
