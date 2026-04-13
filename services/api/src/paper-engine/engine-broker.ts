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
} from './types.js';

// Re-export execution functions so paper-engine.ts imports don't break
export {
  routeBrokerOrder,
  openBrokerPaperPosition,
  closeBrokerPaperPosition,
  applyBrokerFilledEntry,
  applyBrokerFilledExit,
  fetchBrokerAccount,
  finalizeBrokerFlat
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

    const brokerPosition = positions.get(agent.config.symbol);
    const ownsBrokerPosition = engine.hasHermesBrokerPosition(agent, brokerOrders);
    if (brokerPosition && ownsBrokerPosition) {
      engine.syncBrokerPositionIntoAgent(agent, symbol, brokerPosition);
      continue;
    }

    if (brokerPosition && !ownsBrokerPosition) {
      agent.status = 'watching';
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

    if (!agent.pendingOrderId && agent.position && (engine.tick - agent.position.entryTick) > 20) {
      engine.finalizeBrokerFlat(agent, symbol, 'external broker flatten');
    }
  }
}

export function syncBrokerPositionIntoAgent(
  engine: any,
  agent: any,
  symbol: any,
  brokerPosition: any
): void {
  const quantity = round(brokerPosition.quantity, 6);
  const entryPrice = round(brokerPosition.avgEntry || symbol.price, 2);
  const direction = agent.position?.direction
    ?? (agent.pendingSide === 'sell' ? 'short' : 'long');

  if (!agent.position) {
    const note = `Restored broker-backed ${engine.formatBrokerLabel(agent.config.broker)} position from ${agent.config.symbol} sync.`;
    agent.cash = round(Math.max(0, agent.startingEquity + agent.realizedPnl - entryPrice * quantity), 2);
    agent.position = {
      direction,
      quantity,
      entryPrice,
      entryTick: engine.tick,
      entryAt: new Date().toISOString(),
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
