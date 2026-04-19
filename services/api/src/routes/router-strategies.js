import { Router } from 'express';
import { MARKET_DATA_URL } from '../lib/constants.js';
import { fetchJson } from '../lib/utils-http.js';
import { round } from '../lib/utils-generic.js';
import { buildSidecarLaneControl } from '../lib/market-regime.js';
export function createStrategyRouter(deps) {
    const router = Router();
    router.get('/strategies', (_req, res) => {
        res.json(buildStrategySnapshots(deps));
    });
    router.get('/opportunities', (_req, res) => {
        res.json(deps.paperEngine.getOpportunitySnapshot());
    });
    router.get('/pairs', (_req, res) => {
        const btcSnap = deps.paperEngine.getMarketSnapshots().find((s) => s.symbol === 'BTC-USD');
        const ethSnap = deps.paperEngine.getMarketSnapshots().find((s) => s.symbol === 'ETH-USD');
        const controls = deps.marketFeed.getLaneControls();
        res.json({
            control: controls.find((c) => c.strategyId === 'pairs-btc-eth') ?? null,
            state: deps.pairsEngine.getState(btcSnap?.lastPrice ?? 0, ethSnap?.lastPrice ?? 0),
            stats: deps.pairsEngine.getStats()
        });
    });
    router.get('/grid', (_req, res) => {
        const controls = deps.marketFeed.getLaneControls();
        res.json({
            btc: { control: controls.find((c) => c.strategyId === 'grid-btc-usd') ?? null, state: deps.btcGrid.getState(), stats: deps.btcGrid.getStats() },
            eth: { control: controls.find((c) => c.strategyId === 'grid-eth-usd') ?? null, state: deps.ethGrid.getState(), stats: deps.ethGrid.getStats() },
            sol: { control: controls.find((c) => c.strategyId === 'grid-sol-usd') ?? null, state: deps.solGrid.getState(), stats: deps.solGrid.getStats() },
            xrp: { control: controls.find((c) => c.strategyId === 'grid-xrp-usd') ?? null, state: deps.xrpGrid.getState(), stats: deps.xrpGrid.getStats() }
        });
    });
    router.get('/maker', (_req, res) => {
        const controls = deps.marketFeed.getLaneControls();
        res.json({
            controls: [
                controls.find((c) => c.strategyId === 'maker-btc-usd') ?? null,
                controls.find((c) => c.strategyId === 'maker-eth-usd') ?? null
            ].filter(Boolean),
            quotes: deps.makerEngine.getSnapshot(),
            orders: deps.makerExecutor.getSnapshot()
        });
    });
    router.get('/maker/orders', (_req, res) => {
        res.json(deps.makerExecutor.getSnapshot());
    });
    router.post('/maker/clear-blocks', (req, res) => {
        const symbol = typeof req.body?.symbol === 'string' ? req.body.symbol : undefined;
        deps.makerExecutor.clearBlocks(symbol);
        res.json({ ok: true, symbol: symbol ?? null, snapshot: deps.makerExecutor.getSnapshot() });
    });
    router.get('/maker/policy', (_req, res) => {
        res.json(deps.makerExecutor.getPolicy());
    });
    router.get('/research', async (_req, res) => {
        const marketData = await fetchJson(MARKET_DATA_URL, '/snapshots');
        res.json(buildResearchCandidates(marketData?.snapshots ?? []));
    });
    router.get('/strategy-controls', (_req, res) => {
        res.json(deps.marketFeed.getLaneControls());
    });
    return router;
}
function buildStrategySnapshots(deps) {
    const paperDesk = deps.paperEngine.getSnapshot();
    const readiness = deps.paperEngine.getLiveReadiness();
    const controls = deps.marketFeed.getLaneControls();
    const scalpers = readiness.agents.map((agent) => {
        const paperAgent = paperDesk.agents.find((candidate) => candidate.id === agent.agentId);
        const failedGates = agent.gates.filter((gate) => !gate.passed);
        return {
            id: agent.agentId,
            name: `${agent.agentName} / ${agent.symbol}`,
            lane: 'scalping',
            stage: failedGates.length === 0 && agent.symbol.endsWith('-USD') ? 'shadow-live' : 'paper',
            mode: 'paper',
            broker: agent.symbol.endsWith('-USD') ? 'coinbase-live' : 'alpaca-paper',
            symbols: [agent.symbol],
            status: agent.mode === 'blocked' ? 'blocked' : paperAgent?.status === 'watching' ? 'warming' : 'active',
            dailyPnl: paperAgent?.dayPnl ?? agent.realizedPnl,
            lastReviewAt: new Date().toISOString(),
            summary: failedGates.map((gate) => `${gate.name}: ${gate.actual}`).join(' | ') || 'Cleared current readiness gates.'
        };
    });
    const btcPrice = deps.paperEngine.getMarketSnapshots().find((s) => s.symbol === 'BTC-USD')?.lastPrice ?? 0;
    const ethPrice = deps.paperEngine.getMarketSnapshots().find((s) => s.symbol === 'ETH-USD')?.lastPrice ?? 0;
    const pairsState = deps.pairsEngine.getState(btcPrice, ethPrice);
    const pairsStats = deps.pairsEngine.getStats();
    const pairsControl = controls.find((c) => c.strategyId === 'pairs-btc-eth');
    const pairsSnapshot = {
        id: 'pairs-btc-eth',
        name: 'BTC/ETH Dynamic Hedge Pair',
        lane: 'pairs',
        stage: 'paper',
        mode: 'paper',
        broker: 'coinbase-live',
        symbols: ['BTC-USD', 'ETH-USD'],
        status: pairsControl && !pairsControl.enabled ? 'blocked' : pairsState.position === 'flat' ? 'warming' : 'active',
        dailyPnl: pairsStats.realizedPnl,
        lastReviewAt: pairsControl?.lastReviewAt ?? new Date().toISOString(),
        summary: pairsControl && !pairsControl.enabled
            ? `${pairsControl.blockedReason} Correlation ${pairsState.correlation?.toFixed(2) ?? '0.00'}, beta ${pairsState.hedgeRatio?.toFixed(2) ?? '1.00'}, z-score ${pairsState.zScore.toFixed(2)}.`
            : `Correlation ${pairsState.correlation?.toFixed(2) ?? '0.00'}, beta ${pairsState.hedgeRatio?.toFixed(2) ?? '1.00'}, z-score ${pairsState.zScore.toFixed(2)}. Alloc ${pairsStats.allocationMultiplier.toFixed(2)}, PF ${pairsControl?.recentProfitFactor?.toFixed(2) ?? '0.00'}.`
    };
    const gridSnapshots = [
        { grid: deps.btcGrid, symbol: 'BTC-USD' },
        { grid: deps.ethGrid, symbol: 'ETH-USD' },
        { grid: deps.solGrid, symbol: 'SOL-USD' },
        { grid: deps.xrpGrid, symbol: 'XRP-USD' }
    ].map(({ grid, symbol }) => {
        const stats = grid.getStats();
        const control = controls.find((c) => c.strategyId === `grid-${symbol.toLowerCase()}`);
        return {
            id: `grid-${symbol.toLowerCase()}`,
            name: `${symbol} Adaptive Grid`,
            lane: 'grid',
            stage: 'paper',
            mode: 'paper',
            broker: 'coinbase-live',
            symbols: [symbol],
            status: control && !control.enabled ? 'blocked' : stats.openPositions > 0 ? 'active' : 'warming',
            dailyPnl: stats.realizedPnl,
            lastReviewAt: control?.lastReviewAt ?? new Date().toISOString(),
            summary: control && !control.enabled
                ? `${control.blockedReason} Round trips ${stats.roundTrips}, win rate ${stats.winRate.toFixed(1)}%, open positions ${stats.openPositions}.`
                : `Round trips ${stats.roundTrips}, win rate ${stats.winRate.toFixed(1)}%, open positions ${stats.openPositions}, alloc ${stats.allocationMultiplier.toFixed(2)}.`
        };
    });
    const makerSnapshots = deps.makerEngine.getSnapshot().states.map((state) => {
        const control = controls.find((c) => c.strategyId === `maker-${state.symbol.toLowerCase()}`);
        return {
            id: `maker-${state.symbol.toLowerCase()}`,
            name: `${state.symbol} Maker`,
            lane: 'maker',
            stage: 'paper',
            mode: 'paper',
            broker: 'coinbase-live',
            symbols: [state.symbol],
            status: control && !control.enabled ? 'blocked' : state.mode === 'paused' ? 'blocked' : state.inventoryQty > 0 ? 'active' : 'warming',
            dailyPnl: state.realizedPnl,
            lastReviewAt: control?.lastReviewAt ?? state.updatedAt,
            summary: control && !control.enabled
                ? `${control.blockedReason} Width ${state.widthBps.toFixed(2)}bps, inventory ${state.inventoryQty.toFixed(6)}, adverse ${state.adverseScore.toFixed(1)}.`
                : `${state.reason} Width ${state.widthBps.toFixed(2)}bps, inventory ${state.inventoryQty.toFixed(6)}, adverse ${state.adverseScore.toFixed(1)}.`
        };
    });
    return [...scalpers, pairsSnapshot, ...gridSnapshots, ...makerSnapshots];
}
function buildResearchCandidates(snapshots) {
    return snapshots
        .filter((snapshot) => snapshot.status === 'live' && snapshot.source !== 'mock' && snapshot.source !== 'simulated')
        .slice()
        .sort((left, right) => (right.liquidityScore - left.liquidityScore) || (left.spreadBps - right.spreadBps))
        .slice(0, 8)
        .map((snapshot, index) => {
        const derivedScore = Math.max(0, snapshot.liquidityScore - snapshot.spreadBps * 6 + Math.abs(snapshot.changePct) * 10);
        return {
            id: `research-${snapshot.symbol}-${index}`,
            symbol: snapshot.symbol,
            strategy: snapshot.symbol.endsWith('-USD') ? 'Crypto Tape Scan' : 'Equity Momentum Scan',
            score: round(derivedScore, 1),
            expectedEdgeBps: round(Math.max(0, snapshot.liquidityScore / 8 - snapshot.spreadBps), 1),
            catalyst: `${snapshot.changePct.toFixed(2)}% move, ${snapshot.spreadBps.toFixed(2)} bps spread.`,
            aiVerdict: 'Derived from live market-data snapshots and eligible for paper monitoring.',
            riskStatus: snapshot.spreadBps <= 5 && snapshot.liquidityScore >= 85 ? 'approved' : 'review',
            broker: snapshot.symbol.endsWith('-USD') ? 'coinbase-live' : 'alpaca-paper'
        };
    });
}
