// @ts-nocheck
import { round, pickLast, clamp } from '../paper-engine-utils.js';
import { textField, numberField, asRecord, normalizeArray } from '../paper-engine-utils.js';
import { REAL_PAPER_AUTOPILOT } from './types.js';
import { getDefaultAgentConfig } from '../paper-engine-config.js';

export function isHermesBrokerOrderId(engine: any, orderId: string | null | undefined): boolean {
  return typeof orderId === 'string' && orderId.startsWith('paper-');
}

export function matchesHermesBrokerOrderForAgent(engine: any, agent: any, orderId: string | null | undefined): boolean {
  return typeof orderId === 'string' && orderId.startsWith(`paper-${agent.config.id}-`);
}

export function isOwnedBrokerFill(engine: any, fill: any): boolean {
  const agent = engine.agents.get(fill.agentId);
  if (!agent) return false;
  if (agent.config.executionMode !== 'broker-paper') return true;
  return fill.source === 'broker' && engine.matchesHermesBrokerOrderForAgent(agent, fill.orderId);
}

export function isOwnedBrokerJournal(engine: any, entry: any): boolean {
  const agent = engine.getBrokerPaperAgentByStrategy(entry.strategy);
  if (!agent) return true;
  return entry.source === 'broker';
}

export function isRestoredExternalBrokerJournal(engine: any, entry: any): boolean {
  return engine.getBrokerPaperAgentByStrategy(entry.strategy) !== null
    && entry.thesis.startsWith('Restored broker-backed Alpaca paper position');
}

export function isRestoredExternalBrokerExitFill(engine: any, fill: any, journalEntries: any[]): boolean {
  const agent = engine.agents.get(fill.agentId);
  if (!agent || agent.config.executionMode !== 'broker-paper' || fill.source !== 'broker') return false;
  const fillTimestamp = Date.parse(fill.timestamp);
  return journalEntries.some(entry => {
    if (!engine.isRestoredExternalBrokerJournal(entry)) return false;
    if (entry.symbol !== fill.symbol || entry.strategy !== `${agent.config.name} / scalping`) return false;
    const exitTimestamp = Date.parse(entry.exitAt);
    return Math.abs(exitTimestamp - fillTimestamp) <= 120_000;
  });
}

export function hasMatchingOwnedBrokerEntryFill(engine: any, fill: any, fills: any[]): boolean {
  if (fill.side !== 'sell') return true;
  const fillTimestamp = Date.parse(fill.timestamp);
  return fills.some(candidate => {
    if (candidate.agentId !== fill.agentId || candidate.symbol !== fill.symbol || candidate.side !== 'buy') return false;
    if (!engine.isOwnedBrokerFill(candidate)) return false;
    const candidateTimestamp = Date.parse(candidate.timestamp);
    return candidateTimestamp <= fillTimestamp;
  });
}

export function getBrokerSellQuantity(engine: any, agent: any, trackedQuantity: number): number {
  const brokerPositions = engine.getLatestBrokerPositions();
  const brokerPos = brokerPositions.get(agent.config.symbol);
  const qty = brokerPos ?? trackedQuantity;
  const decimals = agent.config.symbol.endsWith('-USD') ? 8 : 6;
  const factor = 10 ** decimals;
  return Math.floor(qty * factor) / factor;
}

export function toBrokerPaperAccountState(engine: any, snapshot: any): any {
  const account = asRecord(snapshot.account);
  if (snapshot.broker === 'coinbase-live') {
    const accounts = normalizeArray(account.accounts);
    const cash = round(accounts.reduce((sum, item) => {
      const record = asRecord(item);
      const currency = textField(record, ['currency']) ?? '';
      if (currency !== 'USD' && currency !== 'USDC') return sum;
      return sum + (numberField(record, ['available_balance.value', 'available_balance', 'balance.value', 'balance', 'value']) ?? 0);
    }, 0), 2);
    const markValue = round(snapshot.positions.reduce((sum, p) => sum + p.markPrice * p.quantity, 0), 2);
    const equity = round(cash + markValue, 2);
    return { asOf: snapshot.asOf, status: snapshot.status, cash, equity, dayBaseline: equity, buyingPower: cash };
  }
  const cash = numberField(account, ['cash', 'portfolio_cash', 'balance']) ?? 0;
  const equity = numberField(account, ['equity', 'portfolio_value', 'NAV', 'last_equity', 'value']) ?? cash;
  const dayBaseline = numberField(account, ['last_equity', 'portfolio_value', 'NAV', 'equity', 'cash']) ?? equity;
  const buyingPower = numberField(account, ['buying_power', 'buyingPower', 'daytrading_buying_power', 'cash']) ?? cash;
  return { asOf: snapshot.asOf, status: snapshot.status, cash: round(cash, 2), equity: round(equity, 2), dayBaseline: round(dayBaseline, 2), buyingPower: round(buyingPower, 2) };
}

export function sanitizeBrokerPaperRuntimeState(engine: any): void {
  const sanitizedJournal = engine.journal.filter(entry => engine.isOwnedBrokerJournal(entry) && !engine.isRestoredExternalBrokerJournal(entry));
  const sanitizedFills = engine.fills.filter(fill => engine.isOwnedBrokerFill(fill) && engine.hasMatchingOwnedBrokerEntryFill(fill, engine.fills) && !engine.isRestoredExternalBrokerExitFill(fill, engine.journal));
  engine.fills.splice(0, engine.fills.length, ...sanitizedFills);
  engine.journal.splice(0, engine.journal.length, ...sanitizedJournal);

  const outcomesByAgent = new Map<string, number[]>();
  for (const agent of engine.agents.values()) {
    if (agent.config.executionMode !== 'broker-paper') continue;
    agent.realizedPnl = 0; agent.feesPaid = 0; agent.wins = 0; agent.losses = 0; agent.trades = 0; agent.lastExitPnl = 0;
    agent.recentOutcomes = []; agent.recentHoldTicks = []; agent.position = null; agent.pendingOrderId = null; agent.pendingSide = null;
    agent.cash = round(agent.startingEquity, 2); agent.status = 'watching';
  }

  for (const fill of sanitizedFills) {
    if (fill.side !== 'sell') continue;
    const agent = engine.agents.get(fill.agentId);
    if (!agent || agent.config.executionMode !== 'broker-paper') continue;
    agent.realizedPnl = round(agent.realizedPnl + fill.pnlImpact, 2);
    agent.trades += 1;
    if (fill.pnlImpact >= 0) agent.wins += 1; else agent.losses += 1;
    agent.lastExitPnl = fill.pnlImpact; agent.lastSymbol = fill.symbol;
    const outcomes = outcomesByAgent.get(fill.agentId) ?? [];
    outcomes.push(fill.pnlImpact); outcomesByAgent.set(fill.agentId, outcomes);
  }

  for (const agent of engine.agents.values()) {
    if (agent.config.executionMode !== 'broker-paper') continue;
    if ((outcomesByAgent.get(agent.config.id) ?? []).length === 0) {
      const defaultConfig = getDefaultAgentConfig(agent.config.id, REAL_PAPER_AUTOPILOT);
      if (defaultConfig) { agent.baselineConfig = { ...defaultConfig }; agent.config = { ...defaultConfig }; }
    }
    agent.recentOutcomes = pickLast(outcomesByAgent.get(agent.config.id) ?? [], 8);
    agent.cash = round(agent.startingEquity + agent.realizedPnl, 2);
    if (agent.trades > 0) {
      const symbol = engine.market.get(agent.config.symbol);
      if (symbol) engine.applyAdaptiveTuning(agent, symbol);
    }
    agent.curve = Array.from({ length: Math.max(engine.deskCurve.length, 1) }, () => engine.getAgentEquity(agent));
  }
}

export function hasHermesBrokerPosition(engine: any, agent: any, brokerOrders: unknown[]): boolean {
  return brokerOrders.some((order) => {
    const record = asRecord(order);
    const clientOrderId = textField(record, ['client_order_id', 'clientOrderId']);
    const symbol = textField(record, ['symbol']);
    const status = textField(record, ['status', 'order_status']);
    if (!engine.matchesHermesBrokerOrderForAgent(agent, clientOrderId)) {
      return false;
    }
    if (!symbol || symbol.replace('/', '-').toUpperCase() !== agent.config.symbol) {
      return false;
    }
    return status !== 'canceled' && status !== 'rejected';
  });
}

export function syncMarketFromRuntime(engine: any, recordHistory: boolean): boolean {
  const runtime = engine.loadMarketDataState();
  if (!runtime) {
    if (engine.tick <= 3) console.log(`[paper-engine] tick ${engine.tick}: market-data runtime not available yet`);
    return false;
  }

  engine.marketDataSources = runtime.sources;
  const snapshotMap = new Map(runtime.snapshots.map((snapshot) => [snapshot.symbol, snapshot]));
  if (engine.tick <= 3) console.log(`[paper-engine] tick ${engine.tick}: loaded ${snapshotMap.size} market snapshots`);

  for (const symbol of engine.market.values()) {
    const snapshot = snapshotMap.get(symbol.symbol);
    if (snapshot) {
      engine.applyMarketSnapshot(symbol, snapshot, recordHistory);
    } else {
      symbol.marketStatus = 'stale';
      symbol.sourceMode = 'service';
      symbol.session = symbol.assetClass === 'equity' ? 'unknown' : 'regular';
      symbol.tradable = false;
      symbol.qualityFlags = ['awaiting-market-data'];
      symbol.updatedAt = runtime.asOf;
    }
  }

  return snapshotMap.size > 0;
}

export function applyMarketSnapshot(engine: any, symbol: any, snapshot: any, recordHistory: boolean): void {
  // Don't overwrite good data with a zero-price snapshot from another broker
  if (snapshot.lastPrice <= 0 && symbol.price > 0 && symbol.tradable) return;

  const previousPrice = symbol.price;
  const nextPrice = snapshot.lastPrice > 0 ? snapshot.lastPrice : previousPrice;
  const previousSourceMode = symbol.sourceMode;
  const openPrice = snapshot.changePct !== 0
    ? nextPrice / (1 + snapshot.changePct / 100)
    : symbol.openPrice > 0
      ? symbol.openPrice
      : nextPrice;
  const nextReturn = previousPrice > 0 ? (nextPrice - previousPrice) / previousPrice : 0;
  const session = snapshot.session ?? (snapshot.assetClass === 'equity' ? 'unknown' : 'regular');
  const qualityFlags = Array.isArray(snapshot.qualityFlags) ? [...snapshot.qualityFlags] : [];
  const tradable = snapshot.tradable ?? (
    snapshot.status === 'live'
    && snapshot.source !== 'mock'
    && snapshot.source !== 'simulated'
    && nextPrice > 0
    && session === 'regular'
    && qualityFlags.length === 0
  );

  symbol.broker = snapshot.broker;
  symbol.assetClass = snapshot.assetClass;
  symbol.marketStatus = snapshot.status;
  symbol.sourceMode = snapshot.source ?? 'service';
  symbol.session = session;
  symbol.tradable = tradable;
  symbol.qualityFlags = qualityFlags;
  symbol.updatedAt = snapshot.updatedAt ?? new Date().toISOString();
  symbol.price = round(nextPrice, 2);
  symbol.openPrice = round(openPrice, 2);
  symbol.volume = snapshot.volume;
  symbol.spreadBps = snapshot.spreadBps;
  // Guard against || resetting baseSpreadBps to undefined when snapshot.spreadBps
  // is falsy (NaN, 0, undefined). Preserve existing base on invalid snapshots.
  if (typeof snapshot.spreadBps === 'number' && snapshot.spreadBps > 0) {
    symbol.baseSpreadBps = snapshot.spreadBps;
  }
  symbol.liquidityScore = snapshot.liquidityScore;
  symbol.meanAnchor = symbol.meanAnchor * 0.9 + symbol.price * 0.1;
  symbol.bias = clamp(symbol.bias * 0.7 + nextReturn * 0.3, -0.0015, 0.0015);

  const switchedToRuntimeTape =
    (previousSourceMode === 'simulated' || previousSourceMode === 'mock')
    && snapshot.source !== 'simulated'
    && snapshot.source !== 'mock';
  const historyDiverged = previousPrice > 0 && Math.abs((nextPrice - previousPrice) / previousPrice) > 0.2;

  if (switchedToRuntimeTape || historyDiverged) {
    symbol.history = Array.from({ length: 24 }, () => round(symbol.price, 2));
    symbol.returns = Array.from({ length: 24 }, () => 0);
  }

  if (recordHistory) {
    engine.pushPoint(symbol.history, symbol.price);
    engine.pushPoint(symbol.returns, nextReturn);
  }

  engine.applySpreadShockGuard(symbol);
  engine.queueEventDrivenExit(symbol, 'quote');
}

export function getLatestBrokerPositions(engine: any): Map<string, number> {
  return engine._brokerPositionCache ?? new Map();
}
