import { Router } from 'express';

export function createDirectorRouter(deps: { strategyDirector: any }) {
  const router = Router();

  // Non-blocking: fire-and-forget cycle runner
  router.post('/cycle/run', async (_req, res) => {
    const sd = deps.strategyDirector;
    if ((sd as any).runInFlight) {
      return res.status(409).json({ error: 'Cycle already in flight', runId: (sd as any).currentRunId ?? null });
    }
    // Return 202 immediately — cycle runs in background
    res.status(202).json({ status: 'accepted', message: 'Cycle started in background' });
    // Fire and forget
    sd.runCycle().catch((err: Error) => console.error('[director-router] background cycle failed:', err.message));
  });

  // Get latest directive
  router.get('/directive/latest', (_req, res) => {
    const latest = deps.strategyDirector.getLatest();
    if (!latest) return res.status(404).json({ error: 'No directive yet' });
    res.json(latest);
  });

  // Get directive log
  router.get('/directive/log', (_req, res) => {
    const limit = Math.min(parseInt(_req.query.limit as string ?? '20', 10), 100);
    res.json(deps.strategyDirector.getLog(limit));
  });

  router.get('/regime', (_req, res) => {
    res.json(deps.strategyDirector.getRegimeSnapshot());
  });

  return router;
}
