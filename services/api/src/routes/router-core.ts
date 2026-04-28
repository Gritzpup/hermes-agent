import { Router } from 'express';
import type { ExecutionReport, TradeJournalEntry, BacktestAgentConfig } from '@hermes/contracts';
import {
  BROKER_ROUTER_URL,
  REVIEW_LOOP_URL
} from '../lib/constants.js';
import {
  fetchJson,
  fetchArrayJson,
  getServiceHealthSnapshot
} from '../lib/utils-http.js';
import {
  normalizeBrokerPositions,
  normalizeBrokerReports,
  dedupePositions,
  dedupeReports,
  dedupeJournal
} from '../lib/utils-normalization.js';
import {
  buildTerminalSnapshot,
  type TerminalSnapshotDeps
} from '../lib/terminal-builder.js';
import type { BrokerRouterReportsResponse } from '../lib/types-broker.js';
import { getWalkForwardStatus, runWalkForwardCycle } from '../services/walk-forward-engine.js';

export function createCoreRouter(deps: TerminalSnapshotDeps) {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const services = await getServiceHealthSnapshot();
    const hasError = services.some((s: any) => s.status === 'error');
    const hasWarning = services.some((s: any) => s.status === 'warning');
    const overall = hasError ? 'error' : hasWarning ? 'degraded' : 'healthy';
    res.json({ status: overall, timestamp: new Date().toISOString(), services });
  });

  // §4.1 LATENCY REPORT: per-venue/symbol P50/P90/P99 signal-to-fill latency
  router.get('/latency-report', async (_req, res) => {
    try {
      const report = deps.paperEngine.latencyTracker?.getReport?.();
      if (!report) {
        res.json({ asOf: new Date().toISOString(), buckets: [], totalSamples: 0, alerts: [], error: 'latency tracker not initialized' });
        return;
      }
      res.json(report);
    } catch (error) {
      console.error('[router-core] latency-report error:', error instanceof Error ? error.stack : error);
      res.status(500).json({ error: 'Failed to build latency report' });
    }
  });

  async function handleTerminalSnapshot(_req: any, res: any) {
    try {
      const snapshot = await buildTerminalSnapshot(deps);
      res.json(snapshot);
    } catch (error) {
      console.error('[router-core] snapshot error:', error instanceof Error ? error.stack : error);
      res.status(500).json({ error: 'Failed to build terminal snapshot' });
    }
  }

  router.get('/overview', handleTerminalSnapshot);
  router.get('/terminals', handleTerminalSnapshot);

  router.get('/positions', async (_req, res) => {
    // In a real app, we might want a shared cache for broker positions to avoid hitting the router every time
    const brokerState = await fetchJson<any>(BROKER_ROUTER_URL, '/account');
    const brokerPositions = normalizeBrokerPositions(brokerState?.brokers ?? []);
    res.json(dedupePositions([...brokerPositions, ...deps.paperEngine.getPositions()]));
  });

  router.get('/orders', async (_req, res) => {
    const brokerOrdersState = await fetchJson<BrokerRouterReportsResponse>(BROKER_ROUTER_URL, '/reports');
    const brokerOrders = normalizeBrokerReports(brokerOrdersState?.reports ?? []);
    
    // We should probably have a helper to map paper engine fills to reports if needed, 
    // but the dashboard usually handles the split.
    res.json(dedupeReports(brokerOrders));
  });

  router.get('/journal', async (_req, res) => {
    const journal = await fetchArrayJson<TradeJournalEntry>(REVIEW_LOOP_URL, '/journal');
    res.json(dedupeJournal([...deps.paperEngine.getJournal(), ...journal]));
  });

  // §G4: Walk-Forward Validation
  router.get('/walk-forward/status', async (_req, res) => {
    try {
      res.json(getWalkForwardStatus());
    } catch (error) {
      res.status(500).json({ error: 'Failed to get walk-forward status' });
    }
  });

  router.post('/walk-forward/run', async (req, res) => {
    const body = req.body as Partial<{
      challengerConfig: BacktestAgentConfig;
      championPF: number;
      startDate: string;
      endDate: string;
    }>;
    if (!body.challengerConfig) {
      res.status(400).json({ error: 'challengerConfig is required' });
      return;
    }
    // Fire and forget — client polls /walk-forward/status
    void runWalkForwardCycle(
      body.challengerConfig,
      body.championPF ?? 1.0,
      body.startDate,
      body.endDate
    ).catch(err => {
      console.error('[walk-forward] run error:', err);
    });
    res.json({ ok: true, message: 'Walk-forward run started', status: 'polling /walk-forward/status' });
  });

  return router;
}
