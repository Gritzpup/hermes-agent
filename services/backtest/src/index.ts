import './load-env.js';
import cors from 'cors';
import express from 'express';
import type {
  BacktestRequest,
  BacktestResult,
  CopySleeveBacktestRequest,
  MacroPreservationBacktestRequest
} from '@hermes/contracts';
import { fetchCandles } from './historical-data.js';
import { getCopySleevePortfolioSnapshot, runCopySleeveBacktest } from './copy-sleeve.js';
import { getMacroPreservationPortfolioSnapshot, runMacroPreservationBacktest } from './macro-preservation.js';
import { getQuarterOutlookReport } from './quarter-outlook.js';
import { runBacktest } from './simulation.js';
import { generateTripleBarrierLabels } from './meta-label/triple-barrier.js';
import { trainMetaLabelModel } from './meta-label/trainer.js';

const app = express();
const port = Number(process.env.PORT ?? 4305);
const results = new Map<string, BacktestResult>();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    service: 'backtest',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    cachedResults: results.size
  });
});

app.get('/copy-sleeve', async (req, res) => {
  try {
    const managerId = typeof req.query.managerId === 'string' && req.query.managerId.trim().length > 0
      ? req.query.managerId.trim()
      : 'berkshire-hathaway';
    const asOf = typeof req.query.asOf === 'string' && req.query.asOf.trim().length > 0
      ? req.query.asOf.trim()
      : new Date().toISOString();
    const snapshot = await getCopySleevePortfolioSnapshot(managerId as CopySleeveBacktestRequest['managerId'], asOf);
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Copy sleeve snapshot failed' });
  }
});

app.post('/copy-sleeve/backtest', async (req, res) => {
  const body = req.body as Partial<CopySleeveBacktestRequest>;
  try {
    const result = await runCopySleeveBacktest(body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Copy sleeve backtest failed' });
  }
});

app.get('/copy-sleeve/backtest', async (req, res) => {
  try {
    const body: Partial<CopySleeveBacktestRequest> = {};
    body.managerId = typeof req.query.managerId === 'string' && req.query.managerId.trim().length > 0
      ? req.query.managerId.trim() as CopySleeveBacktestRequest['managerId']
      : 'berkshire-hathaway';
    if (typeof req.query.startDate === 'string' && req.query.startDate.trim().length > 0) body.startDate = req.query.startDate;
    if (typeof req.query.endDate === 'string' && req.query.endDate.trim().length > 0) body.endDate = req.query.endDate;
    if (typeof req.query.capital === 'string' && Number.isFinite(Number(req.query.capital))) body.capital = Number(req.query.capital);
    if (typeof req.query.benchmarkSymbol === 'string' && req.query.benchmarkSymbol.trim().length > 0) body.benchmarkSymbol = req.query.benchmarkSymbol;
    const result = await runCopySleeveBacktest(body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Copy sleeve backtest failed' });
  }
});

app.get('/macro-preservation', async (req, res) => {
  try {
    const asOf = typeof req.query.asOf === 'string' && req.query.asOf.trim().length > 0
      ? req.query.asOf.trim()
      : new Date().toISOString();
    const body: Partial<MacroPreservationBacktestRequest> = {};
    if (typeof req.query.benchmarkSymbol === 'string' && req.query.benchmarkSymbol.trim().length > 0) {
      body.benchmarkSymbol = req.query.benchmarkSymbol.trim();
    }
    if (typeof req.query.cashSymbol === 'string' && req.query.cashSymbol.trim().length > 0) {
      body.cashSymbol = req.query.cashSymbol.trim() as NonNullable<MacroPreservationBacktestRequest['cashSymbol']>;
    }
    if (typeof req.query.inflationThresholdPct === 'string' && Number.isFinite(Number(req.query.inflationThresholdPct))) {
      body.inflationThresholdPct = Number(req.query.inflationThresholdPct);
    }
    const snapshot = await getMacroPreservationPortfolioSnapshot(asOf, body);
    res.json(snapshot);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Macro preservation snapshot failed' });
  }
});

app.post('/macro-preservation/backtest', async (req, res) => {
  const body = req.body as Partial<MacroPreservationBacktestRequest>;
  try {
    const result = await runMacroPreservationBacktest(body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Macro preservation backtest failed' });
  }
});

app.get('/macro-preservation/backtest', async (req, res) => {
  try {
    const body: Partial<MacroPreservationBacktestRequest> = {};
    if (typeof req.query.startDate === 'string' && req.query.startDate.trim().length > 0) body.startDate = req.query.startDate;
    if (typeof req.query.endDate === 'string' && req.query.endDate.trim().length > 0) body.endDate = req.query.endDate;
    if (typeof req.query.capital === 'string' && Number.isFinite(Number(req.query.capital))) body.capital = Number(req.query.capital);
    if (typeof req.query.benchmarkSymbol === 'string' && req.query.benchmarkSymbol.trim().length > 0) body.benchmarkSymbol = req.query.benchmarkSymbol;
    if (typeof req.query.cashSymbol === 'string' && req.query.cashSymbol.trim().length > 0) body.cashSymbol = req.query.cashSymbol.trim() as NonNullable<MacroPreservationBacktestRequest['cashSymbol']>;
    if (typeof req.query.inflationThresholdPct === 'string' && Number.isFinite(Number(req.query.inflationThresholdPct))) body.inflationThresholdPct = Number(req.query.inflationThresholdPct);
    const result = await runMacroPreservationBacktest(body);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Macro preservation backtest failed' });
  }
});

app.get('/quarter-outlook', async (req, res) => {
  try {
    const asOf = typeof req.query.asOf === 'string' && req.query.asOf.trim().length > 0
      ? new Date(req.query.asOf.trim())
      : new Date();
    const report = await getQuarterOutlookReport(asOf);
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Quarter outlook failed' });
  }
});

app.post('/backtest', async (req, res) => {
  const body = req.body as Partial<BacktestRequest>;
  if (!body.agentConfig || !body.symbol || !body.startDate || !body.endDate) {
    res.status(400).json({ error: 'Missing required fields: agentConfig, symbol, startDate, endDate' });
    return;
  }

  try {
    const candles = await fetchCandles(body.symbol, body.startDate, body.endDate);
    if (candles.length === 0) {
      res.status(400).json({ error: `No candle data returned for ${body.symbol} from ${body.startDate} to ${body.endDate}` });
      return;
    }

    const result = runBacktest(candles, body.agentConfig, body.symbol);
    results.set(result.id, result);

    // Trim cache
    if (results.size > 100) {
      const oldest = Array.from(results.keys()).slice(0, results.size - 100);
      for (const key of oldest) results.delete(key);
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Backtest failed' });
  }
});

app.post('/labels/generate', async (req, res) => {
  try {
    const journalPath = typeof req.body.journalPath === 'string' ? req.body.journalPath : undefined;
    const outputPath = typeof req.body.outputPath === 'string' ? req.body.outputPath : undefined;
    const summary = await generateTripleBarrierLabels(journalPath, outputPath);
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Label generation failed' });
  }
});

app.post('/labels/train', async (req, res) => {
  try {
    // First refresh labels from journal
    const labelSummary = await generateTripleBarrierLabels();
    // Then train the model
    const trainResult = await trainMetaLabelModel();
    res.json({
      labelsGenerated: true,
      labelCounts: labelSummary,
      modelTrained: trainResult.trained,
      samples: trainResult.samples,
      accuracy: trainResult.accuracy,
      reason: trainResult.reason,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Training failed' });
  }
});

app.get('/results/:id', (req, res) => {
  const result = results.get(req.params.id);
  if (!result) {
    res.status(404).json({ error: 'Result not found' });
    return;
  }
  res.json(result);
});

app.listen(port, '0.0.0.0', () => {
  console.log(`[backtest] listening on http://0.0.0.0:${port}`);
  void getQuarterOutlookReport().catch((error) => {
    console.warn(`[backtest] quarter outlook warmup failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  });
});
