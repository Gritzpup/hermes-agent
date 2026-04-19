import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { reconcileWithBroker, extractExternalFills, routeBrokerOrder, cancelBrokerOrder, fetchCoinbaseBrokerData, getFundingBlockReason, isFatalRouteRejection, isCredentialScopeRejection, } from './maker-executor-broker.js';
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
function loadProjectEnv() {
    const values = {};
    try {
        if (!fs.existsSync(PROJECT_ENV_PATH))
            return values;
        for (const rawLine of fs.readFileSync(PROJECT_ENV_PATH, 'utf8').split('\n')) {
            const line = rawLine.trim();
            if (!line || line.startsWith('#'))
                continue;
            const idx = line.indexOf('=');
            if (idx <= 0)
                continue;
            const key = line.slice(0, idx).trim();
            let value = line.slice(idx + 1).trim();
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            if (key && !(key in values))
                values[key] = value;
        }
    }
    catch {
        // Ignore local env read failures.
    }
    return values;
}
function loadLegacyEnv() {
    const files = [
        path.resolve(MODULE_DIR, '../../../../project-sanctuary/hermes-trading-post/backend/.env'),
        path.resolve(MODULE_DIR, '../../../../project-sanctuary/hermes-trading-post/backend/live-bots/.env'),
        path.resolve(MODULE_DIR, '../../../../project-sanctuary/hermes-trading-post/backend/live-ai-bots/.env')
    ];
    const values = {};
    try {
        for (const filePath of files) {
            if (!fs.existsSync(filePath))
                continue;
            for (const rawLine of fs.readFileSync(filePath, 'utf8').split('\n')) {
                const line = rawLine.trim();
                if (!line || line.startsWith('#'))
                    continue;
                const idx = line.indexOf('=');
                if (idx <= 0)
                    continue;
                const key = line.slice(0, idx).trim();
                let value = line.slice(idx + 1).trim();
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                if (key && !(key in values))
                    values[key] = value;
            }
        }
    }
    catch {
        // Ignore legacy env read failures.
    }
    return values;
}
function readEnv(names, fallback = '') {
    for (const name of names) {
        const value = process.env[name] ?? ENV_CACHE[name] ?? LEGACY_ENV_CACHE[name];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return fallback;
}
function readEnvNumber(names, fallback) {
    const value = Number(readEnv(names, ''));
    return Number.isFinite(value) ? value : fallback;
}
function readEnvList(names, fallback) {
    const value = readEnv(names, '');
    if (!value)
        return fallback;
    const parsed = value
        .split(',')
        .map((entry) => entry.trim().toUpperCase())
        .filter(Boolean);
    return parsed.length > 0 ? parsed : fallback;
}
function round(value, decimals) {
    return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}
export class MakerOrderExecutor {
    states = new Map();
    processedFillIds = new Set();
    constructor() {
        this.restore();
    }
    async reconcile(quotes) {
        const brokerData = LIVE_ROUTING_ENABLED ? await fetchCoinbaseBrokerData(BROKER_ROUTER_URL) : { orders: [], fills: [], balances: {} };
        const externalFills = [];
        for (const quote of quotes) {
            const fills = await this.reconcileSymbol(quote, brokerData.orders, brokerData.fills, brokerData.balances);
            externalFills.push(...fills);
        }
        this.persist();
        return externalFills;
    }
    getPolicy() {
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
    getSnapshot() {
        return {
            asOf: new Date().toISOString(),
            liveRoutingEnabled: LIVE_ROUTING_ENABLED,
            policy: this.getPolicy(),
            states: Array.from(this.states.values()).sort((left, right) => left.symbol.localeCompare(right.symbol))
        };
    }
    clearBlocks(symbol) {
        const target = symbol?.toUpperCase();
        for (const state of this.states.values()) {
            if (target && state.symbol.toUpperCase() !== target)
                continue;
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
    async reconcileSymbol(quote, brokerOrders, brokerFills, balances) {
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
        const fundingReason = getFundingBlockReason(quote.symbol, desiredBid, desiredAsk, balances);
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
        const externalFills = extractExternalFills([state.activeBid, state.activeAsk], quote.symbol, brokerFills, this.processedFillIds);
        const rejection = [state.activeBid, state.activeAsk].find((order) => order?.status === 'rejected');
        if (rejection && isFatalRouteRejection(rejection)) {
            if (isCredentialScopeRejection(rejection)) {
                state.credentialBlocked = true;
                state.blockedCredentialKeyId = CURRENT_COINBASE_ORDER_KEY_ID || null;
                state.fatalErrorReason = rejection.reason;
                state.fatalErrorUntil = null;
            }
            else {
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
    buildDesiredOrder(quote, side, price) {
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
    async syncSide(current, desired, brokerOrders) {
        const reconciled = current?.live ? reconcileWithBroker(current, brokerOrders) : current;
        if (!desired) {
            if (!reconciled)
                return null;
            if (reconciled.status === 'filled' && reconciled.awaitingFillReconciliation !== true) {
                return null;
            }
            if (LIVE_ROUTING_ENABLED && reconciled.brokerOrderId && reconciled.status === 'working') {
                await cancelBrokerOrder(reconciled.brokerOrderId, reconciled.symbol, BROKER_ROUTER_URL);
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
        if (reconciled?.status === 'rejected' && isFatalRouteRejection(reconciled)) {
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
                await cancelBrokerOrder(reconciled.brokerOrderId, reconciled.symbol, BROKER_ROUTER_URL);
            }
            return routeBrokerOrder(desired, BROKER_ROUTER_URL, LIVE_SYMBOLS);
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
    restore() {
        try {
            if (!fs.existsSync(RUNTIME_STATE_PATH))
                return;
            const raw = fs.readFileSync(RUNTIME_STATE_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            for (const state of parsed.states ?? []) {
                this.states.set(state.symbol, state);
            }
            for (const fillId of parsed.processedFillIds ?? []) {
                if (typeof fillId === 'string' && fillId.length > 0) {
                    this.processedFillIds.add(fillId);
                }
            }
        }
        catch {
            // Non-critical.
        }
    }
    persist() {
        try {
            fs.mkdirSync(path.dirname(RUNTIME_STATE_PATH), { recursive: true });
            fs.writeFileSync(RUNTIME_STATE_PATH, JSON.stringify({
                savedAt: new Date().toISOString(),
                liveRoutingEnabled: LIVE_ROUTING_ENABLED,
                states: Array.from(this.states.values()),
                processedFillIds: Array.from(this.processedFillIds).slice(-500)
            }, null, 2), 'utf8');
        }
        catch {
            // Non-critical.
        }
    }
}
