import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { ExternalMakerFill, MakerQuoteState } from './maker-engine.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ENV_PATH = path.resolve(MODULE_DIR, '../../../.env');
const ENV_CACHE = loadProjectEnv();
const LEGACY_ENV_CACHE = loadLegacyEnv();
const BROKER_ROUTER_URL = readEnv(['BROKER_ROUTER_URL']) || 'http://127.0.0.1:4303';
const LIVE_ROUTING_ENABLED = readEnv(['HERMES_ENABLE_LIVE_MAKER_ROUTING'], 'false').toLowerCase() === 'true';
const QUOTE_NOTIONAL = readEnvNumber(['HERMES_MAKER_QUOTE_NOTIONAL'], 250);
const MAX_LIVE_QUOTE_NOTIONAL = readEnvNumber(['HERMES_MAKER_MAX_LIVE_QUOTE_NOTIONAL'], 100);
const LIVE_SYMBOLS = readEnvList(['HERMES_MAKER_LIVE_SYMBOLS'], ['BTC-USD']);
const CURRENT_COINBASE_ORDER_KEY_ID = readEnv(['COINBASE_TRADING_API_KEY', 'COINBASE_TRADE_API_KEY', 'COINBASE_API_KEY', 'CDP_API_KEY_NAME'], '');
const MIN_REFRESH_BPS = readEnvNumber(['HERMES_MAKER_REFRESH_BPS'], 0.8);
const MIN_REFRESH_MS = readEnvNumber(['HERMES_MAKER_REFRESH_MS'], 7_500);
const REJECT_COOLDOWN_MS = readEnvNumber(['HERMES_MAKER_REJECT_COOLDOWN_MS'], 900_000);
const RUNTIME_STATE_PATH = path.resolve(MODULE_DIR, '../.runtime/paper-ledger/maker-order-state.json');

interface ActiveMakerOrder {
  side: 'buy' | 'sell';
  symbol: string;
  clientOrderId: string;
  brokerOrderId?: string;
  price: number;
  quantity: number;
  status: 'shadow' | 'working' | 'rejected' | 'canceled' | 'filled';
  brokerStatus: string;
  live: boolean;
  reason: string;
  updatedAt: string;
  awaitingFillReconciliation?: boolean;
}

interface DesiredMakerOrder {
  side: 'buy' | 'sell';
  symbol: string;
  price: number;
  quantity: number;
  postOnly: true;
  timeInForce: 'gtc';
  strategy: string;
  mode: 'shadow' | 'live';
  reason: string;
}

interface MakerExecutorState {
  symbol: string;
  liveRoutingEnabled: boolean;
  desiredBid: DesiredMakerOrder | null;
  desiredAsk: DesiredMakerOrder | null;
  activeBid: ActiveMakerOrder | null;
  activeAsk: ActiveMakerOrder | null;
  fatalErrorUntil?: string | null;
  fatalErrorReason?: string | null;
  credentialBlocked?: boolean;
  blockedCredentialKeyId?: string | null;
  fundingBlocked?: boolean;
  fundingReason?: string | null;
  lastAction: string;
  lastSyncAt: string;
}

interface MakerRolloutPolicy {
  liveRoutingEnabled: boolean;
  liveSymbols: string[];
  defaultQuoteNotional: number;
  maxLiveQuoteNotional: number;
  requirePostOnly: true;
  timeInForce: 'gtc';
  notes: string[];
}

interface CoinbaseBrokerSnapshot {
  broker?: string;
  account?: unknown;
  orders?: unknown[];
  fills?: unknown[];
}

interface CoinbaseBrokerAccountResponse {
  brokers?: CoinbaseBrokerSnapshot[];
}

interface CoinbaseOrderRecord {
  order_id?: string;
  client_order_id?: string;
  product_id?: string;
  status?: string;
  side?: string;
  created_time?: string;
  last_update_time?: string;
  average_filled_price?: string;
  filled_size?: string;
}

interface CoinbaseFillRecord {
  entry_id?: string;
  order_id?: string;
  price?: string;
  size?: string;
  size_in_quote?: boolean;
  commission?: string;
  trade_time?: string;
  side?: string;
}

interface CoinbaseBrokerData {
  orders: CoinbaseOrderRecord[];
  fills: CoinbaseFillRecord[];
  balances: Record<string, number>;
}

function loadProjectEnv(): Record<string, string> {
  const values: Record<string, string> = {};
  try {
    if (!fs.existsSync(PROJECT_ENV_PATH)) return values;
    for (const rawLine of fs.readFileSync(PROJECT_ENV_PATH, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim();
      let value = line.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !(key in values)) values[key] = value;
    }
  } catch {
    // Ignore local env read failures.
  }
  return values;
}

function loadLegacyEnv(): Record<string, string> {
  const files = [
    path.resolve(MODULE_DIR, '../../../../project-sanctuary/hermes-trading-post/backend/.env'),
    path.resolve(MODULE_DIR, '../../../../project-sanctuary/hermes-trading-post/backend/live-bots/.env'),
    path.resolve(MODULE_DIR, '../../../../project-sanctuary/hermes-trading-post/backend/live-ai-bots/.env')
  ];
  const values: Record<string, string> = {};
  try {
    for (const filePath of files) {
      if (!fs.existsSync(filePath)) continue;
      for (const rawLine of fs.readFileSync(filePath, 'utf8').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const idx = line.indexOf('=');
        if (idx <= 0) continue;
        const key = line.slice(0, idx).trim();
        let value = line.slice(idx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        if (key && !(key in values)) values[key] = value;
      }
    }
  } catch {
    // Ignore legacy env read failures.
  }
  return values;
}

function readEnv(names: string[], fallback = ''): string {
  for (const name of names) {
    const value = process.env[name] ?? ENV_CACHE[name] ?? LEGACY_ENV_CACHE[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fallback;
}

function readEnvNumber(names: string[], fallback: number): number {
  const value = Number(readEnv(names, ''));
  return Number.isFinite(value) ? value : fallback;
}

function readEnvList(names: string[], fallback: string[]): string[] {
  const value = readEnv(names, '');
  if (!value) return fallback;
  const parsed = value
    .split(',')
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function round(value: number, decimals: number): number {
  return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeCoinbaseOrderStatus(value: string): ActiveMakerOrder['status'] {
  const status = value.toUpperCase();
  if (status.includes('FILLED')) return 'filled';
  if (status.includes('CANCEL')) return 'canceled';
  if (status.includes('REJECT') || status.includes('FAILED') || status.includes('EXPIRE')) return 'rejected';
  if (status.includes('OPEN') || status.includes('PENDING') || status.includes('ACTIVE')) return 'working';
  return 'working';
}

export class MakerOrderExecutor {
  private readonly states = new Map<string, MakerExecutorState>();
  private readonly processedFillIds = new Set<string>();

  constructor() {
    this.restore();
  }

  async reconcile(quotes: MakerQuoteState[]): Promise<ExternalMakerFill[]> {
    const brokerData = LIVE_ROUTING_ENABLED ? await this.fetchCoinbaseBrokerData() : { orders: [], fills: [], balances: {} };
    const externalFills: ExternalMakerFill[] = [];
    for (const quote of quotes) {
      const fills = await this.reconcileSymbol(quote, brokerData.orders, brokerData.fills, brokerData.balances);
      externalFills.push(...fills);
    }
    this.persist();
    return externalFills;
  }

  getPolicy(): MakerRolloutPolicy {
    return {
      liveRoutingEnabled: LIVE_ROUTING_ENABLED,
      liveSymbols: [...LIVE_SYMBOLS],
      defaultQuoteNotional: QUOTE_NOTIONAL,
      maxLiveQuoteNotional: MAX_LIVE_QUOTE_NOTIONAL,
      requirePostOnly: true,
      timeInForce: 'gtc',
      notes: [
        'Live maker routing stays disabled by default.',
        'Even when enabled, only explicitly allowed symbols can route.',
        'Quote notional is capped for canary rollout safety.'
      ]
    };
  }

  getSnapshot(): { asOf: string; liveRoutingEnabled: boolean; policy: MakerRolloutPolicy; states: MakerExecutorState[] } {
    return {
      asOf: new Date().toISOString(),
      liveRoutingEnabled: LIVE_ROUTING_ENABLED,
      policy: this.getPolicy(),
      states: Array.from(this.states.values()).sort((left, right) => left.symbol.localeCompare(right.symbol))
    };
  }

  clearBlocks(symbol?: string): void {
    const target = symbol?.toUpperCase();
    for (const state of this.states.values()) {
      if (target && state.symbol.toUpperCase() !== target) continue;
      state.credentialBlocked = false;
      state.blockedCredentialKeyId = null;
      state.fatalErrorUntil = null;
      state.fatalErrorReason = null;
      state.fundingBlocked = false;
      state.fundingReason = null;
      state.lastAction = 'Operator cleared maker route blocks.';
      state.lastSyncAt = new Date().toISOString();
    }
    this.persist();
  }

  private async reconcileSymbol(
    quote: MakerQuoteState,
    brokerOrders: CoinbaseOrderRecord[],
    brokerFills: CoinbaseFillRecord[],
    balances: Record<string, number>
  ): Promise<ExternalMakerFill[]> {
    const state = this.states.get(quote.symbol) ?? {
      symbol: quote.symbol,
      liveRoutingEnabled: LIVE_ROUTING_ENABLED,
      desiredBid: null,
      desiredAsk: null,
      activeBid: null,
      activeAsk: null,
      fatalErrorUntil: null,
      fatalErrorReason: null,
      credentialBlocked: false,
      blockedCredentialKeyId: null,
      fundingBlocked: false,
      fundingReason: null,
      lastAction: 'Waiting for first quote sync.',
      lastSyncAt: new Date().toISOString()
    };

    const desiredBid = quote.bidQuote && quote.mode === 'maker'
      ? this.buildDesiredOrder(quote, 'buy', quote.bidQuote)
      : null;
    const desiredAsk = quote.askQuote && quote.mode === 'maker' && quote.inventoryQty > 0
      ? this.buildDesiredOrder(quote, 'sell', quote.askQuote)
      : null;
    if (state.credentialBlocked && state.blockedCredentialKeyId && state.blockedCredentialKeyId !== CURRENT_COINBASE_ORDER_KEY_ID) {
      state.credentialBlocked = false;
      state.blockedCredentialKeyId = null;
      state.fatalErrorReason = null;
      state.fatalErrorUntil = null;
    }
    const fundingReason = this.getFundingBlockReason(quote.symbol, desiredBid, desiredAsk, balances);
    state.fundingBlocked = fundingReason !== null;
    state.fundingReason = fundingReason;
    const fatalPauseActive = Boolean(state.fatalErrorUntil && Date.parse(state.fatalErrorUntil) > Date.now());
    if (!fatalPauseActive) {
      state.fatalErrorUntil = null;
      if (!state.credentialBlocked) {
        state.fatalErrorReason = null;
      }
    }

    state.desiredBid = desiredBid;
    state.desiredAsk = desiredAsk;
    const routingPaused = fatalPauseActive || state.credentialBlocked === true || state.fundingBlocked === true;
    state.activeBid = await this.syncSide(state.activeBid, routingPaused ? null : desiredBid, brokerOrders);
    state.activeAsk = await this.syncSide(state.activeAsk, routingPaused ? null : desiredAsk, brokerOrders);
    const externalFills = this.extractExternalFills([state.activeBid, state.activeAsk], quote.symbol, brokerFills);
    const rejection = [state.activeBid, state.activeAsk].find((order) => order?.status === 'rejected');
    if (rejection && this.isFatalRouteRejection(rejection)) {
      if (this.isCredentialScopeRejection(rejection)) {
        state.credentialBlocked = true;
        state.blockedCredentialKeyId = CURRENT_COINBASE_ORDER_KEY_ID || null;
        state.fatalErrorReason = rejection.reason;
        state.fatalErrorUntil = null;
      } else {
        state.fatalErrorUntil = new Date(Date.now() + REJECT_COOLDOWN_MS).toISOString();
        state.fatalErrorReason = rejection.reason;
      }
    }
    state.liveRoutingEnabled = LIVE_ROUTING_ENABLED;
    state.lastSyncAt = new Date().toISOString();
    state.lastAction = quote.mode === 'paused'
      ? `Paused: ${quote.reason}`
      : state.fundingBlocked && state.fundingReason
        ? `Live maker routing blocked by funding: ${state.fundingReason}`
        : state.credentialBlocked && state.fatalErrorReason
          ? `Live maker routing blocked until credentials change or blocks are cleared: ${state.fatalErrorReason}`
          : fatalPauseActive && state.fatalErrorReason
            ? `Live maker routing cooling down after broker rejection: ${state.fatalErrorReason}`
            : rejection
              ? `Live maker routing paused after rejection: ${rejection.reason}`
              : !LIVE_ROUTING_ENABLED
                ? 'Shadow maker routing only. Live broker placement disabled by env.'
                : externalFills.length > 0
                  ? `Processed ${externalFills.length} broker fill(s) for ${quote.symbol}.`
                  : 'Live maker routing enabled and broker order reconciliation active.';

    this.states.set(quote.symbol, state);
    return externalFills;
  }

  private buildDesiredOrder(quote: MakerQuoteState, side: 'buy' | 'sell', price: number): DesiredMakerOrder {
    const notional = LIVE_ROUTING_ENABLED
      ? Math.min(QUOTE_NOTIONAL, MAX_LIVE_QUOTE_NOTIONAL)
      : QUOTE_NOTIONAL;
    const quantity = round(notional / Math.max(price, Number.EPSILON), 6);
    return {
      side,
      symbol: quote.symbol,
      price: round(price, 2),
      quantity,
      postOnly: true,
      timeInForce: 'gtc',
      strategy: `${quote.symbol} Maker`,
      mode: LIVE_ROUTING_ENABLED ? 'live' : 'shadow',
      reason: `${quote.reason} Width ${quote.widthBps.toFixed(2)}bps, adverse ${quote.adverseScore.toFixed(1)}, spreadStable ${quote.spreadStableMs}ms, pressure ${quote.pressureImbalancePct.toFixed(1)}%.`
    };
  }

  private async syncSide(
    current: ActiveMakerOrder | null,
    desired: DesiredMakerOrder | null,
    brokerOrders: CoinbaseOrderRecord[]
  ): Promise<ActiveMakerOrder | null> {
    const reconciled = current?.live ? this.reconcileWithBroker(current, brokerOrders) : current;

    if (!desired) {
      if (!reconciled) return null;
      if (reconciled.status === 'filled' && reconciled.awaitingFillReconciliation !== true) {
        return null;
      }
      if (LIVE_ROUTING_ENABLED && reconciled.brokerOrderId && reconciled.status === 'working') {
        await this.cancelBrokerOrder(reconciled.brokerOrderId, reconciled.symbol);
      }
      return {
        ...reconciled,
        status: 'canceled',
        brokerStatus: reconciled.live ? 'CANCELED_LOCALLY' : 'SHADOW_CANCELED',
        updatedAt: new Date().toISOString(),
        reason: 'Quote withdrawn.',
        awaitingFillReconciliation: false
      };
    }

    if (reconciled?.status === 'filled' && reconciled.awaitingFillReconciliation === true) {
      return reconciled;
    }

    if (reconciled?.status === 'rejected' && this.isFatalRouteRejection(reconciled)) {
      const ageMs = Date.now() - Date.parse(reconciled.updatedAt);
      if (ageMs < REJECT_COOLDOWN_MS) {
        return reconciled;
      }
    }

    const shouldRefresh = !reconciled
      || Math.abs(reconciled.price - desired.price) / Math.max(desired.price, Number.EPSILON) * 10_000 >= MIN_REFRESH_BPS
      || reconciled.quantity !== desired.quantity
      || (Date.now() - Date.parse(reconciled.updatedAt)) >= MIN_REFRESH_MS
      || reconciled.status === 'rejected'
      || reconciled.status === 'canceled'
      || reconciled.status === 'filled';

    if (!shouldRefresh) {
      return reconciled;
    }

    if (LIVE_ROUTING_ENABLED) {
      if (reconciled?.brokerOrderId && reconciled.status === 'working') {
        await this.cancelBrokerOrder(reconciled.brokerOrderId, reconciled.symbol);
      }
      return this.routeBrokerOrder(desired);
    }

    return {
      side: desired.side,
      symbol: desired.symbol,
      clientOrderId: `shadow-maker-${desired.symbol}-${desired.side}-${randomUUID()}`,
      price: desired.price,
      quantity: desired.quantity,
      status: 'shadow',
      brokerStatus: 'SHADOW',
      live: false,
      reason: desired.reason,
      updatedAt: new Date().toISOString()
    };
  }

  private getFundingBlockReason(
    symbol: string,
    desiredBid: DesiredMakerOrder | null,
    desiredAsk: DesiredMakerOrder | null,
    balances: Record<string, number>
  ): string | null {
    const [baseCurrency = '', quoteCurrency = ''] = symbol.toUpperCase().split('-');
    if (desiredBid) {
      const availableQuote = balances[quoteCurrency] ?? 0;
      const requiredQuote = desiredBid.price * desiredBid.quantity * 1.01;
      if (availableQuote + 1e-8 < requiredQuote) {
        return `Need about ${round(requiredQuote, 2)} ${quoteCurrency} for ${symbol} maker bid, but only ${round(availableQuote, 2)} is available.`;
      }
    }
    if (desiredAsk) {
      const availableBase = balances[baseCurrency] ?? 0;
      if (availableBase + 1e-8 < desiredAsk.quantity) {
        return `Need ${round(desiredAsk.quantity, 6)} ${baseCurrency} for ${symbol} maker ask, but only ${round(availableBase, 6)} is available.`;
      }
    }
    return null;
  }

  private isFatalRouteRejection(order: ActiveMakerOrder): boolean {
    const reason = `${order.brokerStatus} ${order.reason}`.toLowerCase();
    return reason.includes('missing required scopes')
      || reason.includes('permission')
      || reason.includes('scope')
      || reason.includes('symbol_not_allowed')
      || reason.includes('symbol not allowed')
      || reason.includes('insufficient_fund')
      || reason.includes('insufficient fund')
      || reason.includes('insufficient balance');
  }

  private isCredentialScopeRejection(order: ActiveMakerOrder): boolean {
    const reason = `${order.brokerStatus} ${order.reason}`.toLowerCase();
    return reason.includes('missing required scopes')
      || reason.includes('permission')
      || reason.includes('scope');
  }

  private reconcileWithBroker(current: ActiveMakerOrder, brokerOrders: CoinbaseOrderRecord[]): ActiveMakerOrder {
    const match = brokerOrders.find((order) =>
      text(order.order_id) === (current.brokerOrderId ?? '')
      || text(order.client_order_id) === current.clientOrderId
    );
    if (!match) {
      return current;
    }

    const brokerStatus = text(match.status);
    const normalizedStatus = normalizeCoinbaseOrderStatus(brokerStatus);
    return {
      ...current,
      ...(text(match.order_id) ? { brokerOrderId: text(match.order_id) } : {}),
      status: normalizedStatus,
      brokerStatus: brokerStatus || current.brokerStatus,
      updatedAt: text(match.last_update_time) || current.updatedAt,
      reason: brokerStatus ? `Broker reports ${brokerStatus}.` : current.reason,
      awaitingFillReconciliation: normalizedStatus === 'filled'
        ? (current.awaitingFillReconciliation ?? true)
        : false
    };
  }

  private extractExternalFills(
    orders: Array<ActiveMakerOrder | null>,
    symbol: string,
    brokerFills: CoinbaseFillRecord[]
  ): ExternalMakerFill[] {
    const activeOrders = orders.filter((order): order is ActiveMakerOrder => order !== null && order.live);
    const externalFills: ExternalMakerFill[] = [];

    for (const order of activeOrders) {
      const relevant = brokerFills.filter((fill) => text(fill.order_id) === (order.brokerOrderId ?? ''));
      let matched = false;
      for (const fill of relevant) {
        const entryId = text(fill.entry_id);
        if (!entryId || this.processedFillIds.has(entryId)) {
          continue;
        }
        const price = Number(fill.price ?? 0);
        const rawSize = Number(fill.size ?? 0);
        const sizeInQuote = fill.size_in_quote === true;
        const quantity = sizeInQuote && price > 0 ? rawSize / price : rawSize;
        if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
          continue;
        }
        const fee = Number(fill.commission ?? 0);
        const side = text(fill.side).toUpperCase() === 'SELL' ? 'sell' : 'buy';
        externalFills.push({
          id: `maker-broker-fill-${entryId}`,
          symbol,
          side,
          price,
          quantity: round(quantity, 6),
          fee: Number.isFinite(fee) ? fee : 0,
          timestamp: text(fill.trade_time) || new Date().toISOString(),
          reason: 'broker-maker-fill'
        });
        this.processedFillIds.add(entryId);
        matched = true;
      }
      if (matched) {
        order.awaitingFillReconciliation = false;
      }
    }

    return externalFills;
  }

  private async routeBrokerOrder(order: DesiredMakerOrder): Promise<ActiveMakerOrder> {
    const clientOrderId = `maker-${order.symbol}-${order.side}-${randomUUID()}`;
    if (!LIVE_SYMBOLS.includes(order.symbol.toUpperCase())) {
      return {
        side: order.side,
        symbol: order.symbol,
        clientOrderId,
        price: order.price,
        quantity: order.quantity,
        status: 'rejected',
        brokerStatus: 'SYMBOL_NOT_ALLOWED',
        live: true,
        reason: `Live maker rollout only allows ${LIVE_SYMBOLS.join(', ')}.`,
        updatedAt: new Date().toISOString()
      };
    }
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch(`${BROKER_ROUTER_URL}/route`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: clientOrderId,
          symbol: order.symbol,
          broker: 'coinbase-live',
          side: order.side,
          orderType: 'limit',
          notional: round(order.price * order.quantity, 2),
          quantity: order.quantity,
          limitPrice: order.price,
          timeInForce: order.timeInForce,
          postOnly: true,
          strategy: order.strategy,
          mode: 'live',
          thesis: order.reason
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      const report = await response.json() as { orderId?: string; status?: string; message?: string };
      const brokerStatus = text(report.status).toUpperCase();
      const normalizedStatus = response.ok && (brokerStatus === 'ACCEPTED' || brokerStatus === 'FILLED')
        ? (brokerStatus === 'FILLED' ? 'filled' : 'working')
        : 'rejected';
      return {
        side: order.side,
        symbol: order.symbol,
        clientOrderId,
        ...(report.orderId ? { brokerOrderId: report.orderId } : {}),
        price: order.price,
        quantity: order.quantity,
        status: normalizedStatus,
        brokerStatus: brokerStatus || 'REJECTED',
        live: true,
        reason: report.message ?? order.reason,
        updatedAt: new Date().toISOString(),
        awaitingFillReconciliation: normalizedStatus === 'filled'
      };
    } catch (error) {
      return {
        side: order.side,
        symbol: order.symbol,
        clientOrderId,
        price: order.price,
        quantity: order.quantity,
        status: 'rejected',
        brokerStatus: 'ROUTE_ERROR',
        live: true,
        reason: error instanceof Error ? error.message : 'unknown broker route error',
        updatedAt: new Date().toISOString()
      };
    }
  }

  private async cancelBrokerOrder(orderId: string, symbol: string): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      await fetch(`${BROKER_ROUTER_URL}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broker: 'coinbase-live', orderId, symbol }),
        signal: controller.signal
      });
      clearTimeout(timeout);
    } catch {
      // Non-critical in maker preview mode.
    }
  }

  private async fetchCoinbaseBrokerData(): Promise<CoinbaseBrokerData> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      const response = await fetch(`${BROKER_ROUTER_URL}/account?broker=coinbase-live`, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) return { orders: [], fills: [], balances: {} };
      const body = await response.json() as CoinbaseBrokerAccountResponse;
      const broker = Array.isArray(body.brokers)
        ? body.brokers.find((entry) => entry?.broker === 'coinbase-live')
        : undefined;
      return {
        orders: Array.isArray(broker?.orders)
          ? broker.orders.filter((order): order is CoinbaseOrderRecord => !!order && typeof order === 'object')
          : [],
        fills: Array.isArray(broker?.fills)
          ? broker.fills.filter((fill): fill is CoinbaseFillRecord => !!fill && typeof fill === 'object')
          : [],
        balances: this.extractBalances(broker?.account)
      };
    } catch {
      return { orders: [], fills: [], balances: {} };
    }
  }

  private extractBalances(account: unknown): Record<string, number> {
    const balances: Record<string, number> = {};
    const records = account && typeof account === 'object' && Array.isArray((account as { accounts?: unknown[] }).accounts)
      ? (account as { accounts: unknown[] }).accounts
      : [];
    for (const entry of records) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as { currency?: unknown; available_balance?: { value?: unknown }; balance?: { value?: unknown } | unknown };
      const currency = typeof record.currency === 'string' ? record.currency.toUpperCase() : '';
      const raw = typeof record.available_balance === 'object' && record.available_balance !== null
        ? (record.available_balance as { value?: unknown }).value
        : typeof record.balance === 'object' && record.balance !== null
          ? (record.balance as { value?: unknown }).value
          : record.balance;
      const value = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
      if (currency && Number.isFinite(value)) {
        balances[currency] = value;
      }
    }
    return balances;
  }

  private restore(): void {
    try {
      if (!fs.existsSync(RUNTIME_STATE_PATH)) return;
      const raw = fs.readFileSync(RUNTIME_STATE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as { states?: MakerExecutorState[]; processedFillIds?: string[] };
      for (const state of parsed.states ?? []) {
        this.states.set(state.symbol, state);
      }
      for (const fillId of parsed.processedFillIds ?? []) {
        if (typeof fillId === 'string' && fillId.length > 0) {
          this.processedFillIds.add(fillId);
        }
      }
    } catch {
      // Non-critical.
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(RUNTIME_STATE_PATH), { recursive: true });
      fs.writeFileSync(RUNTIME_STATE_PATH, JSON.stringify({
        savedAt: new Date().toISOString(),
        liveRoutingEnabled: LIVE_ROUTING_ENABLED,
        states: Array.from(this.states.values()),
        processedFillIds: Array.from(this.processedFillIds).slice(-500)
      }, null, 2), 'utf8');
    } catch {
      // Non-critical.
    }
  }
}
