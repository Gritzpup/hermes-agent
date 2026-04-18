import './load-env.js';
import cors from 'cors';
import express from 'express';
import type { EvolutionRunRequest } from '@hermes/contracts';
import { getEvolutionEngine } from './evolution.js';

const app = express();
const port = Number(process.env.PORT ?? 4306);
const engine = getEvolutionEngine();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  const run = engine.getCurrentRun();
  res.json({
    service: 'strategy-lab',
    status: run?.status === 'running' ? 'busy' : 'healthy',
    timestamp: new Date().toISOString(),
    populationSize: engine.getPopulation().length,
    currentRun: run
  });
});

app.post('/evolve', async (req, res) => {
  const body = req.body as Partial<EvolutionRunRequest>;
  if (!body.symbol || !body.startDate || !body.endDate) {
    res.status(400).json({ error: 'Missing required fields: symbol, startDate, endDate' });
    return;
  }

  const current = engine.getCurrentRun();
  if (current?.status === 'running') {
    res.status(409).json({ error: 'An evolution run is already in progress.', currentRun: current });
    return;
  }

  const populationSize = body.populationSize ?? 20;
  const generations = body.generations ?? 10;

  const status = await engine.startRun(body.symbol, populationSize, generations, body.startDate, body.endDate);
  res.json(status);
});

app.get('/population', (_req, res) => {
  res.json(engine.getPopulation());
});

app.get('/best', (_req, res) => {
  const best = engine.getBest();
  if (!best) {
    res.status(404).json({ error: 'No genomes evaluated yet.' });
    return;
  }
  res.json(best);
});

app.get('/history', (_req, res) => {
  res.json(engine.getHistory());
});

app.listen(port, '0.0.0.0', () => {
  console.log(`[strategy-lab] listening on http://0.0.0.0:${port}`);
});
