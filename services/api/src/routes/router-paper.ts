import { Router } from 'express';
import type { MarketSnapshot } from '@hermes/contracts';
import {
  BROKER_ROUTER_URL,
  BROKER_STARTING_EQUITY,
  MARKET_DATA_URL
} from '../lib/constants.js';
import { fetchJson } from '../lib/utils-http.js';
import { round } from '../lib/utils-generic.js';
import {
  normalizeBrokerAccounts,
  normalizeBrokerPositions,
  dedupeMarketSnapshots
} from '../lib/utils-normalization.js';
import type { BrokerRouterAccountResponse } from '../lib/types-broker.js';

export function createPaperRouter(deps: { paperEngine: any }) {
  const router = Router();

  router.get('/paper-desk', async (_req, res) => {
    const paperDesk = deps.paperEngine.getSnapshot();
    try {
      const brokerState = await fetchJson<BrokerRouterAccountResponse>(BROKER_ROUTER_URL, '/account');
      if (brokerState) {
        const brokerAccts = normalizeBrokerAccounts(brokerState.brokers ?? []);
        const brokerPos = normalizeBrokerPositions(brokerState.brokers ?? []);
        
        const alpacaAcct = brokerAccts.find((a) => a.broker === 'alpaca-paper');
        const oandaAcct = brokerAccts.find((a) => a.broker === 'oanda-rest');
        const coinbaseAcct = brokerAccts.find((a) => a.broker === 'coinbase-live');

        let combinedEquity = (alpacaAcct?.equity ?? 0) + (oandaAcct?.equity ?? 0);
        
        if (coinbaseAcct && coinbaseAcct.status === 'connected') {
          const coinbaseAgentPnl = paperDesk.agents
            .filter((a: any) => a.broker === 'coinbase-live')
            .reduce((sum: number, a: any) => sum + a.realizedPnl, 0);
          combinedEquity += (BROKER_STARTING_EQUITY + coinbaseAgentPnl);
        }

        let openRisk = brokerPos.reduce((s, p) => s + (p.unrealizedPnl ?? 0), 0);
        let realRealizedPnl = 0;
        
        if (alpacaAcct && alpacaAcct.status === 'connected') {
          realRealizedPnl += (alpacaAcct.cash - BROKER_STARTING_EQUITY);
        }

        for (const broker of brokerState.brokers) {
          if (broker.broker === 'oanda-rest') {
            const acct = broker.account as Record<string, unknown> ?? {};
            openRisk += parseFloat(String(acct.unrealizedPL ?? '0')) || 0;
            realRealizedPnl += parseFloat(String(acct.pl ?? '0')) || 0;
          }
        }

        if (combinedEquity > 0) {
          paperDesk.totalEquity = round(combinedEquity, 2);
          paperDesk.startingEquity = BROKER_STARTING_EQUITY * 3;
          paperDesk.totalDayPnl = round(combinedEquity - paperDesk.startingEquity, 2);
          paperDesk.realizedPnl = round(realRealizedPnl, 2);
        }
        if (paperDesk.analytics) paperDesk.analytics.totalOpenRisk = round(openRisk, 2);
      }
    } catch { /* best-effort */ }
    
    res.json(paperDesk);
  });

  router.get('/risk-controls', (_req, res) => {
    res.json(deps.paperEngine.getRiskControlSnapshot());
  });

  router.post('/risk-controls/circuit-breaker/review', (req, res) => {
    const note = typeof req.body?.note === 'string' && req.body.note.trim().length > 0
      ? req.body.note.trim()
      : 'manual review complete';
    res.json(deps.paperEngine.acknowledgeCircuitBreaker(note));
  });

  router.get('/walk-forward', (_req, res) => {
    res.json({ asOf: new Date().toISOString(), results: deps.paperEngine.getWalkForwardSnapshot() });
  });

  router.get('/forensics/losses', (req, res) => {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 12;
    const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim().length > 0
      ? req.query.symbol.trim().toUpperCase()
      : undefined;
    res.json({
      asOf: new Date().toISOString(),
      symbol: symbol ?? null,
      rows: deps.paperEngine.getLossForensics(limit, symbol)
    });
  });

  router.get('/market-snapshots', async (_req, res) => {
    const marketData = await fetchJson<{ snapshots?: MarketSnapshot[] }>(MARKET_DATA_URL, '/snapshots');
    res.json(dedupeMarketSnapshots([...(marketData?.snapshots ?? []), ...deps.paperEngine.getMarketSnapshots()]));
  });

  router.get('/agent-configs', (_req, res) => {
    res.json(deps.paperEngine.getAgentConfigs());
  });

  router.get('/live-readiness', (_req, res) => {
    res.json(deps.paperEngine.getLiveReadiness());
  });

  return router;
}
