export interface BrokerRouterBrokerSnapshot {
  broker: 'alpaca-paper' | 'coinbase-live' | 'oanda-rest';
  venue: 'alpaca' | 'coinbase' | 'oanda';
  status: string;
  asOf: string;
  account: unknown;
  positions: unknown[];
  fills: unknown[];
  orders: unknown[];
  errors: string[];
}

export interface BrokerRouterAccountResponse {
  asOf: string;
  brokers: BrokerRouterBrokerSnapshot[];
  lastSyncAt: string | null;
}

export interface BrokerRouterReportRecord {
  id: string;
  orderId: string;
  broker: 'alpaca-paper' | 'coinbase-live' | 'oanda-rest';
  symbol: string;
  status: 'accepted' | 'filled' | 'rejected' | 'canceled';
  filledQty: number;
  avgFillPrice: number;
  slippageBps: number;
  latencyMs: number;
  message: string;
  timestamp: string;
  mode?: 'paper' | 'live';
  source?: 'broker' | 'simulated' | 'mock';
}

export interface BrokerRouterReportsResponse {
  asOf: string;
  lastSyncAt: string | null;
  reports: BrokerRouterReportRecord[];
  brokers: BrokerRouterBrokerSnapshot[];
}
