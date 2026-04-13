import type {
  BrokerAccountSnapshot,
  PositionSnapshot,
  ExecutionReport,
  TradeJournalEntry,
  MarketSnapshot
} from '@hermes/contracts';
import type { BrokerRouterBrokerSnapshot, BrokerRouterReportRecord } from './types-broker.js';
import {
  asRecord,
  normalizeArray,
  textField,
  numberField,
  round
} from './utils-generic.js';

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
      currency: brokerId === 'coinbase-live'
        ? 'USD'
        : textField(account, ['currency']) ?? 'USD',
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

export function normalizeBrokerPosition(snapshot: BrokerRouterBrokerSnapshot, position: unknown): PositionSnapshot | null {
  const record = asRecord(position);
  const existingBroker = textField(record, ['broker']);
  const existingSymbol = textField(record, ['symbol']);
  const existingAssetClass = textField(record, ['assetClass']);
  const existingQty = numberField(record, ['quantity']);
  const existingAvgEntry = numberField(record, ['avgEntry']);
  const existingMark = numberField(record, ['markPrice']);

  if (existingBroker && existingSymbol && existingAssetClass && existingQty !== null && existingAvgEntry !== null && existingMark !== null) {
    return {
      id: textField(record, ['id']) ?? `${existingBroker}:${existingSymbol}`,
      broker: existingBroker as PositionSnapshot['broker'],
      symbol: existingSymbol,
      strategy: textField(record, ['strategy']) ?? 'broker-position',
      assetClass: existingAssetClass as PositionSnapshot['assetClass'],
      quantity: existingQty,
      avgEntry: existingAvgEntry,
      markPrice: existingMark,
      unrealizedPnl: numberField(record, ['unrealizedPnl']) ?? 0,
      unrealizedPnlPct: numberField(record, ['unrealizedPnlPct']) ?? 0,
      thesis: textField(record, ['thesis']) ?? 'Imported from broker snapshot.',
      openedAt: textField(record, ['openedAt']) ?? snapshot.asOf,
      source: 'broker'
    };
  }

  const symbol = textField(record, ['symbol']);
  const quantity = Math.abs(numberField(record, ['qty', 'quantity']) ?? 0);
  if (!symbol || quantity <= 0) {
    return null;
  }

  const avgEntry = numberField(record, ['avg_entry_price', 'avgEntry']) ?? 0;
  const markPrice = numberField(record, ['current_price', 'mark_price', 'markPrice']) ?? avgEntry;
  const unrealizedPnl = numberField(record, ['unrealized_pl', 'unrealizedPnl']) ?? 0;
  const rawPct = numberField(record, ['unrealized_plpc', 'unrealizedPnlPct']) ?? 0;
  const unrealizedPnlPct = Math.abs(rawPct) <= 1 ? rawPct * 100 : rawPct;
  const assetClassValue = (textField(record, ['asset_class', 'assetClass']) ?? 'equity').toLowerCase();

  return {
    id: textField(record, ['asset_id', 'id']) ?? `${snapshot.broker}:${symbol}`,
    broker: snapshot.broker,
    symbol,
    strategy: 'broker-position',
    assetClass: assetClassValue.includes('crypto') ? 'crypto' : 'equity',
    quantity,
    avgEntry,
    markPrice,
    unrealizedPnl,
    unrealizedPnlPct,
    thesis: 'Imported from broker snapshot.',
    openedAt: textField(record, ['opened_at', 'openedAt']) ?? snapshot.asOf,
    source: 'broker'
  };
}

export function normalizeBrokerReports(reports: BrokerRouterReportRecord[]): ExecutionReport[] {
  return reports.map((report) => ({
    id: report.id,
    orderId: report.orderId,
    broker: report.broker,
    symbol: report.symbol,
    status: report.status,
    filledQty: report.filledQty,
    avgFillPrice: report.avgFillPrice,
    slippageBps: report.slippageBps,
    latencyMs: report.latencyMs,
    message: report.message,
    timestamp: report.timestamp,
    ...(report.mode ? { mode: report.mode } : {}),
    ...(report.source ? { source: report.source } : {})
  }));
}

export function normalizeBrokerConnectionStatus(status: string | null | undefined): BrokerAccountSnapshot['status'] {
  const s = status?.toLowerCase();
  switch (s) {
    case 'healthy':
    case 'connected':
    case 'ready':
    case 'active':
    case 'ok':
    case 'live':
      return 'connected';
    case 'degraded':
    case 'warning':
    case 'partial':
    case 'stale':
    case 'delayed':
    case 'error':
      return 'degraded';
    default:
      return 'disconnected';
  }
}

export function mapBrokerStatus(status: string): BrokerAccountSnapshot['status'] {
  return normalizeBrokerConnectionStatus(status);
}

export function sumCoinbaseCash(account: Record<string, unknown>): number {
  const entries = normalizeArray(account.accounts ?? account);
  return entries.reduce<number>((sum, entry) => {
    const record = asRecord(entry);
    const currency = textField(record, ['currency']);
    if (currency !== 'USD' && currency !== 'USDC') {
      return sum;
    }
    return sum + (numberField(record, ['available_balance.value', 'balance.value', 'available_balance', 'balance', 'value']) ?? 0);
  }, 0);
}

export function dedupePositions(positions: PositionSnapshot[]): PositionSnapshot[] {
  const seen = new Set<string>();
  return positions.filter((position) => {
    const key = `${position.broker}:${position.id}:${position.symbol}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function dedupeReports(reports: ExecutionReport[]): ExecutionReport[] {
  const byId = new Map<string, ExecutionReport>();
  for (const report of reports) {
    byId.set(`${report.broker}:${report.id}`, report);
  }
  return Array.from(byId.values()).sort((left, right) => right.timestamp.localeCompare(left.timestamp));
}

export function dedupeJournal(entries: TradeJournalEntry[]): TradeJournalEntry[] {
  const byId = new Map<string, TradeJournalEntry>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
  }
  return Array.from(byId.values()).sort((left, right) => right.exitAt.localeCompare(left.exitAt));
}

export function dedupeMarketSnapshots(snapshots: MarketSnapshot[]): MarketSnapshot[] {
  const bySymbol = new Map<string, MarketSnapshot>();
  for (const snapshot of snapshots) {
    const existing = bySymbol.get(snapshot.symbol);
    if (!existing || existing.source === 'simulated' || existing.source === 'mock') {
      bySymbol.set(snapshot.symbol, snapshot);
    }
  }
  return Array.from(bySymbol.values()).sort((left, right) => left.symbol.localeCompare(right.symbol));
}
