// @ts-nocheck

/**
 * Engine Broker Sub-Module
 *
 * Extracted broker-paper methods from PaperEngine.
 * Each function receives the engine instance as the first parameter.
 */

import { normalizeArray, round, readJsonLines } from '../paper-engine-utils.js';
import {
  PAPER_BROKER,
  BROKER_ROUTER_URL,
  FILL_LEDGER_PATH,
  BROKER_SYNC_MS,
  TICK_MS,
} from './types.js';

// Re-export execution functions so paper-engine.ts imports don't break
export {
  routeBrokerOrder,
  openBrokerPaperPosition,
  closeBrokerPaperPosition,
  applyBrokerFilledEntry,
  applyBrokerFilledExit,
  fetchBrokerAccount,
  finalizeBrokerFlat,
  handleAsyncOrderStatus,
  recentlyExpiredOrderIds,
  recordExpiredOrder
} from './engine-broker-execution.js';

import { fetchBrokerAccount } from './engine-broker-execution.js';

export async function seedFromBrokerHistory(engine: any): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(`${BROKER_ROUTER_URL}/account`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return;

    const payload = await response.json();
    const brokers = Array.isArray(payload.brokers) ? payload.brokers : [];

    for (const broker of brokers) {
      // === ALPACA: match buy/sell order pairs to count round-trip trades ===
      if (broker.broker === 'alpaca-paper') {
        // Skip if Alpaca agents already have trades (already seeded or trading)
        const alpacaAgents = Array.from(engine.agents.values()).filter((a: any) => a.config.broker === 'alpaca-paper');
        const alpacaTrades = alpacaAgents.reduce((s: number, a: any) => s + a.trades, 0);
        if (alpacaTrades > 0) continue;

        const orders = Array.isArray(broker.orders) ? broker.orders as Record<string, unknown>[] : [];
        const fills = orders.filter((o: any) =>
          o.status === 'filled' && typeof o.filled_avg_price === 'string'
        );
        const openBuys = new Map<string, { price: number; qty: number }>();
        for (const order of fills) {
          const sym = String(order.symbol ?? '').replace('/', '-');
          const price = parseFloat(String(order.filled_avg_price ?? '0'));
          const qty = parseFloat(String(order.filled_qty ?? '0'));
          const agent = alpacaAgents.find((a: any) => a.config.symbol === sym);
          if (!agent) continue;

          if (order.side === 'buy') {
            openBuys.set(sym, { price, qty });
          } else if (order.side === 'sell' && openBuys.has(sym)) {
            const buy = openBuys.get(sym)!;
            const pnl = (price - buy.price) * Math.min(qty, buy.qty);
            agent.trades += 1;
            agent.realizedPnl = round(agent.realizedPnl + pnl, 4);
            if (pnl >= 0) agent.wins += 1;
            else agent.losses += 1;
            openBuys.delete(sym);
          }
        }
      }

      // === OANDA: use account-level PL since fills only show open trades ===
      if (broker.broker === 'oanda-rest') {
        const oandaAgents = Array.from(engine.agents.values()).filter((a: any) => a.config.broker === 'oanda-rest');
        const oandaTrades = oandaAgents.reduce((s: number, a: any) => s + a.trades, 0);
        if (oandaTrades > 0) continue;

        const acct = broker.account as Record<string, unknown> ?? {};
        const oandaPl = parseFloat(String(acct.pl ?? '0'));
        const oandaFills = Array.isArray(broker.fills) ? broker.fills as Record<string, unknown>[] : [];
        // Count unique instruments that have been traded (open trades = evidence of activity)
        const tradedInstruments = new Set(oandaFills.map((f: any) => String((f as Record<string, unknown>).instrument ?? '')).filter(Boolean));

        if (oandaPl !== 0 && tradedInstruments.size > 0) {
          // Distribute realized PL proportionally across traded instruments
          const perInstrument = oandaPl / tradedInstruments.size;
          for (const instrument of tradedInstruments) {
            const agent = oandaAgents.find((a: any) => a.config.symbol === instrument);
            if (!agent) continue;
            // Count how many fills this instrument has as a proxy for trade count
            const instrumentFills = oandaFills.filter((f: any) => (f as Record<string, unknown>).instrument === instrument);
            agent.trades = instrumentFills.length;
            agent.realizedPnl = round(perInstrument, 4);
            if (perInstrument >= 0) agent.wins = Math.max(1, Math.round(instrumentFills.length * 0.6));
            else agent.losses = instrumentFills.length;
          }
        }
      }
    }

    // === COINBASE PAPER: seed from local fills ledger (simulated trades) ===
    const cbAgents = Array.from(engine.agents.values()).filter((a: any) => a.config.broker === 'coinbase-live');
    const cbTrades = cbAgents.reduce((s: number, a: any) => s + a.trades, 0);
    if (cbTrades === 0) {
      try {
        const fillLines = readJsonLines(FILL_LEDGER_PATH);
        const cbFills = fillLines.filter((f: any) => f.source === 'simulated' && f.status === 'filled' && cbAgents.some((a: any) => a.config.id === f.agentId));
        for (const fill of cbFills) {
          const agent = cbAgents.find((a: any) => a.config.id === fill.agentId);
          if (!agent) continue;
          if (fill.side === 'sell' || (fill.side === 'buy' && fill.pnlImpact !== 0)) {
            // Exit fill
            if (fill.pnlImpact !== 0) {
              agent.trades += 1;
              agent.realizedPnl = round(agent.realizedPnl + fill.pnlImpact, 4);
              if (fill.pnlImpact > 0) agent.wins += 1;
              else agent.losses += 1;
            }
          }
        }
      } catch {
        // fills.jsonl may not exist yet
      }
    }

    const totalSeeded = Array.from(engine.agents.values()).reduce((s: number, a: any) => s + a.trades, 0);
    const totalPnl = Array.from(engine.agents.values()).reduce((s: number, a: any) => s + a.realizedPnl, 0);
    if (totalSeeded > 0) {
      console.log(`[paper-engine] seeded ${totalSeeded} trades from broker history (PnL: $${totalPnl.toFixed(2)})`);
      engine.persistStateSnapshot();
    }
  } catch (error) {
    console.error('[paper-engine] failed to seed from broker history:', error instanceof Error ? error.message : error);
  }
}

export async function reconcileBrokerPaperState(engine: any, force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - engine.lastBrokerSyncAtMs < BROKER_SYNC_MS) {
    return;
  }
  engine.lastBrokerSyncAtMs = now;

  const snapshot = await fetchBrokerAccount(engine, PAPER_BROKER);
  if (!snapshot) {
    return;
  }
  engine.brokerPaperAccount = engine.toBrokerPaperAccountState(snapshot);

  // Cache broker position quantities so sells use exact broker amounts (no dust)
  const posCache = new Map<string, number>();
  for (const pos of snapshot.positions) {
    const qty = typeof pos.quantity === 'number' ? pos.quantity : parseFloat(String(pos.quantity ?? '0'));
    if (qty > 0) posCache.set(pos.symbol, qty);
  }
  engine._brokerPositionCache = posCache;

  // Also sync OANDA practice + Coinbase accounts for truthful firm-level paper metrics
  try {
    const [oandaSnap, coinbaseSnap] = await Promise.all([
      fetchBrokerAccount(engine, 'oanda-rest'),
      fetchBrokerAccount(engine, 'coinbase-live')
    ]);
    if (oandaSnap) {
      engine.brokerOandaAccount = engine.toBrokerPaperAccountState(oandaSnap);
    }
    if (coinbaseSnap) {
      engine.brokerCoinbaseAccount = engine.toBrokerPaperAccountState(coinbaseSnap);
    }
  } catch {
    // Secondary broker sync is best-effort
  }

  const positions = new Map(snapshot.positions.map((position: any) => [position.symbol, position]));
  const brokerOrders = normalizeArray(snapshot.orders);

  for (const agent of engine.agents.values()) {
    if (agent.config.executionMode !== 'broker-paper') {
      continue;
    }

    agent.lastBrokerSyncAt = snapshot.asOf;
    const symbol = engine.market.get(agent.config.symbol);
    if (!symbol) {
      continue;
    }

    // Adopted positions (from broker-repatriation) must fully bypass reconcile. OANDA
    // returns positions in raw long/short format that normalizeBrokerPositions currently
    // drops, so broker-side state is invisible to hermes. Without this guard, reconcile
    // phantom-closes the adopted position, repatriation re-adopts it next tick, and the
    // journal fills with fake '[adopted] broker reconciliation' wins. Agents genuinely
    // closing adopted positions should go through the scalper's own exit path, not this.
    if (agent.position?.adopted) {
      continue;
    }

    const brokerPosition = positions.get(agent.config.symbol);
    const ownsBrokerPosition = engine.hasHermesBrokerPosition(agent, brokerOrders);
    if (brokerPosition && ownsBrokerPosition) {
      // FIX: preserve actual open time from normalized position so hold-tick tracking
      // is not reset on every reconcile tick (which caused OANDA positions to hold
      // overnight and bleed $37+ in financing on GBP_USD shorts).
      const openedAt = brokerPosition.openedAt ?? snapshot.asOf;
      engine.syncBrokerPositionIntoAgent(agent, symbol, brokerPosition, openedAt);
      continue;
    }

    if (brokerPosition && !ownsBrokerPosition) {
      // Clear agent.position alongside pendingOrderId so the agent doesn't stay
      // "in-trade" forever on a position Hermes doesn't own. Without this the agent
      // is stuck and can never re-enter a real Hermes-originated trade.
      agent.status = 'watching';
      agent.position = null;
      agent.pendingOrderId = null;
      agent.pendingSide = null;
      agent.lastAction = `Ignoring external ${symbol.symbol} broker position because it was not opened by Hermes.`;
      engine.pushPoint(agent.curve, engine.getAgentEquity(agent));
      continue;
    }

    if (agent.pendingOrderId && agent.pendingSide === 'sell' && agent.position) {
      engine.finalizeBrokerFlat(agent, symbol, 'broker reconciliation');
      continue;
    }

    // Only auto-flatten if no close is in flight (pendingSide === 'sell' means scalper is closing)
    // and hold time significantly exceeds the scalper's own maxHoldTicks threshold.
    // The +5 buffer gives the scalper's manageOpenPosition loop time to fire closeBrokerPaperPosition
    // before reconciliation forcibly closes at market.
    //
    // Guard: adopted positions (from broker-repatriation) must NOT be phantom-flattened when
    // brokerPosition appears "missing". OANDA returns positions in raw long/short format that
    // normalizeBrokerPositions currently drops, so the adopted OANDA EUR/USD + USD/JPY positions
    // show as undefined brokerPosition on every reconcile tick. Without this guard, reconcile
    // phantom-closes + repatriation re-adopts every tick → fake journal entries spiral.
    if (agent.position?.adopted) {
      continue;
    }
    if (!agent.pendingOrderId && agent.position && (engine.tick - agent.position.entryTick) > agent.config.maxHoldTicks + 5) {
      engine.finalizeBrokerFlat(agent, symbol, 'external broker flatten');
    }
    // BLK-F fix (2026-04-17): orphaned pendingOrderId with no position.
    // This happens when a sell order was submitted (pendingOrderId set) but the
    // position was already closed or the order was rejected/fill-lost. Without this,
    // the agent stays stuck on "Waiting for sell order...to settle" forever.
    if (agent.pendingOrderId && !agent.position) {
      console.log(`[engine-broker] Clearing orphaned pendingOrderId=${agent.pendingOrderId} for ${agent.config.id} — no open position found.`);
      agent.pendingOrderId = null;
      agent.pendingSide = null;
      agent.pendingEntryMeta = undefined;
      agent.status = 'watching';
      agent.lastAction = `Orphaned pendingOrderId cleared on reconcile. Awaiting next setup.`;
    }
    // BLK-Fb fix (2026-04-17): pending sell order but no broker position.
    // After a mass-external-close (e.g. manual OANDA cleanup), the broker has no
    // EUR/USD or USD/JPY position, so ownsBrokerPosition=false. The agent still
    // has agent.position set (it was opened before the external close). The
    // pending sell order will never fill. Finalize the phantom position now.
    if (agent.pendingOrderId && agent.pendingSide === 'sell' && !brokerPosition && agent.position && !agent.position.adopted) {
      console.log(`[engine-broker] Finalizing orphaned sell — no broker position for ${agent.config.id}.`);
      engine.finalizeBrokerFlat(agent, symbol, 'orphaned sell, broker position gone');
    }
  }
}

// FOREX sessions (NY close = 5PM ET, ~22:00 UTC; Fri close ~21:00 UTC).
// Flatten OANDA positions before session end to avoid overnight/weekend financing bleed.
// The $37.83 GBP_USD overnight financing charge was caused by positions held past NY close.
const NY_CLOSE_UTC_HOUR = 22; // 5PM ET = 22:00 UTC (winter)
const NY_CLOSE_UTC_HOUR_SUMMER = 21; // 5PM ET = 21:00 UTC (summer)
const OANDA_FLATTEN_BEFORE_MINUTES = 35; // flatten 35min before close

function isNearSessionEndUtc(): boolean {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcMin = now.getUTCMinutes();
  const utcDay = now.getUTCDay(); // 0=Sun, 5=Fri, 6=Sat
  const isFriday = utcDay === 5;
  const isWeekend = utcDay === 0 || utcDay === 6;
  const isNearClose = utcMin >= 60 - OANDA_FLATTEN_BEFORE_MINUTES; // last 35 min of any hour

  // Weekend: flatten if it's Friday after ~18:00 UTC or anytime Sat/Sun
  if (isWeekend) return true;
  if (isFriday && utcHour >= 18) return true;

  // Weekdays: flatten 35min before NY close (21:00 or 22:00 UTC)
  const nyCloseHour = utcHour >= 21 && now.getUTCMonth() >= 3 && now.getUTCMonth() <= 9
    ? NY_CLOSE_UTC_HOUR_SUMMER : NY_CLOSE_UTC_HOUR;
  if (utcHour === nyCloseHour - 1 && utcMin >= 60 - OANDA_FLATTEN_BEFORE_MINUTES) return true;

  return false;
}

export function flattenOandaBeforeSessionEnd(engine: any): void {
  if (!isNearSessionEndUtc()) return;

  for (const agent of engine.agents.values()) {
    if (agent.config.broker !== 'oanda-rest') continue;
    if (!agent.position) continue;
    if (agent.pendingOrderId) continue; // already closing

    const symbol = engine.market.get(agent.config.symbol);
    if (!symbol) continue;

    console.log(`[oanda-session] flattening ${agent.config.name} (${agent.config.symbol}) before session close — pnl=${agent.position?.quantity}`);
    engine.closePosition(agent, symbol, 'session-end flatten (avoid overnight financing)');
  }
}

export function syncBrokerPositionIntoAgent(
  engine: any,
  agent: any,
  symbol: any,
  brokerPosition: any,
  openedAt?: string
): void {
  const quantity = round(brokerPosition.quantity, 6);
  const entryPrice = round(brokerPosition.avgEntry || symbol.price, 2);
  const direction = agent.position?.direction
    ?? (agent.pendingSide === 'sell' ? 'short' : 'long');

  if (!agent.position) {
    const note = `Restored broker-backed ${engine.formatBrokerLabel(agent.config.broker)} position from ${agent.config.symbol} sync.`;
    agent.cash = round(Math.max(0, agent.cash - entryPrice * quantity), 2);
    // FIX: use actual openedAt (from broker fill timestamp) instead of engine.tick.
    // Previously, entryTick=engine.tick reset hold tracking every reconcile tick,
    // causing positions to appear "new" and avoid maxHoldTicks expiry. This allowed
    // GBP_USD shorts to hold overnight, accumulating $37.83 in financing charges.
    // Clamp to 0 on restart: if engine.tick reset but broker position persisted,
    // we can get negative entryTick which would inflate hold time (safe direction
    // but confusing for diagnostics).
    const entryMs = openedAt ? new Date(openedAt).getTime() : Date.now();
    const elapsedMs = Date.now() - entryMs;
    const elapsedTicks = Math.max(0, Math.floor(elapsedMs / TICK_MS));
    const entryTick = Math.max(0, engine.tick - elapsedTicks);
    agent.position = {
      direction,
      quantity,
      entryPrice,
      entryTick,
      entryAt: openedAt ?? new Date().toISOString(),
      stopPrice: engine.computeDynamicStop(entryPrice, agent, symbol, direction),
      targetPrice: engine.computeDynamicTarget(entryPrice, agent, symbol, direction),
      peakPrice: brokerPosition.markPrice || entryPrice,
      note,
      entryMeta: agent.pendingEntryMeta ?? undefined
    };
    agent.status = 'in-trade';
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = agent.pendingOrderId && agent.pendingSide === 'buy'
      ? `Broker confirmed Alpaca paper entry in ${symbol.symbol} at ${entryPrice}.`
      : note;
  } else {
    const liveDirection = engine.getPositionDirection(agent.position);
    agent.position.direction = liveDirection;
    agent.position.quantity = quantity;
    agent.position.entryPrice = entryPrice;
    agent.position.entryAt = agent.position.entryAt ?? new Date().toISOString();
    agent.position.stopPrice = engine.computeDynamicStop(entryPrice, agent, symbol, liveDirection);
    agent.position.targetPrice = engine.computeDynamicTarget(entryPrice, agent, symbol, liveDirection);
    const mark = brokerPosition.markPrice || symbol.price;
    agent.position.peakPrice = liveDirection === 'short'
      ? Math.min(agent.position.peakPrice, mark)
      : Math.max(agent.position.peakPrice, mark);
    agent.position.entryMeta = agent.position.entryMeta ?? agent.pendingEntryMeta ?? undefined;
    agent.status = 'in-trade';
  }

  agent.pendingOrderId = null;
  agent.pendingSide = null;
  agent.pendingEntryMeta = undefined;
}
