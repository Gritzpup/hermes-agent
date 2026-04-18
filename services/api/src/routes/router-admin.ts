import { Router } from 'express';
import { getLiveCapitalSafety } from '../paper-engine/live-capital-safety.js';

export function createAdminRouter(deps: { paperEngine: any }) {
  const router = Router();
  const ADMIN_TOKEN = process.env.ADMIN_RESET_TOKEN ?? '';

  function requireAdminToken(req: any, res: any, next: any) {
    const token = req.headers['x-admin-token'];
    if (!token || token !== ADMIN_TOKEN) {
      return res.status(401).json({ error: 'Missing or invalid x-admin-token' });
    }
    next();
  }

  // POST /api/admin/circuit-breaker/reset
  // Body: { scope: 'daily' | 'weekly' | 'operational', reason: string }
  // ── Phase 4 live-capital safety rails ──────────────────────────

  // GET /api/admin/live-safety — snapshot of all safety stats
  router.get('/live-safety', (_req, res) => {
    res.json(getLiveCapitalSafety().getSnapshot());
  });

  // POST /api/admin/live-safety/halt — manual CEO halt
  // Body: { reason: string, durationHours?: number }
  router.post('/live-safety/halt', requireAdminToken, (req, res) => {
    const { reason, durationHours } = req.body ?? {};
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json({ error: 'reason is required and must be a non-empty string' });
    }
    const duration = typeof durationHours === 'number' && durationHours > 0 ? durationHours : getLiveCapitalSafety().LIVE_HALT_EMBARGO_HOURS;
    getLiveCapitalSafety().triggerHalt(reason.trim(), duration);
    res.json({ ok: true, haltedUntil: getLiveCapitalSafety().getSnapshot().haltedUntil, at: new Date().toISOString() });
  });

  // POST /api/admin/live-safety/resume — clear halt (requires ?confirm=yes)
  router.post('/live-safety/resume', requireAdminToken, (req, res) => {
    if (req.query.confirm !== 'yes') {
      return res.status(400).json({ error: '?confirm=yes is required to resume live trading after a halt' });
    }
    getLiveCapitalSafety().clearHalt();
    res.json({ ok: true, resumed: true, at: new Date().toISOString() });
  });

  router.post('/circuit-breaker/reset', requireAdminToken, (req, res) => {
    const { scope, reason } = req.body ?? {};
    const validScopes = ['daily', 'weekly', 'operational'];
    if (!scope || !validScopes.includes(scope)) {
      return res.status(400).json({ error: `scope must be one of: ${validScopes.join(', ')}` });
    }
    if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
      return res.status(400).json({ error: 'reason is required and must be a non-empty string' });
    }
    deps.paperEngine.resetCircuitBreaker(scope, reason.trim());
    res.json({ ok: true, scope, reason: reason.trim(), at: new Date().toISOString() });
  });

  return router;
}
