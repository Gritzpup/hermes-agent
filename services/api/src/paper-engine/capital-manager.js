/**
 * Capital Manager Sub-Engine
 *
 * Handles per-agent capital allocation, portfolio risk budgets,
 * desk equity calculation, and circuit breaker logic.
 */
import { inferAssetClassFromSymbol } from '../fee-model.js';
import { round, average, clamp, pickLast } from '../paper-engine-utils.js';
import { getSecEdgarIntel } from '../sec-edgar.js';
// Rotation Engine tuning.
// Weights auto-correct from live journal performance — no hardcoded symbol allocations.
// BTC, XRP, ETH, SOL, FX, equities all compete on the same scorer; losers starve to zero,
// winners press up to 2×, probation clamps sustained bleeders to zero until their expectancy
// turns green again.
const ROTATION_MIN_WEIGHT = 0.0;
const ROTATION_MAX_WEIGHT = 2.0;
const PROBATION_MIN_SAMPLES = 20; // require this many closed trades before we trust the expectancy
const PROBATION_EXPECTANCY_FLOOR = 0; // $ expectancy below this → zero weight
// FIX #3: Emergency fast-kill — 10-trade WR < 30% triggers zero weight immediately
const PROBATION_EMERGENCY_WR = 0.30;
const PROBATION_EMERGENCY_MIN_SAMPLES = 10;
/** Regime × lane multipliers applied on top of the bandit score. */
export const REGIME_LANE_MULTIPLIERS = {
    compression: { scalping: 0.3, maker: 1.3, grid: 1.2, pairs: 1.0 },
    trending: { scalping: 1.2, maker: 1.0, grid: 1.1, pairs: 0.8 },
    panic: { scalping: 0.4, maker: 0.4, grid: 0.4, pairs: 0.4 },
    expansion: { scalping: 1.0, maker: 0.9, grid: 1.3, pairs: 1.1 },
    unknown: { scalping: 1.0, maker: 1.0, grid: 1.0, pairs: 1.0 },
};
export class CapitalManager {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    /** Get desk equity across all brokers — includes Coinbase simulated equity.
     * All 3 brokers are running $100K paper capital = $300K total firm equity.
     * Coinbase: no live account, so simulate as $100K baseline + agent realized PnL.
     */
    getDeskEquity(startingEquity = 300_000) {
        const state = this.deps.state;
        const alpacaEquity = state.brokerPaperAccount?.equity ?? 0;
        const oandaEquity = state.brokerOandaAccount?.equity ?? 0;
        // Coinbase: simulated equity = $100K baseline + realized PnL from agents
        const cbAgents = Array.from(state.agents.values()).filter((a) => a.config.broker === 'coinbase-live');
        const cbPnl = cbAgents.reduce((s, a) => s + a.realizedPnl, 0);
        const COINBASE_STARTING = 100_000; // Fixed $100K per broker baseline
        const coinbaseEquity = COINBASE_STARTING + cbPnl;
        const brokerTotal = alpacaEquity + oandaEquity + coinbaseEquity;
        if (brokerTotal > 0)
            return round(brokerTotal, 2);
        return round(Array.from(state.agents.values()).reduce((sum, a) => sum + this.getAgentEquity(a), 0), 2);
    }
    /** Get starting equity across all brokers.
     * All 3 brokers = $300K firm baseline. Coinbase has no live baseline, use fixed $100K.
     */
    getDeskStartingEquity(startingEquity = 300_000) {
        // COO FIX: Return hardcoded $300K (3 × $100K) instead of drifting broker baselines.
        // This ensures day-PnL is calculated against true starting capital, not current equity.
        return startingEquity; // = $300,000
    }
    /** Get equity for a single agent */
    getAgentEquity(agent) {
        const position = agent.position;
        if (!position)
            return agent.cash;
        const symbol = this.deps.state.market.get(agent.config.symbol);
        const markPrice = symbol?.price ?? position.entryPrice;
        const unrealized = position.direction === 'short'
            ? (position.entryPrice - markPrice) * position.quantity
            : (markPrice - position.entryPrice) * position.quantity;
        return agent.cash + (position.entryPrice * position.quantity) + unrealized;
    }
    /**
     * Refresh per-agent capital allocation using bandit scoring.
     * After bandit scoring, applies the firm-level capital weight as a ceiling
     * via Math.min(banditMultiplier, firmCap) — never lets bandit INCREASE above
     * the firm allocator's targetWeightPct. Firm cap is derived from the
     * CapitalAllocatorSnapshot as targetWeightPct / uniformBaselineWeight.
     * uniformBaselineWeight = 100 / numLiveSleeves.
     */
    refreshAllocation(snapshot) {
        const state = this.deps.state;
        const contenders = Array.from(state.agents.values()).filter((a) => a.config.executionMode === 'broker-paper' && a.config.autonomyEnabled);
        if (contenders.length === 0)
            return;
        const rawScores = contenders.map((agent) => {
            const symbol = state.market.get(agent.config.symbol) ?? null;
            const recent = pickLast(agent.recentOutcomes, 30);
            const sampleCount = recent.length;
            const wins = recent.filter((v) => v > 0).length;
            const losses = recent.filter((v) => v < 0).length;
            const posteriorMean = (wins + 1) / Math.max(wins + losses + 2, 1);
            const expectancy = sampleCount > 0 ? average(recent) : 0;
            const grossWins = recent.filter((v) => v > 0).reduce((s, v) => s + v, 0);
            const grossLosses = Math.abs(recent.filter((v) => v < 0).reduce((s, v) => s + v, 0));
            const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 1.5 : 1;
            const tapeBonus = symbol && this.deps.hasTradableTape(symbol) ? 0.08 : -0.12;
            const embargoPenalty = this.deps.eventCalendar.getEmbargo(agent.config.symbol).blocked ? -0.35 : 0;
            const newsPenalty = this.deps.newsIntel.getSignal(agent.config.symbol).veto ? -0.25 : 0;
            const intelligence = this.deps.marketIntel.getCompositeSignal(agent.config.symbol);
            const convictionBonus = intelligence.tradeable ? Math.min(intelligence.confidence / 1000, 0.08) : 0;
            // CoinMarketCap liquidity enrichment. High 24h-volume symbols (percentile → 1.0) get a
            // small bonus; thin-volume symbols lose weight. Only fires when CMC data is present —
            // non-crypto agents return null and this is a no-op.
            const cmc = this.deps.marketIntel.getCmcSignal?.(agent.config.symbol) ?? null;
            const liquidityBonus = cmc ? (cmc.volumePercentileInUniverse - 0.5) * 0.12 : 0;
            const stableRegime = this.deps.marketIntel.getStablecoinRegime?.() ?? null;
            const agentAssetClass = symbol?.assetClass;
            const stableBias = agentAssetClass === 'crypto' && stableRegime?.regime === 'outflow' ? -0.10 :
                agentAssetClass === 'crypto' && stableRegime?.regime === 'inflow' ? 0.06 : 0;
            // FIX #3: Emergency fast-kill — 10-trade WR < 30% triggers zero weight immediately
            const recent10 = pickLast(agent.recentOutcomes, 10);
            const emergencyProbationActive = recent10.length >= PROBATION_EMERGENCY_MIN_SAMPLES
                && (recent10.filter((v) => v > 0).length / recent10.length) < PROBATION_EMERGENCY_WR;
            // Rotation Engine: if a symbol has enough live data and expectancy is underwater,
            // it drops to zero weight until it earns its way back. Replaces the old hardcoded
            // PERFORMANCE_OVERRIDES table — losers starve themselves automatically.
            const probationActive = (sampleCount >= PROBATION_MIN_SAMPLES && expectancy < PROBATION_EXPECTANCY_FLOOR)
                || emergencyProbationActive;
            const score = clamp(0.35 + posteriorMean * 0.4 + clamp(profitFactor / 4, 0, 0.35)
                + clamp(expectancy / 40, -0.08, 0.08) + tapeBonus + convictionBonus + embargoPenalty + newsPenalty + liquidityBonus + stableBias, 0.1, 1.8);
            // --- Regime-aware lane multiplier ---
            const rawLane = agent.config.id.startsWith('maker-')
                ? 'maker'
                : agent.config.id.startsWith('grid-')
                    ? 'grid'
                    : agent.config.id.startsWith('pairs-')
                        ? 'pairs'
                        : 'scalping';
            const currentRegime = this.deps.getRegime();
            const laneMultipliers = REGIME_LANE_MULTIPLIERS[currentRegime] ?? REGIME_LANE_MULTIPLIERS['unknown'];
            const laneMult = laneMultipliers[rawLane] ?? 1.0;
            // Berkshire-tier copy-sleeve boost: new buys by major investors get 1.1–1.3× allocation
            const secEdgar = getSecEdgarIntel();
            const copyBoost = secEdgar.getBoostForSymbol(agent.config.symbol);
            return { agent, score, posteriorMean, profitFactor, expectancy, sampleCount, probationActive, laneMult, rawLane, currentRegime, copyBoost };
        });
        const meanScore = average(rawScores.map((item) => item.score)) || 1;
        for (const item of rawScores) {
            if (item.probationActive) {
                item.agent.allocationMultiplier = 0;
                item.agent.allocationScore = round(item.score, 3);
                item.agent.allocationReason = `Probation: ${item.sampleCount} trades, expectancy ${item.expectancy.toFixed(2)} ≤ ${PROBATION_EXPECTANCY_FLOOR}. Zero weight until edge turns positive.`;
                continue;
            }
            const multiplier = clamp(round((item.score * item.laneMult * item.copyBoost) / meanScore, 3), ROTATION_MIN_WEIGHT, ROTATION_MAX_WEIGHT);
            item.agent.allocationMultiplier = multiplier;
            item.agent.allocationScore = round(item.score, 3);
            const copyBoostNote = item.copyBoost > 1.0
                ? ` · Berkshire-tier copy boost ${item.copyBoost.toFixed(2)}× applied.`
                : '';
            item.agent.allocationReason =
                `Rotation score ${item.score.toFixed(2)}: posterior ${(item.posteriorMean * 100).toFixed(1)}%,
         PF ${item.profitFactor.toFixed(2)}, E ${item.expectancy.toFixed(2)} over ${item.sampleCount}.
         regime ${item.currentRegime} · ${item.rawLane} × ${item.laneMult}.${copyBoostNote}`;
        }
        // ── Firm-capital ceiling (SYMBOL_POLICY enforcement) ───────────────────────
        // The firm allocator snapshot is the single source of truth for sleeve-level
        // targetWeightPct.  After bandit scoring, cap each agent's multiplier at the
        // firm-derived ceiling so SYMBOL_POLICY (e.g. BTC ×0.25) cannot be overridden
        // upward by short-term trend wins.
        // firmCap = targetWeightPct / uniformBaselineWeight
        // uniformBaselineWeight = 100 / numLiveSleeves (uniform split across live sleeves)
        if (!snapshot)
            return;
        const liveSleeves = snapshot.sleeves.filter((s) => s.kind !== 'cash' && s.liveEligible && s.targetWeightPct > 0);
        if (liveSleeves.length === 0)
            return;
        const uniformBaselineWeight = 100 / liveSleeves.length;
        // Build sleeve lookup: scalping-{assetClass} → allocation, {kind} → allocation
        const sleeveById = new Map();
        for (const sleeve of snapshot.sleeves) {
            sleeveById.set(sleeve.id, sleeve);
        }
        for (const agent of contenders) {
            if (agent.allocationMultiplier === 0)
                continue; // probation → keep zero
            const assetClass = inferAssetClassFromSymbol(agent.config.symbol);
            // Map agent lane to sleeve id (same logic as buildScalpingSleeve / buildStrategySleeve)
            const rawLane = agent.config.id.startsWith('maker-')
                ? 'maker'
                : agent.config.id.startsWith('grid-')
                    ? 'grid'
                    : agent.config.id.startsWith('pairs-')
                        ? 'pairs'
                        : `scalping-${assetClass}`;
            const sleeve = sleeveById.get(rawLane);
            if (!sleeve || sleeve.targetWeightPct <= 0)
                continue;
            const firmCap = sleeve.targetWeightPct / uniformBaselineWeight;
            if (agent.allocationMultiplier > firmCap) {
                const prev = agent.allocationMultiplier;
                agent.allocationMultiplier = firmCap;
                agent.allocationReason +=
                    ` · FIRM-CAP: sleeve "${sleeve.name}" target ${sleeve.targetWeightPct.toFixed(1)}% / ${uniformBaselineWeight.toFixed(1)}% baseline → cap ${prev.toFixed(3)} → ${firmCap.toFixed(3)}.`;
            }
        }
    }
    /** Check portfolio circuit breaker */
    /** Check portfolio circuit breaker — auto-unlatch after 24h if drawdown recovered. */
    evaluateCircuitBreaker(startingEquity, dailyDdPct, weeklyDdPct) {
        const state = this.deps.state;
        const equity = this.getDeskEquity(startingEquity);
        const startEq = this.getDeskStartingEquity(startingEquity);
        if (startEq <= 0)
            return;
        const dailyDd = ((startEq - equity) / startEq) * 100;
        const AUTO_UNLATCH_RECOVERY_PCT = 1.5;
        const AUTO_UNLATCH_GRACE_MS = 24 * 60 * 60 * 1000;
        // Auto-unlatch: 24h elapsed AND drawdown recovered below half-threshold
        if (state.circuitBreakerLatched && state.circuitBreakerArmedAt) {
            const elapsedMs = Date.now() - new Date(state.circuitBreakerArmedAt).getTime();
            if (elapsedMs >= AUTO_UNLATCH_GRACE_MS && dailyDd < AUTO_UNLATCH_RECOVERY_PCT) {
                state.circuitBreakerLatched = false;
                state.circuitBreakerScope = 'none';
                state.circuitBreakerReason = '';
                state.circuitBreakerArmedAt = null;
                console.log(`[CIRCUIT BREAKER] Auto-unlatched after recovery. dailyDd=${dailyDd.toFixed(2)}%`);
                return;
            }
        }
        if (state.circuitBreakerLatched)
            return;
        if (dailyDd >= dailyDdPct) {
            state.circuitBreakerLatched = true;
            state.circuitBreakerScope = 'daily';
            state.circuitBreakerReason = `Daily drawdown ${dailyDd.toFixed(2)}% exceeds ${dailyDdPct}% limit.`;
            state.circuitBreakerArmedAt = new Date().toISOString();
            console.log(`[CIRCUIT BREAKER] ${state.circuitBreakerReason}`);
        }
    }
}
