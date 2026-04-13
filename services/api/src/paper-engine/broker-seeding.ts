/**
 * Broker History Seeding
 *
 * Seeds agent trade stats from broker history on startup.
 * Handles Alpaca (order pair matching), OANDA (account-level PL),
 * and Coinbase paper (local fills ledger).
 */

import type { AgentState, BrokerAccountResponse } from './types.js';
import { BROKER_ROUTER_URL, FILL_LEDGER_PATH } from './types.js';
import { round } from '../paper-engine-utils.js';
import { readJsonLines } from '../paper-engine-utils.js';

interface FillRecord {
  agentId: string;
  side: string;
  pnlImpact: number;
  status: string;
  source: string;
}

export async function seedFromBrokerHistory(
  agents: Map<string, AgentState>,
  brokerRouterUrl: string,
  fillLedgerPath: string,
  persistFn: () => void
): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const response = await fetch(`${brokerRouterUrl}/account`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) return;

    const payload = await response.json() as BrokerAccountResponse;
    const brokers = Array.isArray(payload.brokers) ? payload.brokers : [];

    for (const broker of brokers) {
      // === ALPACA: match buy/sell order pairs to count round-trip trades ===
      if (broker.broker === 'alpaca-paper') {
        const alpacaAgents = Array.from(agents.values()).filter((a) => a.config.broker === 'alpaca-paper');
        const alpacaTrades = alpacaAgents.reduce((s, a) => s + a.trades, 0);
        if (alpacaTrades > 0) continue;

        const orders = Array.isArray(broker.orders) ? broker.orders as Record<string, unknown>[] : [];
        const fills = orders.filter((o) =>
          o.status === 'filled' && typeof o.filled_avg_price === 'string'
        );
        const openBuys = new Map<string, { price: number; qty: number }>();
        for (const order of fills) {
          const sym = String(order.symbol ?? '').replace('/', '-');
          const price = parseFloat(String(order.filled_avg_price ?? '0'));
          const qty = parseFloat(String(order.filled_qty ?? '0'));
          const agent = alpacaAgents.find((a) => a.config.symbol === sym);
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
        const oandaAgents = Array.from(agents.values()).filter((a) => a.config.broker === 'oanda-rest');
        const oandaTrades = oandaAgents.reduce((s, a) => s + a.trades, 0);
        if (oandaTrades > 0) continue;

        const acct = broker.account as Record<string, unknown> ?? {};
        const oandaPl = parseFloat(String(acct.pl ?? '0'));
        const oandaFills = Array.isArray(broker.fills) ? broker.fills as Record<string, unknown>[] : [];
        const tradedInstruments = new Set(oandaFills.map((f) => String((f as Record<string, unknown>).instrument ?? '')).filter(Boolean));

        if (oandaPl !== 0 && tradedInstruments.size > 0) {
          const perInstrument = oandaPl / tradedInstruments.size;
          for (const instrument of tradedInstruments) {
            const agent = oandaAgents.find((a) => a.config.symbol === instrument);
            if (!agent) continue;
            const instrumentFills = oandaFills.filter((f) => (f as Record<string, unknown>).instrument === instrument);
            agent.trades = instrumentFills.length;
            agent.realizedPnl = round(perInstrument, 4);
            if (perInstrument >= 0) agent.wins = Math.max(1, Math.round(instrumentFills.length * 0.6));
            else agent.losses = instrumentFills.length;
          }
        }
      }
    }

    // === COINBASE PAPER: seed from local fills ledger (simulated trades) ===
    const cbAgents = Array.from(agents.values()).filter((a) => a.config.broker === 'coinbase-live');
    const cbTrades = cbAgents.reduce((s, a) => s + a.trades, 0);
    if (cbTrades === 0) {
      try {
        const fillLines = readJsonLines<FillRecord>(fillLedgerPath);
        const cbFills = fillLines.filter((f) => f.source === 'simulated' && f.status === 'filled' && cbAgents.some((a) => a.config.id === f.agentId));
        for (const fill of cbFills) {
          const agent = cbAgents.find((a) => a.config.id === fill.agentId);
          if (!agent) continue;
          if (fill.side === 'sell' || (fill.side === 'buy' && fill.pnlImpact !== 0)) {
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

    const totalSeeded = Array.from(agents.values()).reduce((s, a) => s + a.trades, 0);
    const totalPnl = Array.from(agents.values()).reduce((s, a) => s + a.realizedPnl, 0);
    if (totalSeeded > 0) {
      console.log(`[paper-engine] seeded ${totalSeeded} trades from broker history (PnL: $${totalPnl.toFixed(2)})`);
      persistFn();
    }
  } catch (error) {
    console.error('[paper-engine] failed to seed from broker history:', error instanceof Error ? error.message : error);
  }
}
