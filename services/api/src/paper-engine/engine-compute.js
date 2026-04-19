// @ts-nocheck
/**
 * Engine Compute Module
 *
 * Heavy computation methods extracted from PaperScalpingEngine.
 * Each function takes `engine: any` as first parameter in place of `this`.
 *
 * This file serves as a coordinator for specialized compute segments.
 */
import { REAL_PAPER_AUTOPILOT, STARTING_EQUITY } from './types.js';
import { buildAgentConfigs, withAgentConfigDefaults, validateAgentConfigs } from '../paper-engine-config.js';
// Import delegations
import * as risk from './engine-compute-risk.js';
import * as stats from './engine-compute-stats.js';
import * as learning from './engine-compute-learning.js';
// Re-export segments for backward compatibility (internal to coordinator)
export const { noteTradeOutcome, getPortfolioRiskSnapshot, evaluateSessionKpiGate, evaluatePortfolioCircuitBreaker, evaluateCryptoExecutionGuard } = risk;
export const { buildRegimeKpis, refreshCapitalAllocation, buildDeskAnalytics, buildExecutionBands, getStrategyTelemetry } = stats;
export const { buildMistakeProfile, applyMistakeDrivenRefinement, applyAdaptiveTuning, evaluateChallengerProbation, buildForensics, evaluateWalkForwardPromotion, getWalkForwardSnapshot } = learning;
// ---------------------------------------------------------------------------
// CORE COMPUTE
// ---------------------------------------------------------------------------
/** BTC-USD R:R override: 1.0× ATR stop / 3.0× ATR target. 15-min post-stopout block. */
export const btcStopoutAt = new Map();
const BTC_STOPOUT_COOLDOWN_MS = 15 * 60 * 1000;
const BTC_EXIT_OVERRIDES = {
    stopAtrMult: 1.0, // 1.0 × ATR — tighter stop (vs 1.5× default)
    takeProfitAtrMult: 3.0, // 3.0 × ATR — let winners run   (vs 2.0× default)
    cooldownMs: BTC_STOPOUT_COOLDOWN_MS,
};
export function computeDynamicStop(engine, fillPrice, agent, symbol, direction = 'long') {
    const shortCryptoProfile = symbol.assetClass === 'crypto' && direction === 'short';
    const stopMultiplier = shortCryptoProfile ? 0.9 : 1;
    const isBtc = symbol.symbol === 'BTC-USD';
    const btcStopAtrMult = isBtc ? BTC_EXIT_OVERRIDES.stopAtrMult : 1.5;
    const atr = engine.marketIntel.computeATR(symbol.symbol);
    if (atr !== null && atr > 0) {
        if (direction === 'short') {
            const atrStop = fillPrice + atr * btcStopAtrMult * stopMultiplier;
            const feeBufStop = fillPrice * (1 + engine.roundTripFeeBps(symbol.assetClass) / 10_000);
            // Dimensional sanity floor (BTC override only): stop must clear spread + round-trip costs by ≥ 1 bps
            if (isBtc) {
                const minStopBps = (symbol.spreadBps ?? 2) + engine.roundTripFeeBps(symbol.assetClass) + 1;
                const computedStopBps = Math.abs((fillPrice - atrStop) / fillPrice) * 10_000;
                if (computedStopBps < minStopBps) {
                    return Math.max(atrStop, feeBufStop); // non-BTC path untouched; keep existing max
                }
            }
            return Math.max(atrStop, feeBufStop);
        }
        const atrStop = fillPrice - atr * btcStopAtrMult * stopMultiplier;
        const feeBufStop = fillPrice * (1 - engine.roundTripFeeBps(symbol.assetClass) / 10_000);
        // Dimensional sanity floor (BTC override only): stop must clear spread + round-trip costs by ≥ 1 bps
        if (isBtc) {
            const minStopBps = (symbol.spreadBps ?? 2) + engine.roundTripFeeBps(symbol.assetClass) + 1;
            const computedStopBps = Math.abs((atrStop - fillPrice) / fillPrice) * 10_000;
            if (computedStopBps < minStopBps) {
                // Expand (loosen) the stop to meet the floor — never tighten
                return direction === 'long'
                    ? fillPrice * (1 - minStopBps / 10_000)
                    : fillPrice * (1 + minStopBps / 10_000);
            }
        }
        return Math.min(atrStop, feeBufStop);
    }
    if (direction === 'short') {
        return fillPrice * (1 + (agent.config.stopBps * stopMultiplier) / 10_000);
    }
    return fillPrice * (1 - (agent.config.stopBps * stopMultiplier) / 10_000);
}
export function computeDynamicTarget(engine, fillPrice, agent, symbol, direction = 'long') {
    const shortCryptoProfile = symbol.assetClass === 'crypto' && direction === 'short';
    const targetMultiplier = shortCryptoProfile ? 1.2 : 1;
    const isBtc = symbol.symbol === 'BTC-USD';
    const btcTpAtrMult = isBtc ? BTC_EXIT_OVERRIDES.takeProfitAtrMult : 2.0;
    const atr = engine.marketIntel.computeATR(symbol.symbol);
    if (atr !== null && atr > 0) {
        const feeBuffer = fillPrice * (engine.roundTripFeeBps(symbol.assetClass) / 10_000);
        return direction === 'short'
            ? fillPrice - atr * btcTpAtrMult * targetMultiplier - feeBuffer
            : fillPrice + atr * btcTpAtrMult * targetMultiplier + feeBuffer;
    }
    if (direction === 'short') {
        return fillPrice * (1 - ((agent.config.targetBps * targetMultiplier) + engine.roundTripFeeBps(symbol.assetClass)) / 10_000);
    }
    return fillPrice * (1 + ((agent.config.targetBps * targetMultiplier) + engine.roundTripFeeBps(symbol.assetClass)) / 10_000);
}
export function resolveEntryDirection(engine, agent, symbol, score, intel) {
    const signal = intel ?? engine.marketIntel.getCompositeSignal(symbol.symbol);
    const bearishFlow = signal.direction === 'sell' || signal.direction === 'strong-sell';
    const bullishFlow = signal.direction === 'buy' || signal.direction === 'strong-buy';
    const riskOff = engine.signalBus.hasRecentSignalOfType('risk-off', 120_000);
    const panicRegime = classifySymbolRegime(engine, symbol) === 'panic';
    const fng = engine.marketIntel.getFearGreedValue();
    const bearishMarket = fng !== null && fng < 35;
    const extremeFear = fng !== null && fng <= 20;
    const rsi2 = engine.marketIntel.computeRSI2(symbol.symbol);
    if (extremeFear && symbol.assetClass === 'crypto') {
        return 'long';
    }
    if (agent.config.style === 'mean-reversion') {
        if (rsi2 !== null && rsi2 > 80 && (bearishFlow || bearishMarket))
            return 'short';
        if ((riskOff !== null || panicRegime) && score <= -0.8 && bearishFlow)
            return 'short';
        return 'long';
    }
    if (bearishFlow && (score <= -0.4 || bearishMarket || symbol.drift <= -0.0015)) {
        return 'short';
    }
    if (bullishFlow && (score >= 0.4 || symbol.drift >= 0.0015)) {
        return 'long';
    }
    if (symbol.assetClass === 'crypto' && bearishMarket)
        return 'short';
    return score < 0 ? 'short' : 'long';
}
export function seedMarket(engine) {
    const updatedAt = new Date().toISOString();
    const configs = buildAgentConfigs(REAL_PAPER_AUTOPILOT);
    const seenSymbols = new Set();
    const defaultSpreadBps = {
        'BTC-USD': 2.8, 'ETH-USD': 3.6, 'SOL-USD': 1.2, 'XRP-USD': 0.8, 'PAXG-USD': 4.0,
        'EUR_USD': 1.2, 'GBP_USD': 1.5, 'USD_JPY': 1.3, 'AUD_USD': 1.4,
        'SPX500_USD': 1.5, 'NAS100_USD': 2.0, 'US30_USD': 2.5,
        'USB02Y_USD': 1.0, 'USB05Y_USD': 1.0, 'USB10Y_USD': 1.1, 'USB30Y_USD': 1.2,
        'XAU_USD': 2.5, 'BCO_USD': 3.0, 'WTICO_USD': 2.8
    };
    for (const config of configs) {
        if (seenSymbols.has(config.symbol))
            continue;
        seenSymbols.add(config.symbol);
        engine.market.set(config.symbol, {
            symbol: config.symbol,
            broker: config.broker ?? 'oanda-rest',
            assetClass: config.assetClass ?? 'equity',
            marketStatus: 'stale',
            sourceMode: 'service',
            session: config.assetClass === 'crypto' ? 'regular' : 'unknown',
            tradable: false,
            qualityFlags: ['awaiting-market-data'],
            updatedAt,
            price: 0,
            openPrice: 0,
            volume: 0,
            liquidityScore: 0,
            spreadBps: 0,
            baseSpreadBps: defaultSpreadBps[config.symbol] ?? 2.0,
            drift: 0.00008,
            volatility: 0.001,
            meanAnchor: 0,
            bias: 0,
            history: Array.from({ length: 24 }, () => 0),
            returns: Array.from({ length: 24 }, () => 0)
        });
    }
}
export function seedAgents(engine) {
    const overrides = engine.loadAgentConfigOverrides();
    const configs = buildAgentConfigs(REAL_PAPER_AUTOPILOT);
    validateAgentConfigs(configs);
    const allocation = STARTING_EQUITY / configs.length;
    for (const config of configs) {
        const mergedConfig = withAgentConfigDefaults({
            ...config,
            ...(overrides[config.id] ?? {})
        });
        engine.agents.set(config.id, {
            config: { ...mergedConfig },
            baselineConfig: { ...config },
            evaluationWindow: 'legacy',
            startingEquity: allocation,
            cash: allocation,
            realizedPnl: 0,
            feesPaid: 0,
            wins: 0,
            losses: 0,
            trades: 0,
            status: 'watching',
            cooldownRemaining: 0,
            position: null,
            pendingOrderId: null,
            pendingSide: null,
            lastBrokerSyncAt: null,
            lastAction: 'Booting paper scalper.',
            lastSymbol: config.symbol,
            lastExitPnl: 0,
            recentOutcomes: [],
            recentHoldTicks: [],
            baselineExpectancy: 0,
            lastAdjustment: 'Collecting baseline paper samples before tuning.',
            improvementBias: 'hold-steady',
            allocationMultiplier: 1,
            allocationScore: 1,
            allocationReason: 'Neutral initial allocation before live outcomes.',
            deployment: {
                mode: 'stable',
                championConfig: null,
                challengerConfig: null,
                startedAt: null,
                startingTrades: 0,
                startingRealizedPnl: 0,
                startingOutcomeCount: 0,
                probationTradesRequired: 6,
                rollbackLossLimit: 2,
                lastDecision: 'Baseline config active.'
            },
            curve: [allocation]
        });
    }
}
export function classifySymbolRegime(engine, symbol) {
    const recentMove = Math.abs(engine.relativeMove(symbol.history, 12));
    const spreadShock = symbol.baseSpreadBps > 0 ? symbol.spreadBps / symbol.baseSpreadBps : 1;
    if (spreadShock >= 1.8 || symbol.volatility >= 0.025 || recentMove >= 0.02) {
        return 'panic';
    }
    if (recentMove >= 0.01 || Math.abs(symbol.drift) >= 0.006) {
        return 'trend';
    }
    if (symbol.volatility <= 0.004 && Math.abs(symbol.drift) <= 0.002) {
        return 'compression';
    }
    return 'chop';
}
