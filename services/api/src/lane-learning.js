import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const LEDGER_DIR = process.env.PAPER_LEDGER_DIR ?? path.resolve(MODULE_DIR, '../.runtime/paper-ledger');
const LOG_PATH = path.join(LEDGER_DIR, 'lane-learning-log.jsonl');
const REVIEW_WINDOW = Number(process.env.LANE_LEARNING_WINDOW ?? 20);
function round(value, decimals) {
    return Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;
}
function normalizeEntry(entry) {
    const lower = entry.strategy.toLowerCase();
    const lane = entry.lane
        ?? (lower.includes('grid') ? 'grid'
            : lower.includes('pair') ? 'pairs'
                : lower.includes('maker') ? 'maker'
                    : 'scalping');
    const strategyId = entry.strategyId
        ?? (lane === 'pairs' ? 'pairs-btc-eth'
            : lane === 'grid' && entry.symbol === 'BTC-USD' ? 'grid-btc-usd'
                : lane === 'grid' && entry.symbol === 'ETH-USD' ? 'grid-eth-usd'
                    : lane === 'grid' && entry.symbol === 'SOL-USD' ? 'grid-sol-usd'
                        : lane === 'grid' && entry.symbol === 'XRP-USD' ? 'grid-xrp-usd'
                            : lane === 'maker' ? `maker-${entry.symbol.toLowerCase()}`
                                : entry.strategy);
    return {
        ...entry,
        strategyId,
        lane
    };
}
export class LaneLearningEngine {
    lastSerializedDecision = new Map();
    review(entries) {
        const normalized = entries.map(normalizeEntry)
            .filter((entry) => entry.strategyId !== undefined && (entry.lane === 'pairs' || entry.lane === 'grid' || entry.lane === 'maker'));
        const groups = new Map();
        for (const entry of normalized) {
            const bucket = groups.get(entry.strategyId) ?? [];
            bucket.push(entry);
            groups.set(entry.strategyId, bucket);
        }
        const decisions = [];
        for (const [strategyId, group] of groups) {
            const recent = group
                .slice()
                .sort((left, right) => left.exitAt.localeCompare(right.exitAt))
                .slice(-REVIEW_WINDOW);
            const wins = recent.filter((entry) => entry.realizedPnl > 0).length;
            const grossWins = recent.reduce((sum, entry) => sum + Math.max(entry.realizedPnl, 0), 0);
            const grossLosses = Math.abs(recent.reduce((sum, entry) => sum + Math.min(entry.realizedPnl, 0), 0));
            const posteriorWinRate = recent.length > 0 ? ((wins + 2) / (recent.length + 4)) * 100 : 50;
            const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? grossWins : 0;
            const expectancy = recent.length > 0 ? recent.reduce((sum, entry) => sum + entry.realizedPnl, 0) / recent.length : 0;
            const avgConfidencePct = recent.length > 0
                ? recent.reduce((sum, entry) => sum + (entry.confidencePct ?? 0), 0) / recent.length
                : 0;
            const avgEstimatedCostBps = recent.length > 0
                ? recent.reduce((sum, entry) => sum + (entry.estimatedCostBps ?? Math.max(1, entry.spreadBps * 0.75)), 0) / recent.length
                : 0;
            // Use realized expectancy as proxy for net edge (gross edge minus costs)
            // When expectedGrossEdgeBps is not populated, fall back to realized expectancy in bps terms
            const avgExpectedGrossEdgeBps = recent.length > 0
                ? recent.reduce((sum, entry) => sum + (entry.expectedGrossEdgeBps ?? 0), 0) / recent.length
                : 0;
            const avgNetEdgeBps = recent.length > 0
                ? recent.reduce((sum, entry) => {
                    const estimatedCost = entry.estimatedCostBps ?? Math.max(1, entry.spreadBps * 0.75);
                    const grossEdge = entry.expectedGrossEdgeBps ?? 0;
                    // If gross edge is populated, use it; otherwise use realized PnL converted to bps equivalent
                    const realizedNetEdge = grossEdge !== 0
                        ? grossEdge - estimatedCost
                        : expectancy * 10000 / Math.max(entry.confidencePct ?? 50, 1); // rough bps conversion from realized PnL
                    return sum + realizedNetEdge;
                }, 0) / recent.length
                : 0;
            let action = 'hold';
            let enabled = true;
            let allocationMultiplier = 1;
            let reason = 'Lane is within normal bounds. Hold current allocation.';
            if (recent.length < 3) {
                action = 'insufficient-data';
                enabled = true;
                allocationMultiplier = 0.9;
                reason = `Only ${recent.length} recent trades. Keep lane live but do not press size yet.`;
            }
            else if (recent.length >= 6 && (profitFactor < 0.85 || posteriorWinRate < 45 || expectancy < -0.5)) {
                action = 'quarantine';
                enabled = false;
                allocationMultiplier = 0.4;
                reason = `Recent sample is too weak (PF ${profitFactor.toFixed(2)}, posterior win ${posteriorWinRate.toFixed(1)}%, expectancy ${expectancy.toFixed(2)}). Quarantine lane.`;
            }
            else if (recent.length >= 4 && (profitFactor < 1.0 || posteriorWinRate < 52 || expectancy <= 0)) {
                action = 'de-risk';
                enabled = true;
                allocationMultiplier = 0.7;
                reason = `Lane is fragile (PF ${profitFactor.toFixed(2)}, posterior win ${posteriorWinRate.toFixed(1)}%, expectancy ${expectancy.toFixed(2)}, cost ${avgEstimatedCostBps.toFixed(2)}bps). De-risk size.`;
            }
            else if (recent.length >= 6 && profitFactor >= 1.25 && posteriorWinRate >= 60 && expectancy > 0 && avgConfidencePct >= 20) {
                action = 'promote';
                enabled = true;
                allocationMultiplier = 1.3;
                reason = `Lane earned more capital (PF ${profitFactor.toFixed(2)}, posterior win ${posteriorWinRate.toFixed(1)}%, expectancy ${expectancy.toFixed(2)}).`;
            }
            const decision = {
                timestamp: new Date().toISOString(),
                strategyId,
                strategy: recent[recent.length - 1].strategy,
                lane: recent[recent.length - 1].lane,
                action,
                enabled,
                allocationMultiplier: round(allocationMultiplier, 2),
                recentTrades: recent.length,
                posteriorWinRate: round(posteriorWinRate, 1),
                profitFactor: round(profitFactor, 2),
                expectancy: round(expectancy, 2),
                avgConfidencePct: round(avgConfidencePct, 1),
                avgEstimatedCostBps: round(avgEstimatedCostBps, 2),
                avgExpectedGrossEdgeBps: round(avgExpectedGrossEdgeBps, 2),
                avgExpectedNetEdgeBps: round(avgNetEdgeBps, 2),
                reason
            };
            decisions.push(decision);
            this.maybeLog(decision);
        }
        return decisions.sort((left, right) => left.strategyId.localeCompare(right.strategyId));
    }
    getLog(limit = 100) {
        try {
            if (!fs.existsSync(LOG_PATH))
                return [];
            return fs.readFileSync(LOG_PATH, 'utf8')
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .map((line) => JSON.parse(line))
                .slice(-limit);
        }
        catch {
            return [];
        }
    }
    maybeLog(decision) {
        const serialized = JSON.stringify({
            strategyId: decision.strategyId,
            action: decision.action,
            enabled: decision.enabled,
            allocationMultiplier: decision.allocationMultiplier,
            recentTrades: decision.recentTrades,
            posteriorWinRate: decision.posteriorWinRate,
            profitFactor: decision.profitFactor,
            expectancy: decision.expectancy,
            avgConfidencePct: decision.avgConfidencePct,
            avgEstimatedCostBps: decision.avgEstimatedCostBps,
            avgExpectedGrossEdgeBps: decision.avgExpectedGrossEdgeBps,
            avgExpectedNetEdgeBps: decision.avgExpectedNetEdgeBps,
            reason: decision.reason
        });
        if (this.lastSerializedDecision.get(decision.strategyId) === serialized) {
            return;
        }
        this.lastSerializedDecision.set(decision.strategyId, serialized);
        try {
            fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
            fs.appendFileSync(LOG_PATH, `${JSON.stringify(decision)}\n`, 'utf8');
        }
        catch {
            // Non-critical.
        }
    }
}
