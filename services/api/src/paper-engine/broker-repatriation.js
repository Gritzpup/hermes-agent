// @ts-nocheck
/**
 * Broker Repatriation
 *
 * Adopts orphaned broker-side open positions into the paper-engine state so they
 * appear in agent tracking, closes land in the journal with realized P&L, and their
 * unrealized P&L flows through the rotation engine.
 *
 * This handles the case where positions were opened in a prior session and the state
 * snapshot rotated without tracking them.
 */
import { BROKER_ROUTER_URL } from './types.js';
// Only repatriate from these brokers; coinbase-live is already local-paper
const REPATRIABLE_BROKERS = new Set(['alpaca-paper', 'oanda-rest']);
/** Normalize a raw position record to BrokerPosition format */
function normalizeRawPosition(broker, rawPos) {
    // Handle OANDA position format: { instrument, long: { units, averagePrice, unrealizedPL }, short: { units, ... } }
    // OANDA returns numeric fields as strings, so parse with Number().
    if (rawPos.long || rawPos.short) {
        const numField = (obj, key) => {
            const v = obj?.[key];
            if (typeof v === 'number')
                return Number.isFinite(v) ? v : 0;
            if (typeof v === 'string') {
                const n = Number(v);
                return Number.isFinite(n) ? n : 0;
            }
            return 0;
        };
        const longUnits = numField(rawPos.long, 'units');
        const shortUnits = numField(rawPos.short, 'units');
        const netUnits = longUnits + shortUnits;
        if (netUnits === 0)
            return null;
        const direction = netUnits > 0 ? 'long' : 'short';
        const sideData = direction === 'long' ? rawPos.long : rawPos.short;
        const avgEntry = numField(sideData, 'averagePrice');
        return {
            id: rawPos.id ?? `oanda:${rawPos.instrument}`,
            broker,
            symbol: rawPos.instrument ?? '',
            quantity: Math.abs(netUnits),
            avgEntry,
            markPrice: avgEntry,
            unrealizedPnl: numField(sideData, 'unrealizedPL'),
            unrealizedPnlPct: 0
        };
    }
    // Handle normalized position format with broker/symbol/quantity fields
    const symbol = rawPos.symbol ?? '';
    const quantity = Math.abs((rawPos.quantity ?? rawPos.qty ?? 0));
    if (!symbol || quantity <= 0)
        return null;
    return {
        id: rawPos.id ?? `${broker}:${symbol}`,
        broker: rawPos.broker ?? broker,
        symbol,
        quantity,
        avgEntry: (rawPos.avgEntry ?? rawPos.avg_entry_price ?? 0),
        markPrice: (rawPos.markPrice ?? rawPos.mark_price ?? rawPos.current_price ?? 0),
        unrealizedPnl: (rawPos.unrealizedPnl ?? rawPos.unrealized_pl ?? 0),
        unrealizedPnlPct: (rawPos.unrealizedPnlPct ?? 0)
    };
}
/** Fetch all broker positions from broker-router. Returns broker snapshots with positions. */
async function fetchBrokerPositions() {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8_000);
        const response = await fetch(`${BROKER_ROUTER_URL}/positions`, { signal: controller.signal });
        clearTimeout(timeout);
        if (!response.ok)
            return [];
        const payload = await response.json();
        if (Array.isArray(payload.brokers)) {
            // broker-router format: { brokers: [{ broker, positions: [...] }] }
            const snapshots = [];
            for (const b of payload.brokers) {
                const broker = b.broker ?? 'unknown';
                const positions = [];
                for (const rawPos of (b.positions ?? [])) {
                    const normalized = normalizeRawPosition(broker, rawPos);
                    if (normalized)
                        positions.push(normalized);
                }
                snapshots.push({ broker, positions });
            }
            return snapshots;
        }
        if (Array.isArray(payload.positions)) {
            // Fallback: flat positions array
            const byBroker = new Map();
            for (const rawPos of payload.positions) {
                const record = rawPos;
                const broker = record.broker ?? 'unknown';
                const normalized = normalizeRawPosition(broker, record);
                if (normalized) {
                    if (!byBroker.has(broker))
                        byBroker.set(broker, []);
                    byBroker.get(broker).push(normalized);
                }
            }
            return Array.from(byBroker.entries()).map(([broker, positions]) => ({ broker, positions }));
        }
        return [];
    }
    catch {
        return [];
    }
}
/**
 * Finds the agent matching a broker position by broker + symbol.
 * Returns null if no agent is configured for that broker/symbol pair.
 */
function findMatchingAgent(engine, broker, symbol) {
    return Array.from(engine.agents.values()).find((a) => a.config.broker === broker && a.config.symbol === symbol) ?? null;
}
/**
 * Checks if an agent's existing position matches the broker position (same notional + symbol).
 * If brokerPositionId is available, compares that; otherwise matches on quantity + entryPrice.
 */
function isAlreadyTracked(agent, brokerPosition) {
    const pos = agent.position;
    if (!pos)
        return false;
    // Prefer brokerPositionId match if available
    if (brokerPosition.id && pos.brokerPositionId === brokerPosition.id) {
        return true;
    }
    // Fallback: match on direction + quantity (rounded to avoid float noise)
    const brokerQty = Math.abs(brokerPosition.quantity);
    const agentQty = Math.round(pos.quantity * 1e6) / 1e6;
    const brokerDir = brokerPosition.quantity > 0 ? 'long' : 'short';
    if (brokerDir === pos.direction && agentQty === Math.round(brokerQty * 1e6) / 1e6) {
        return true;
    }
    return false;
}
/**
 * Adopts orphaned broker-side open positions into the paper-engine agent state.
 *
 * Should be called after `seedAgentCountersFromJournal` (so agent state is hydrated)
 * and before the engine begins normal tick processing.
 */
export async function repatriateOrphanedBrokerPositions(engine) {
    const report = {
        adopted: 0,
        skipped: 0,
        orphaned: 0,
        details: []
    };
    const brokerSnapshots = await fetchBrokerPositions();
    if (brokerSnapshots.length === 0) {
        return report;
    }
    for (const snapshot of brokerSnapshots) {
        // Skip non-repatriable brokers (coinbase-live is already local-paper)
        if (!REPATRIABLE_BROKERS.has(snapshot.broker)) {
            continue;
        }
        for (const brokerPos of snapshot.positions) {
            const symbol = brokerPos.symbol;
            const quantity = Math.abs(brokerPos.quantity);
            if (quantity <= 0) {
                report.orphaned++;
                report.details.push({
                    symbol,
                    broker: snapshot.broker,
                    quantity: 0,
                    direction: brokerPos.quantity > 0 ? 'long' : 'short',
                    entryPrice: brokerPos.avgEntry,
                    reason: 'no-matching-agent'
                });
                continue;
            }
            // Step 1: Find matching agent
            const agent = findMatchingAgent(engine, snapshot.broker, symbol);
            if (!agent) {
                report.skipped++;
                report.details.push({
                    symbol,
                    broker: snapshot.broker,
                    quantity,
                    direction: brokerPos.quantity > 0 ? 'long' : 'short',
                    entryPrice: brokerPos.avgEntry,
                    reason: 'no-matching-agent'
                });
                continue;
            }
            // Step 2: Check if already tracked
            if (isAlreadyTracked(agent, brokerPos)) {
                report.skipped++;
                report.details.push({
                    symbol,
                    broker: snapshot.broker,
                    quantity,
                    direction: brokerPos.quantity > 0 ? 'long' : 'short',
                    entryPrice: brokerPos.avgEntry,
                    reason: 'already-tracked'
                });
                continue;
            }
            // Step 3: Adopt the position
            const direction = brokerPos.quantity > 0 ? 'long' : 'short';
            const entryPrice = brokerPos.avgEntry;
            const now = new Date().toISOString();
            const symbolState = engine.market.get(symbol);
            // Set entry tick to current tick (approximate since we don't know true entry time)
            const entryTick = engine.tick;
            const adoptedPosition = {
                direction,
                quantity,
                entryPrice,
                entryTick,
                entryAt: now,
                stopPrice: engine.computeDynamicStop(entryPrice, agent, symbolState, direction),
                targetPrice: engine.computeDynamicTarget(entryPrice, agent, symbolState, direction),
                peakPrice: brokerPos.markPrice || entryPrice,
                note: 'Repatriated from broker after session reboot.',
                brokerPositionId: brokerPos.id ?? null,
                adopted: true
            };
            // Deduct cost basis from agent cash (no fees since position was already open)
            const costBasis = entryPrice * quantity;
            agent.cash = Math.max(0, agent.cash - costBasis);
            agent.position = adoptedPosition;
            agent.status = 'in-trade';
            agent.lastSymbol = symbol;
            agent.lastAction = `Repatriated orphaned ${direction} position in ${symbol} (qty=${quantity}, entry=$${entryPrice.toFixed(4)}) from ${snapshot.broker}.`;
            report.adopted++;
            report.details.push({
                symbol,
                broker: snapshot.broker,
                quantity,
                direction,
                entryPrice,
                reason: 'adopted'
            });
        }
    }
    console.log(`[repatriation] adopted=${report.adopted} skipped=${report.skipped} orphaned=${report.orphaned}`);
    if (report.adopted > 0) {
        engine.persistStateSnapshot();
    }
    return report;
}
