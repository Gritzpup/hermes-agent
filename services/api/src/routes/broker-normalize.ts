/**
 * Broker Normalization & Overview Building
 *
 * Converts raw broker-router responses into standardized snapshots.
 * Extracted from index.ts to reduce file size.
 */

import type {
  BrokerAccountSnapshot,
  BrokerHeat,
  ExecutionReport,
  OverviewSnapshot,
  PositionSnapshot,
  ServiceHealth
} from '@hermes/contracts';
import {
  round,
  asRecord,
  textField,
  numberField,
  normalizeArray,
  sumCoinbaseCash,
  mapBrokerStatus,
  dedupePositions,
  peak
} from './helpers.js';

// The broker-router returns this shape
export interface BrokerRouterBrokerSnapshot {
  broker: string;
  status: string;
  asOf: string;
  account?: unknown;
  positions: Array<{ broker?: string; symbol?: string; quantity?: number; avgEntry?: number; markPrice?: number; unrealizedPnl?: number; unrealizedPnlPct?: number; [key: string]: unknown }>;
  fills?: unknown[];
  orders?: unknown[];
  reports?: unknown[];
}

export interface BrokerRouterAccountResponse {
  asOf: string;
  brokers: BrokerRouterBrokerSnapshot[];
}

export interface BrokerRouterReportRecord {
  id: string;
  broker: string;
  symbol: string;
  side: string;
  status: string;
  fillPrice: number;
  fillQty: number;
  latencyMs: number;
  timestamp: string;
  [key: string]: unknown;
}

export function normalizeBrokerAccounts(snapshots: BrokerRouterBrokerSnapshot[]): BrokerAccountSnapshot[] {
  return snapshots.map((snapshot) => {
    const brokerId = snapshot.broker as BrokerAccountSnapshot['broker'];
    const account = asRecord(snapshot.account);
    const positions = normalizeBrokerPositions([snapshot]);
    const cash = brokerId === 'coinbase-live'
      ? sumCoinbaseCash(account)
      : numberField(account, ['cash', 'buying_power', 'portfolio_cash', 'balance']) ?? 0;
    const equity = brokerId === 'coinbase-live'
      ? round(cash + positions.reduce((sum, position) => sum + position.markPrice * position.quantity, 0), 2)
      : numberField(account, ['equity', 'portfolio_value', 'NAV', 'last_equity', 'value', 'balance']) ?? cash;
    const buyingPower = brokerId === 'coinbase-live'
      ? cash
      : numberField(account, ['buying_power', 'buyingPower', 'cash']) ?? cash;

    const accountMode: BrokerAccountSnapshot['mode'] = brokerId === 'alpaca-paper'
      ? 'paper'
      : brokerId === 'oanda-rest'
        ? 'paper'
        : 'live';

    return {
      broker: brokerId,
      mode: accountMode,
      accountId: textField(account, ['id', 'account_number', 'uuid']) ?? brokerId,
      currency: brokerId === 'coinbase-live' ? 'USD' : textField(account, ['currency']) ?? 'USD',
      cash: round(cash, 2),
      buyingPower: round(buyingPower, 2),
      equity: round(equity, 2),
      status: mapBrokerStatus(snapshot.status),
      source: 'broker',
      updatedAt: snapshot.asOf,
      availableToTrade: round(buyingPower, 2)
    };
  });
}

export function normalizeBrokerPositions(snapshots: BrokerRouterBrokerSnapshot[]): PositionSnapshot[] {
  return snapshots.flatMap((snapshot) =>
    snapshot.positions
      .map((position) => normalizeBrokerPosition(snapshot, position))
      .filter((value): value is PositionSnapshot => value !== null)
  );
}

function normalizeBrokerPosition(snapshot: BrokerRouterBrokerSnapshot, position: unknown): PositionSnapshot | null {
  const record = asRecord(position);
  const existingBroker = textField(record, ['broker']);
  const broker = existingBroker ?? snapshot.broker;
  const rawSymbol = textField(record, ['symbol', 'instrument', 'asset_id']) ?? '';
  const symbol = rawSymbol.replace('/', '-');
  const quantity = Math.abs(numberField(record, ['qty', 'quantity', 'initialUnits', 'currentUnits', 'units']) ?? 0);
  if (!symbol || quantity <= 0.0001) return null;

  const avgEntry = numberField(record, ['avg_entry_price', 'avgEntry', 'price', 'averagePrice']) ?? 0;
  const markPrice = numberField(record, ['current_price', 'mark_price', 'markPrice']) ?? avgEntry;
  const unrealizedPnl = numberField(record, ['unrealized_pl', 'unrealizedPnl', 'unrealizedPL']) ?? 0;
  const rawPct = numberField(record, ['unrealized_plpc', 'unrealizedPnlPct']) ?? 0;
  const unrealizedPnlPct = Math.abs(rawPct) <= 1 ? rawPct * 100 : rawPct;
  const assetClassValue = (textField(record, ['asset_class', 'assetClass']) ?? 'equity').toLowerCase();

  return {
    id: textField(record, ['asset_id', 'id', 'trade_id']) ?? `${broker}-${symbol}`,
    broker: broker as PositionSnapshot['broker'],
    symbol,
    strategy: 'broker-position',
    assetClass: assetClassValue.includes('crypto') ? 'crypto' : assetClassValue.includes('forex') ? 'forex' : 'equity',
    quantity,
    avgEntry,
    markPrice,
    unrealizedPnl,
    unrealizedPnlPct,
    thesis: `Imported from ${broker} positions.`,
    openedAt: textField(record, ['opened_at', 'openedAt', 'openTime']) ?? new Date().toISOString(),
    source: 'broker'
  };
}

export function normalizeBrokerReports(reports: BrokerRouterReportRecord[]): ExecutionReport[] {
  return reports.map((r) => ({
    id: r.id,
    orderId: r.id,
    broker: r.broker,
    symbol: r.symbol.replace('/', '-'),
    status: r.status,
    filledQty: r.fillQty,
    avgFillPrice: r.fillPrice,
    slippageBps: 0,
    latencyMs: r.latencyMs,
    message: '',
    timestamp: r.timestamp,
    source: 'broker'
  }) as unknown as ExecutionReport);
}

export function buildOverviewSnapshot(
  desk: { totalEquity: number; totalDayPnl: number; totalReturnPct: number; realizedPnl: number; winRate: number; totalTrades: number; agents: any[]; analytics: any },
  accounts: BrokerAccountSnapshot[],
  health: ServiceHealth[]
): OverviewSnapshot {
  const nav = accounts.reduce((sum, a) => sum + a.equity, 0) || desk.totalEquity;
  const dailyPnl = desk.totalDayPnl;
  const dailyPnlPct = desk.totalReturnPct;
  const realizedPnl30d = desk.realizedPnl;
  const winRate30d = desk.winRate;
  const drawdownPct = nav > 0 ? Math.max(0, (peak(desk.agents.map((a: any) => a.startingEquity ?? 0).concat(nav)) - nav) / nav * 100) : 0;

  return {
    asOf: new Date().toISOString(),
    nav: round(nav, 2),
    dailyPnl: round(dailyPnl, 2),
    dailyPnlPct: round(dailyPnlPct, 2),
    drawdownPct: round(drawdownPct, 2),
    activeRiskBudgetPct: 0,
    realizedPnl30d: round(realizedPnl30d, 2),
    winRate30d: round(winRate30d, 1),
    expectancyR: 0,
    brokerAccounts: accounts,
    serviceHealth: health,
  } as unknown as OverviewSnapshot;
}

export function buildHeat(
  accounts: BrokerAccountSnapshot[],
  paperEquity: number,
  paperRealizedPnl: number
): BrokerHeat[] {
  return accounts.map((account) => {
    const baseline = account.broker === 'coinbase-live' ? 0 : 100_000;
    const pnl = account.equity - baseline;
    return {
      broker: account.broker,
      label: account.broker === 'alpaca-paper' ? 'Alpaca' : account.broker === 'oanda-rest' ? 'OANDA' : 'Coinbase',
      equity: account.equity,
      pnl: round(pnl, 2),
      pnlPct: baseline > 0 ? round((pnl / baseline) * 100, 2) : 0,
      status: account.status,
      mode: account.mode
    } as unknown as BrokerHeat;
  });
}
