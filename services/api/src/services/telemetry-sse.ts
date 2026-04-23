import type { Response } from 'express';
import {
  BROKER_ROUTER_URL,
  BROKER_STARTING_EQUITY
} from '../lib/constants.js';
import { fetchJson, getServiceHealthSnapshot } from '../lib/utils-http.js';
import {
  normalizeBrokerAccounts,
  normalizeBrokerPositions,
  dedupePositions
} from '../lib/utils-normalization.js';
import { round } from '../lib/utils-generic.js';
import { buildTerminalSnapshot, type TerminalSnapshotDeps } from '../lib/terminal-builder.js';
import type { BrokerRouterAccountResponse } from '../lib/types-broker.js';
import type { LaneRollup } from '@hermes/contracts';
import { computeLaneRollups } from '../paper-engine/engine-views.js';

export interface TelemetryDeps extends TerminalSnapshotDeps {}

export class TelemetrySSEService {
  private sharedBrokerCache: BrokerRouterAccountResponse | null = null;
  private sharedHealthCache: any[] = [];
  private terminalCache: any = null;
  private subscribers = new Set<Response>();

  constructor(private deps: TelemetryDeps) {
    this.startFastLoop();
    this.startSlowLoop();
  }

  public addSubscriber(res: Response) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    this.subscribers.add(res);
    res.on('close', () => this.subscribers.delete(res));
    this.emitTo(res);
  }

  /** Fast loop: local data only — runs every 1s, no async IO */
  private startFastLoop() {
    setInterval(() => {
      this.broadcast();
    }, 1_000);
  }

  /** Slow loop: external service fetches — runs every 5s in background */
  private startSlowLoop() {
    const tick = async () => {
      try {
        const [brokerState, health] = await Promise.all([
          fetchJson<BrokerRouterAccountResponse>(BROKER_ROUTER_URL, '/account'),
          getServiceHealthSnapshot()
        ]);
        if (brokerState) this.sharedBrokerCache = brokerState;
        this.sharedHealthCache = health;

        const brokerAccounts = normalizeBrokerAccounts(brokerState?.brokers ?? []);
        this.terminalCache = await buildTerminalSnapshot(this.deps, {
          brokerReports: brokerState,
          accounts: brokerAccounts
        });
      } catch { /* best effort */ }
    };
    void tick();
    setInterval(() => void tick(), 10_000);
  }

  private broadcast() {
    for (const res of this.subscribers) {
      this.emitTo(res);
    }
  }

  private emitTo(res: Response) {
    try {
      const brokerAccounts = normalizeBrokerAccounts(this.sharedBrokerCache?.brokers ?? []);
      const brokerPositions = normalizeBrokerPositions(this.sharedBrokerCache?.brokers ?? []);
      const fullDesk = this.deps.paperEngine.getSnapshot();

      // FIX #6: Restore lanes + brokerRollups (already in fullDesk, keep via spread)
      // FIX #3: Compute firm-wide winRate across ALL journal entries via computeLaneRollups
      const journalRows = (this.deps.paperEngine as any)._journalCache?.rows ?? [];
      const firmLaneRollups: LaneRollup[] = computeLaneRollups(journalRows);
      const firmTotalTrades = firmLaneRollups.reduce((s, l) => s + l.trades, 0);
      const firmWins = firmLaneRollups.reduce((s, l) => s + l.wins, 0);
      const firmWinRate = firmTotalTrades > 0 ? (firmWins / firmTotalTrades) * 100 : 0;

      // Slim SSE: strip per-agent curves and heavy history, keep structure intact
      const paperDesk = {
        ...fullDesk,
        agents: fullDesk.agents.map((a: any) => {
          const { curve, recentOutcomes, recentHoldTicks, ...rest } = a;
          return rest;
        }),
        fills: fullDesk.fills.slice(0, 200),
        deskCurve: fullDesk.deskCurve.slice(-20),
        benchmarkCurve: fullDesk.benchmarkCurve.slice(-20),
        marketFocus: [],
        // FIX #3: Attach firm-wide aggregates
        firmWinRate: Math.round(firmWinRate * 10) / 10,
        firmTotalTrades,
        // FIX #6: Explicitly include lanes + brokerRollups (already in fullDesk, made explicit)
        lanes: fullDesk.lanes ?? firmLaneRollups,
        brokerRollups: fullDesk.brokerRollups ?? [],
      };

      let realOpenRisk = brokerPositions.reduce((sum, pos) => sum + (pos.unrealizedPnl ?? 0), 0);
      const cbPaperAgents = paperDesk.agents.filter((a: any) => a.broker === 'coinbase-live');
      const cbPaperPnl = cbPaperAgents.reduce((s: number, a: any) => s + a.realizedPnl, 0);
      const cbPaperEquity = BROKER_STARTING_EQUITY + cbPaperPnl;

      const paperOnlyEquity = brokerAccounts
        .filter((a) => a.broker !== 'coinbase-live')
        .reduce((sum, a) => sum + a.equity, 0) + cbPaperEquity;

      const PAPER_STARTING = BROKER_STARTING_EQUITY * 3;

      if (paperOnlyEquity > 0) {
        paperDesk.totalEquity = round(paperOnlyEquity, 2);
        paperDesk.startingEquity = PAPER_STARTING;
        paperDesk.totalDayPnl = round(paperOnlyEquity - PAPER_STARTING, 2);
        paperDesk.realizedPnl = round(cbPaperPnl, 2);
      }

      if (paperDesk.analytics) {
        paperDesk.analytics.totalOpenRisk = round(realOpenRisk, 2);
      }

      const intelSnapshot = this.deps.marketIntel.getSnapshot();
      // Overlay fresh brokerAccounts on top of the cached terminal snapshot so the SSE
      // venue matrix always sees live broker P&L / unrealized / realized. Without this,
      // terminalCache (built every 5 s by the slow loop) freezes brokerAccounts until
      // the next slow-loop tick, which shows up as "venue matrix not connected to api".
      const overviewPayload = this.terminalCache
        ? { ...this.terminalCache, brokerAccounts }
        : { asOf: new Date().toISOString(), terminals: [], brokerAccounts, serviceHealth: this.sharedHealthCache };
      const payload = {
        overview: overviewPayload,
        positions: dedupePositions([...brokerPositions, ...this.deps.paperEngine.getPositions()]),
        paperDesk,
        marketIntel: {
          fearGreed: intelSnapshot.fearGreed,
          compositeSignals: intelSnapshot.compositeSignal.map((sig: any) => {
            const tape = (paperDesk.marketTape ?? []).find((t: any) => t.symbol === sig.symbol);
            return {
              ...sig,
              tradable: tape ? tape.tradable : sig.tradeable,
              tapeStatus: tape?.status ?? 'unknown',
              session: tape?.session ?? 'unknown'
            };
          })
        }
      };

      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // subscriber might have closed
    }
  }
}
