export interface SidecarLaneControlState {
  strategyId: string;
  strategy: string;
  lane: 'pairs' | 'grid' | 'maker';
  symbols: string[];
  enabled: boolean;
  blockedReason: string;
  allocationMultiplier: number;
  recentTrades: number;
  recentWinRate: number;
  recentProfitFactor: number;
  lastReviewAt: string;
  lastAdjustment: string;
}

export interface MarketMicrostructureFeed {
  connected?: boolean;
  lastMessageAt?: string | null;
  snapshots?: MarketMicrostructureSnapshot[];
}

export interface MarketMicrostructureSnapshot {
  symbol: string;
  bidDepth: number;
  askDepth: number;
  imbalancePct: number;
  queueImbalancePct?: number;
  tradeImbalancePct?: number;
  pressureImbalancePct?: number;
  spreadStableMs?: number;
  microPrice: number;
  bestBid: number;
  bestAsk: number;
  spread: number;
  spreadBps: number;
  updatedAt: string;
}
