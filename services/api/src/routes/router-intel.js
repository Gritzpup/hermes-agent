import { Router } from 'express';
import { REVIEW_LOOP_URL } from '../lib/constants.js';
import { fetchJson } from '../lib/utils-http.js';
export function createIntelRouter(deps) {
    const router = Router();
    router.get('/intel', (_req, res) => {
        res.json(deps.marketIntel.getSnapshot());
    });
    router.get('/intel/:symbol', (req, res) => {
        res.json(deps.marketIntel.getCompositeSignal(req.params.symbol));
    });
    router.get('/news-intel', (_req, res) => {
        res.json(deps.newsIntel.getSnapshot());
    });
    router.get('/news-intel/:symbol', (req, res) => {
        res.json(deps.newsIntel.getSignal(req.params.symbol));
    });
    router.get('/calendar', (_req, res) => {
        res.json(deps.eventCalendar.getSnapshot());
    });
    router.get('/review-clusters', async (_req, res) => {
        const clusters = await fetchJson(REVIEW_LOOP_URL, '/clusters');
        res.json(clusters ?? {});
    });
    router.get('/feature-store/summary', (req, res) => {
        const lookbackDays = Number(req.query.lookbackDays ?? 180);
        res.json(deps.featureStore.getSummary(Number.isFinite(lookbackDays) ? lookbackDays : 180));
    });
    router.get('/feature-store/query', (req, res) => {
        const lookbackDays = Number(req.query.lookbackDays ?? 180);
        const limit = Number(req.query.limit ?? 100);
        const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
        const assetClass = typeof req.query.assetClass === 'string' ? req.query.assetClass : undefined;
        const regime = typeof req.query.regime === 'string' ? req.query.regime : undefined;
        const flowBucket = typeof req.query.flowBucket === 'string' ? req.query.flowBucket : undefined;
        const strategyId = typeof req.query.strategyId === 'string' ? req.query.strategyId : undefined;
        const filters = {
            ...(symbol ? { symbol } : {}),
            ...(assetClass ? { assetClass } : {}),
            ...(regime ? { regime } : {}),
            ...(flowBucket ? { flowBucket } : {}),
            ...(strategyId ? { strategyId } : {}),
            lookbackDays: Number.isFinite(lookbackDays) ? lookbackDays : 180,
            limit: Number.isFinite(limit) ? limit : 100
        };
        res.json(deps.featureStore.queryTrades(filters));
    });
    return router;
}
