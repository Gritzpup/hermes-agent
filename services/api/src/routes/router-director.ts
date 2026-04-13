import { Router } from 'express';

export function createDirectorRouter(deps: { strategyDirector: any }) {
  const router = Router();

  router.post('/cycle/run', async (_req, res) => {
    try {
      const directive = await deps.strategyDirector.runCycle();
      res.json(directive);
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : 'Director cycle failed' });
    }
  });

  router.get('/regime', (_req, res) => {
    res.json(deps.strategyDirector.getRegimeSnapshot());
  });

  return router;
}
