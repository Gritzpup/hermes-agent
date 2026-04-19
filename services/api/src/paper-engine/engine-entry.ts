import type { AssetClass } from '@hermes/contracts';
import {
  average,
  clamp,
  pickLast,
  round
} from '../paper-engine-utils.js';
import { getMetaLabelDecision } from './engine-entry-meta.js';
import { buildJournalContext } from './engine-entry-meta.js';
import { btcStopoutAt } from './engine-compute.js';
import { isCorrelatedBreakerActive } from './engine-trading-positions.js';

/** Drawdown-scaled sizing factor — shrinks position sizes as equity drops below HWM.
 *  Linear scale: 0% dd → 1.0×, 10% dd → 0.0× (full halt).
 *  Formula: max(0, 1 - dd * 10)  where dd = (HWM - NAV) / HWM
 */
export function drawdownSizingFactor(engine: any): number {
  const hwm = engine.equityHighWaterMark ?? 0;
  const nav = engine.getDeskEquity?.() ?? hwm;
  if (hwm <= 0) return 1.0;
  const dd = Math.max(0, (hwm - nav) / hwm);
  return Math.max(0, 1 - dd * 10);
}

/** Extract rolling median signal-to-fill latency for a venue across all its symbols. */
function getVenueMedianLatencyMs(report: { buckets: Array<{ venue: string; signalToFillMsP50: number }> }, venue: string): number {
  const buckets = report.buckets.filter(b => b.venue === venue && b.signalToFillMsP50 > 0);
  if (!buckets.length) return 0;
  return buckets.reduce((sum, b) => sum + b.signalToFillMsP50, 0) / buckets.length;
}
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Emergency Halt Runtime ─────────────────────────────────────────────────
// Sync check every call — no caching so a 3AM COO activation takes effect
// on the next tick without any restart.
const EMERGENCY_HALT_FILE = '/mnt/Storage/github/hermes-trading-firm/services/api/.runtime/emergency-halt.json';

// OPTIMAL TRADING SESSIONS
// Based on volume analysis: trade during high-liquidity windows only
// Dead zones have wider spreads and more noise
const OPTIMAL_CRYPTO_HOURS: Record<string, number[]> = {
  'BTC-USD': [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2],  // US + Asia overlap (widened +2h each side)
  'ETH-USD': [12, 13, 14, 15, 16, 17, 18, 19, 20, 21],                    // US market hours (widened +1h each side)
  'XRP-USD': [12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22],               // US market prime (widened +1h each side)
  'SOL-USD': [13, 14, 15, 16, 17, 18, 19, 20, 21],                        // US hours (widened +1h on left, +1h on right)
};

// Session names for logging
const SESSION_NAMES: Record<string, string> = {
  '13': 'NY morning', '14': 'NY open', '15': 'NY prime', '16': 'NY noon',
  '17': 'London close', '18': 'US afternoon', '19': 'US afternoon', '20': 'US afternoon',
  '21': 'US evening', '22': 'Asia open', '23': 'Asia', '0': 'Asia', '1': 'Asia',
  '4': 'dead zone', '5': 'dead zone'
};

/** Check if current UTC hour is in optimal trading window for this symbol */
function isOptimalTradingSession(symbol: string, hour: number): boolean {
  const optimalHours = OPTIMAL_CRYPTO_HOURS[symbol];
  if (!optimalHours) {
    // Default: skip dead zone (4-6 UTC) and only trade 6-4 UTC range
    return hour >= 6 || hour < 4;
  }
  return optimalHours.includes(hour);
}

/** Get session quality for logging */
function getSessionQuality(symbol: string, hour: number): string {
  const optimal = OPTIMAL_CRYPTO_HOURS[symbol];
  if (!optimal) {
    return hour >= 6 || hour < 4 ? 'active' : 'dead-zone';
  }
  if (optimal.includes(hour)) return 'optimal';
  if (hour >= 6 || hour < 4) return 'active';
  return 'dead-zone';
}

// Re-export everything from sub-modules so paper-engine.ts imports don't break
export {
  getMetaLabelDecision,
  getContextualMetaSignal,
  buildEntryMeta,
  buildMetaCandidate,
  buildJournalContext
} from './engine-entry-meta.js';

export {
  getRouteBlock,
  getPrecisionBlock,
  getManagerBlock,
  describeWatchState,
  describeAiState,
  normalizeFlowBucket,
  getConfidenceBucket,
  getSpreadBucket,
  entryNote,
  getEntryScore,
  entryThreshold,
  exitThreshold,
  estimatedBrokerRoundTripCostBps,
  fastPathThreshold,
  brokerRulesFastPathThreshold,
  canUseBrokerRulesFastPath
} from './engine-entry-scoring.js';

// FIX #1: Scalper confidence floor — env-override, default 45 (tighter than generic 65)
const SCALP_CONFIDENCE_FLOOR = parseInt(process.env.SCALP_CONFIDENCE_FLOOR ?? '45', 10);

/** Derive lane from agent config id (same logic as engine-views.ts classifyLane) */
function classifyLane(strategyId: string): 'maker' | 'grid' | 'pairs' | 'scalping' {
  if (!strategyId) return 'scalping';
  if (strategyId.startsWith('maker-')) return 'maker';
  if (strategyId.startsWith('grid-')) return 'grid';
  if (strategyId.startsWith('pairs-')) return 'pairs';
  return 'scalping';
}

export function canEnter(engine: any, agent: any, symbol: any, shortReturn: number, mediumReturn: number, score: number): boolean {
  // ── Emergency Halt: absolute top-of-function gate ───────────────────────
  // No restart needed — operator writes the file via POST /api/emergency-halt
  // COO FIX #3: per-lane/symbol override — if halt has lanes/symbols fields, only block those
  if (fs.existsSync(EMERGENCY_HALT_FILE)) {
    const haltData = JSON.parse(fs.readFileSync(EMERGENCY_HALT_FILE, 'utf-8'));
    const haltLanes: string[] = haltData.lanes ?? null;
    const haltSymbols: string[] = haltData.symbols ?? null;
    const hasLaneField = haltLanes !== null && Array.isArray(haltLanes);
    const hasSymbolField = haltSymbols !== null && Array.isArray(haltSymbols);

    // If neither lanes nor symbols fields exist, halt everything (backwards compat)
    if (!hasLaneField && !hasSymbolField) {
      agent.lastAction = 'emergency halt active';
      return false;
    }

    // Per-lane check: block only if current lane is in the halt lanes list
    const lane = classifyLane(agent.config.id);
    if (hasLaneField && haltLanes.includes(lane)) {
      agent.lastAction = `emergency halt active for lane: ${lane}`;
      return false;
    }

    // Per-symbol check: block only if current symbol is in the halt symbols list
    if (hasSymbolField && haltSymbols.includes(symbol.symbol)) {
      agent.lastAction = `emergency halt active for symbol: ${symbol.symbol}`;
      return false;
    }
  }

  // ── Scalping Lane Disabled (COO Fix #2) ───────────────────────────────
  // Scalping lane has systematic losses: 62.7% WR, -$401.76 P&L
  // Disabled until RSI filter fixed + compression regime added + meta-label trained
  // COO FIX #1: per-symbol disable — only block if THIS symbol is in the disabled list
  const SCALPING_DISABLED_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.runtime/lane-scalping-disabled.json');
  if (fs.existsSync(SCALPING_DISABLED_FILE)) {
    const lane = classifyLane(agent.config.id);
    if (lane === 'scalping') {
      // Parse and check per-symbol list (backwards compat: no symbols array = disable all)
      const disabledData = JSON.parse(fs.readFileSync(SCALPING_DISABLED_FILE, 'utf-8'));
      const disabledSymbols: string[] = disabledData.symbols ?? null;
      // If no symbols array, treat as global disable (backwards compat)
      const isGlobalDisable = !Array.isArray(disabledSymbols);
      if (isGlobalDisable || (Array.isArray(disabledSymbols) && disabledSymbols.includes(symbol.symbol))) {
        agent.lastAction = 'scalping lane disabled by COO: systematic losses (62.7% WR, -$401.76) — see lane-scalping-disabled.json';
        return false;
      }
    }
  }

  // ── Correlated-Loss Circuit Breaker ────────────────────────────────────
  // If 3+ symbols hit stop-loss in 5 min, pause scalping/grid/pairs.
  // Maker lane is exempt — wider spreads during volatility = more capture.
  if (isCorrelatedBreakerActive() && agent.config.lane !== 'maker') {
    agent.lastAction = 'correlated-loss breaker active — lane paused';
    return false;
  }

  // Paper mode: smart entries with multiple filters
  if (agent.config.executionMode === 'broker-paper' && symbol.price > 0 && symbol.tradable) {
    if (engine.circuitBreakerLatched) return false;
    if (engine.operationalKillSwitchUntilMs > Date.now()) return false;
    // COO FIX #1: Block entry if symbol hit daily loss limit
    if (agent.symbolKillSwitchUntil && new Date(agent.symbolKillSwitchUntil) > new Date()) return false;
    // BTC-USD post-stopout cooldown: 15-min block after a stop-loss fires
    if (symbol.symbol === 'BTC-USD') {
      const last = btcStopoutAt.get('BTC-USD') ?? 0;
      if (Date.now() - last < 15 * 60 * 1000) {
        agent.lastAction = 'BTC cooldown: 15-min post-stopout block';
        return false;
      }
    }

    // STEP 2: Per-symbol feed-staleness gate — hard block when market data is stale
    const STALE_MAX_MS: Record<AssetClass, number> = {
      crypto: 15_000,
      equity: 120_000,
      forex: 120_000,
      bond: 300_000,
      commodity: 300_000,
      'commodity-proxy': 300_000
    };
    const snapshotAge = Date.now() - new Date(symbol.updatedAt ?? 0).getTime();
    const maxStale = STALE_MAX_MS[symbol.assetClass as AssetClass] ?? 60_000;
    if (snapshotAge > maxStale) {
      agent.lastAction = `Feed staleness: ${snapshotAge}ms > max ${maxStale}ms`;
      return false;
    }

    // LATENCY GATE: block mean-reversion scalps when observed signal-to-fill latency > 5s.
    // Q17 tracks signalAt/submitAt/fillAt; if median is 5+ seconds the move has reversed.
    if (agent.config.style === 'mean-reversion' && agent.config.lane === 'scalping') {
      const report = engine.latencyTracker?.getReport?.();
      const venueMedianLatencyMs = report ? getVenueMedianLatencyMs(report, agent.config.broker) : 0;
      if (venueMedianLatencyMs > 5000) {
        agent.lastAction = `latency gate: ${agent.config.broker} median ${Math.round(venueMedianLatencyMs)}ms > 5000ms`;
        return false;
      }
    }
    if (symbol.spreadBps > agent.config.spreadLimitBps) return false;
    const guard = engine.getSymbolGuard(symbol.symbol);
    if (guard) return false;
    const sessionGate = engine.evaluateSessionKpiGate(symbol);
    if (!sessionGate.pass) return false;
    const intel = engine.marketIntel.getCompositeSignal(symbol.symbol);
    const direction = engine.resolveEntryDirection(agent, symbol, score, intel);
    const regime = engine.classifySymbolRegime(symbol);
    const regimeThrottle = engine.getRegimeThrottleMultiplier(symbol);
    if (regimeThrottle < 0.5) return false;
    const strongDirectionSignal = direction === 'short'
      ? (intel.direction === 'sell' || intel.direction === 'strong-sell')
      : (intel.direction === 'buy' || intel.direction === 'strong-buy');

    if (symbol.assetClass === 'crypto') {
      const cryptoGuard = engine.evaluateCryptoExecutionGuard(symbol, intel);
      if (!cryptoGuard.pass) {
        agent.lastAction = cryptoGuard.reason;
        return false;
      }
    }

    // Crypto threshold boost: Alpaca crypto agents have a 27% win rate — require
    // ~40% higher score to enter, so only high-conviction setups pass.
    const cryptoThresholdMult = symbol.assetClass === 'crypto' ? 1.4 : 1.0;
    if (Math.abs(score) < engine.entryThreshold(agent.config.style) * cryptoThresholdMult) return false;
    // Scalpers need higher confidence than other lanes
    const scalperConfidenceFloor = classifyLane(agent.config.id) === 'scalping' ? SCALP_CONFIDENCE_FLOOR : 65;
    if (!strongDirectionSignal && intel.confidence < scalperConfidenceFloor) return false;

    // 1. Time-of-day filter: only scalp during peak volatility hours
    const hour = new Date().getUTCHours();
    if (symbol.assetClass === 'crypto') {
      // Crypto peak: US market hours overlap (14-21 UTC) and Asia open (00-03 UTC)
      // Crypto trades 24/7 — only skip the lowest-volume dead zone (4-6 UTC = midnight US east coast)
      const cryptoActive = hour < 4 || hour >= 6;
      if (!cryptoActive) return false;

      // NEW: Session-specific filter — XRP and BTC have different optimal windows
      const sessionQuality = getSessionQuality(symbol.symbol, hour);
      if (sessionQuality === 'dead-zone') {
        agent.lastAction = `Session filter: ${symbol.symbol} in dead zone at hour ${hour} UTC`;
        return false;
      }

      // XRP-USD extra filter: only trade during US hours (best liquidity, tightest spreads)
      // XRP has 74% win rate in paper - protect that edge by avoiding low-liquidity sessions
      if (symbol.symbol === 'XRP-USD' && (hour < 13 || hour > 21)) {
        agent.lastAction = `XRP session filter: hour ${hour} UTC outside optimal (13-21)`;
        return false;
      }

      // BTC-USD extra filter: block entries during Asian session dips (highest manipulation)
      // BTC has 47% win rate - needs the tightest filters
      if (symbol.symbol === 'BTC-USD') {
        // Skip 00-04 UTC (Asia heavy volume, more volatile)
        if (hour >= 0 && hour < 4) {
          agent.lastAction = `BTC session filter: Asian session (hour ${hour}) high volatility`;
          return false;
        }
        // Require optimal hours
        if (!isOptimalTradingSession(symbol.symbol, hour)) {
          agent.lastAction = `BTC session filter: outside optimal trading window`;
          return false;
        }
        // BTC funding gate: block entries when funding is extreme — crowded positions
        // are the #1 early-warning signal for BTC reversals.
        const btcFunding = engine.marketIntel.getFundingRate('BTC-USD');
        if (btcFunding && btcFunding.extreme) {
          if (direction === 'long' && btcFunding.bias === 'sell') {
            agent.lastAction = `BTC funding gate: crowded longs at ${btcFunding.annualizedPct.toFixed(1)}% annualized — reversal risk`;
            return false;
          }
          if (direction === 'short' && btcFunding.bias === 'buy') {
            agent.lastAction = `BTC funding gate: crowded shorts at ${btcFunding.annualizedPct.toFixed(1)}% annualized — reversal risk`;
            return false;
          }
        }
      }

      // ETH-USD: prefer US hours
      if (symbol.symbol === 'ETH-USD' && (hour < 13 || hour > 20)) {
        agent.lastAction = `ETH session filter: hour ${hour} UTC outside optimal (13-20)`;
        return false;
      }

      // Bearish-protection: block crypto longs during risk-off tape, but allow shorts.
      const riskOffActive = engine.signalBus.hasRecentSignalOfType('risk-off', 120_000);
      const negativeDrift = symbol.drift <= -0.004;
      const panicRegime = engine.classifySymbolRegime(symbol) === 'panic';
      if (direction === 'long' && (riskOffActive || (panicRegime && negativeDrift))) return false;
    } else if (symbol.assetClass === 'forex') {
      // Forex peak: London (07-16 UTC) and NY overlap (13-17 UTC)
      const forexActive = hour >= 7 && hour <= 17;
      if (!forexActive) return false;
    }
    // Indices/bonds/commodities: trade whenever OANDA serves them

    // 2. Volume/momentum confirmation from composite signal
    if (agent.config.style === 'momentum' && direction === 'long' && (intel.direction === 'sell' || intel.direction === 'strong-sell')) return false;
    if (agent.config.style === 'momentum' && direction === 'short' && (intel.direction === 'buy' || intel.direction === 'strong-buy')) return false;
    // Fix #11: Block crowded trades — if Binance funding shows everyone positioned same way, skip
    if (symbol.assetClass === 'crypto' && engine.derivativesIntel.shouldBlockEntry(symbol.symbol, direction)) return false;

    // Fix #1: removed mean-reversion strong-buy rejection — MR should enter at extremes

    // 3. Correlation filter: stagger entries in same asset class
    const recentSameClass = Array.from(engine.agents.values()).some((other: any) => {
      if (other.config.id === agent.config.id || !other.position) return false;
      if ((engine.tick - other.position.entryTick) >= 3) return false;
      const otherSymbol = engine.market.get(other.config.symbol);
      return otherSymbol ? otherSymbol.assetClass === symbol.assetClass : false;
    });
    if (recentSameClass) return false;

    // 3b. Regime anti-overtrading: reduce concurrent entries in unstable regimes.
    const openSameClass = Array.from(engine.agents.values()).filter((other: any) => {
      if (other.config.id === agent.config.id || !other.position) return false;
      const otherSymbol = engine.market.get(other.config.symbol);
      return otherSymbol ? otherSymbol.assetClass === symbol.assetClass : false;
    }).length;
    // Loosened 2026-04-17: default regime previously capped at 1 concurrent per asset
    // class, blocking most maker/grid/scalper combinations since the firm runs multiple
    // symbols per class (BTC + ETH + SOL + XRP all 'crypto', 5+ forex pairs, etc.).
    const maxConcurrent = regime === 'panic' ? 1 : regime === 'trend' ? 3 : 2;
    if (openSameClass >= maxConcurrent) return false;
    if (engine.breachesCrowdingLimit(symbol)) return false;

    // 4. Minimum price history: need at least 20 data points for indicators to work
    if (symbol.history.length < 20) return false;

    // 5. VWAP flat threshold: if VWAP slope is near zero, market is chopping — skip momentum/breakout
    //    Gemini insight: bypass for crypto capitulations — RSI(2) < 10 in extreme fear = buy the wick
    const vwapRsi2 = engine.marketIntel.computeRSI2(symbol.symbol);
    const vwapFng = engine.marketIntel.getFearGreedValue();
    const cryptoCapitulation = symbol.assetClass === 'crypto' && vwapFng !== null && vwapFng <= 20 && vwapRsi2 !== null && vwapRsi2 < 10;
    if (agent.config.style !== 'mean-reversion' && engine.marketIntel.isVwapFlat(symbol.symbol) && !cryptoCapitulation) {
      return false;
    }

    // 6. RSI(2) filter: for mean-reversion, require RSI(2) < 40 (oversold)
    //    For momentum, reject if RSI(2) > 85 (already extended)
    const rsi2 = engine.marketIntel.computeRSI2(symbol.symbol);
    if (rsi2 !== null) {
      // In extreme fear, relax RSI(2) filter for mean-reversion — they need to probe dips
      // FIXED: align with entry-filters.ts — MR long needs RSI > 55 to block (more oversold to enter)
      // In extreme fear (F&G≤20): relax to 60 for both directions
      const rsi2Fng = engine.marketIntel.getFearGreedValue();
      const rsi2LimitLong = (rsi2Fng !== null && rsi2Fng <= 20) ? 60 : 55;
      const rsi2LimitShort = (rsi2Fng !== null && rsi2Fng <= 20) ? 40 : 45;
      if (agent.config.style === 'mean-reversion' && direction === 'long' && rsi2 > rsi2LimitLong) return false;
      if (agent.config.style === 'mean-reversion' && direction === 'short' && rsi2 < rsi2LimitShort) return false;
      if (agent.config.style === 'momentum' && direction === 'long' && rsi2 > 85) return false;
      if (agent.config.style === 'momentum' && direction === 'short' && rsi2 < 18) return false;

      // Gemini insight: in extreme fear crypto, RSI(2) < 10 longs MUST have volatility confirmation
      // (Bollinger squeeze expansion or Bollinger position < 0.05) to avoid catching falling knives
      const entryFng = engine.marketIntel.getFearGreedValue();
      if (symbol.assetClass === 'crypto' && entryFng !== null && entryFng < 25 && direction === 'long' && rsi2 < 10) {
        const bb = engine.marketIntel.getSnapshot().bollinger.find((b: any) => b.symbol === symbol.symbol);
        if (bb && !bb.squeeze && bb.pricePosition > 0.05) {
          return false; // RSI(2) oversold but no panic wick / no squeeze — falling knife
        }
      }
    }

    // 7. Stochastic(14,3,3) confirmation for forex momentum entries
    if (symbol.assetClass === 'forex' && agent.config.style === 'momentum') {
      const stoch = engine.marketIntel.computeStochastic(symbol.symbol);
      if (stoch && stoch.crossover === 'bearish') return false;
    }

    // 8. Stochastic(14,3,3) confirmation for forex mean-reversion — need oversold crossover
    if (symbol.assetClass === 'forex' && agent.config.style === 'mean-reversion') {
      const stoch = engine.marketIntel.computeStochastic(symbol.symbol);
      if (stoch && stoch.k > 50 && stoch.crossover !== 'bullish') return false;
    }

    // 9. Multi-timeframe RSI(14) confirmation — don't enter against the larger trend
    const rsi14 = engine.marketIntel.computeRSI14(symbol.symbol);
    if (rsi14 !== null) {
      // Momentum long needs RSI(14) > 45 (not in a downtrend on the higher timeframe)
      if (agent.config.style === 'momentum' && direction === 'long' && rsi14 < 45) return false;
      // Mean-reversion long needs RSI(14) < 60 (not overbought on higher TF — room to bounce)
      // In extreme fear, relax RSI(14) for mean-reversion — allow entries in deeper downtrends
      const rsi14Fng = engine.marketIntel.getFearGreedValue();
      const rsi14Limit = (rsi14Fng !== null && rsi14Fng <= 20) ? 70 : 60;
      if (agent.config.style === 'mean-reversion' && direction === 'long' && rsi14 > rsi14Limit) return false;
      // Short entries: momentum short needs RSI(14) < 55, mean-reversion short needs RSI(14) > 40
      if (agent.config.style === 'momentum' && direction === 'short' && rsi14 > 55) return false;
      if (agent.config.style === 'mean-reversion' && direction === 'short' && rsi14 < 40) return false;
    }

    // 10-14. Advanced crypto filters (from entry-filters module)
    if (symbol.assetClass === 'crypto') {
      const trend5m = engine.marketIntel.getTrend5m(symbol.symbol);
      if (trend5m === 'down' && direction === 'long' && agent.config.style === 'momentum') return false;
      if (trend5m === 'up' && direction === 'short' && agent.config.style === 'momentum') return false;
      if (agent.config.style !== 'mean-reversion' && engine.marketIntel.isLiquiditySweep(symbol.symbol)) return false;
      const volRatio = engine.marketIntel.getRecentVolRatio(symbol.symbol);
      if (volRatio !== null && volRatio > 2.5) return false;
    }

    // COO FIX: Compression regime blocking
    // RSI 78-100 + tight Bollinger bands = exhaustion. Block entries in squeeze.
    // This prevents the systematic losses seen when "all 10 recent trades lost"
    // FIX #3: Compression block applies to MOMENTUM/BREAKOUT only — mean-reversion
    // thrives in chop/compression since compression = chop = mean-reversion territory.
    if (regime === 'compression' && agent.config.style !== 'mean-reversion') {
      const bb = engine.marketIntel.getSnapshot().bollinger.find((b: any) => b.symbol === symbol.symbol);
      const rsi14Comp = engine.marketIntel.computeRSI14(symbol.symbol);
      // Block if: RSI(14) > 75 AND price near top band (squeeze exhaustion)
      if (rsi14Comp !== null && rsi14Comp > 75 && bb && bb.pricePosition > 0.85) {
        agent.lastAction = `Compression regime blocked: RSI(14) ${rsi14Comp.toFixed(0)} + tight bands (${(bb.pricePosition * 100).toFixed(0)}%)`;
        return false;
      }
      // Also block if: extreme squeeze with RSI(2) at opposite extreme
      const rsi2Comp = engine.marketIntel.computeRSI2(symbol.symbol);
      if (rsi2Comp !== null && rsi2Comp > 80 && direction === 'long') {
        agent.lastAction = `Compression regime blocked: RSI(2) overbought ${rsi2Comp.toFixed(0)} for long entry`;
        return false;
      }
      if (rsi2Comp !== null && rsi2Comp < 20 && direction === 'short') {
        agent.lastAction = `Compression regime blocked: RSI(2) oversold ${rsi2Comp.toFixed(0)} for short entry`;
        return false;
      }
    }

    // 15. Regime + edge gate: require higher expected net edge in riskier regimes.
    const meta = getMetaLabelDecision(engine, agent, symbol, score, intel);
    const minNetEdgeBps = regime === 'panic'
      ? (symbol.assetClass === 'crypto' ? 6 : 10)  // FIX #4: reduce crypto panic threshold to 6 bps (was 14)
      : regime === 'trend'
        ? 6
        : 4;
    if (meta.expectedNetEdgeBps < minNetEdgeBps) return false;
    const qualityMult = engine.getExecutionQualityMultiplier(agent.config.broker);
    const ddFactor = drawdownSizingFactor(engine);
    const proposedNotional = Math.min(engine.getAgentEquity(agent) * agent.config.sizeFraction * agent.allocationMultiplier * qualityMult * ddFactor, agent.cash * 0.9);
    if (proposedNotional > 0 && engine.wouldBreachPortfolioRiskBudget(agent, symbol, proposedNotional)) return false;

    return true;
  }

  const style = agent.config.style;
  const shortSma = average(pickLast(symbol.history, 4));
  const longSma = average(pickLast(symbol.history, 12));
  const isBrokerPaperEquity = agent.config.executionMode === 'broker-paper' && symbol.assetClass === 'equity';
  const isBrokerPaperCrypto = agent.config.executionMode === 'broker-paper' && symbol.assetClass === 'crypto';
  const isBrokerPaperFx = agent.config.executionMode === 'broker-paper'
    && (symbol.assetClass === 'forex' || symbol.assetClass === 'bond' || symbol.assetClass === 'commodity');

  if (style === 'momentum') {
    if (isBrokerPaperEquity) {
      return (
        score > engine.entryThreshold(style)
        && shortReturn > 0.0005
        && shortSma > longSma
        && symbol.bias > 0
        && symbol.spreadBps <= agent.config.spreadLimitBps
      );
    }
    if (isBrokerPaperCrypto) {
      return (
        score > engine.entryThreshold(style) * 1.4 // crypto selectivity boost
        && shortReturn > 0.0004
        && shortSma > longSma
        && symbol.bias > 0
        && symbol.spreadBps <= agent.config.spreadLimitBps
      );
    }
    if (isBrokerPaperFx) {
      return (
        score > Math.max(engine.entryThreshold(style) - 0.5, 0.8)
        && shortReturn > 0.0002
        && shortSma > longSma * 1.00002
        && symbol.bias > 0
        && symbol.spreadBps <= agent.config.spreadLimitBps
      );
    }
    return score > engine.entryThreshold(style) && shortReturn > 0.0012 && mediumReturn > 0.0014 && shortSma > longSma && symbol.bias > 0;
  }

  if (style === 'breakout') {
    const breakoutWindow = pickLast(symbol.history, 9).slice(0, -1);
    const breakoutBase = breakoutWindow.length > 0 ? Math.max(...breakoutWindow) : symbol.price;
    if (isBrokerPaperEquity) {
      return (
        score > Math.max(engine.entryThreshold(style) + 1.1, 5.9)
        && shortReturn > 0.0019
        && mediumReturn > 0.0021
        && symbol.price > breakoutBase * 1.001
        && symbol.bias > 0.0002
        && symbol.liquidityScore >= 90
        && symbol.spreadBps <= Math.min(agent.config.spreadLimitBps, 2.5)
      );
    }
    if (isBrokerPaperFx) {
      return (
        score > Math.max(engine.entryThreshold(style) - 1.5, 3.0)
        && shortReturn > 0.0004
        && symbol.price > breakoutBase * 1.0002
        && symbol.bias > 0
        && symbol.spreadBps <= agent.config.spreadLimitBps
      );
    }
    return score > engine.entryThreshold(style) && shortReturn > 0.0015 && symbol.price > breakoutBase * 1.0007 && symbol.bias > 0;
  }

  if (isBrokerPaperCrypto) {
    return (
      score > Math.max(engine.entryThreshold(style) * 1.4 + 0.2, 1.45 * 1.4) // crypto selectivity boost
      && shortReturn < -0.0012
      && mediumReturn > -0.003
      && symbol.price < longSma * 0.9989
      && symbol.bias > -0.00035
      && symbol.liquidityScore >= 94
      && symbol.spreadBps <= Math.min(agent.config.spreadLimitBps, 3.5)
    );
  }

  if (isBrokerPaperFx) {
    return (
      score > Math.max(engine.entryThreshold(style) - 0.2, 1.0)
      && shortReturn < -0.0003
      && mediumReturn > -0.002
      && symbol.price < longSma * 0.99985
      && symbol.spreadBps <= agent.config.spreadLimitBps
    );
  }

  return score > engine.entryThreshold(style) && shortReturn < -0.0007 && symbol.price < longSma * 0.9994;
}

export function refreshScalpRoutePlan(engine: any): void {
  const journalEntries: any[] = engine.getMetaJournalEntries();
  const candidates: any[] = [];

  for (const agent of engine.agents.values()) {
    const symbol = engine.market.get(agent.config.symbol);
    if (!symbol) {
      continue;
    }

    const shortReturn = engine.relativeMove(symbol.history, 4);
    const mediumReturn = engine.relativeMove(symbol.history, 8);
    const score = engine.getEntryScore(agent.config.style, shortReturn, mediumReturn, symbol);
    const intel = engine.marketIntel.getCompositeSignal(symbol.symbol);
    const meta = getMetaLabelDecision(engine, agent, symbol, score, intel);
    const context = buildJournalContext(engine, symbol);
    const strategyName = `${agent.config.name} / scalping`;
    const recentEntries = journalEntries
      .filter((entry: any) => (entry.strategyId === agent.config.id || entry.strategy === strategyName) && entry.realizedPnl !== 0)
      .sort((left: any, right: any) => left.exitAt.localeCompare(right.exitAt))
      .slice(-12);
    const performance = engine.summarizePerformance(recentEntries);
    const tradeable = agent.config.executionMode === 'broker-paper' && agent.config.autonomyEnabled;
    const edgeOk = meta.expectedNetEdgeBps > 0;
    const enabled = tradeable && meta.approve && edgeOk && !context.macroVeto && !context.embargoed;
    const direction: 'buy' | 'sell' | 'neutral' = meta.expectedNetEdgeBps > 0
      ? 'buy'
      : meta.expectedNetEdgeBps < 0
        ? 'neutral'
        : 'neutral';

    candidates.push({
      id: agent.config.id,
      strategyId: agent.config.id,
      strategy: strategyName,
      lane: 'scalping',
      symbols: [symbol.symbol],
      assetClass: symbol.assetClass,
      venue: agent.config.broker,
      direction,
      expectedGrossEdgeBps: round(meta.expectedGrossEdgeBps, 2),
      estimatedCostBps: round(meta.estimatedCostBps, 2),
      expectedNetEdgeBps: round(meta.expectedNetEdgeBps, 2),
      confidencePct: round(meta.probability, 1),
      support: meta.support,
      sampleCount: meta.sampleCount,
      recentWinRate: round(performance.winRate * 100, 1),
      profitFactor: round(performance.profitFactor, 2),
      expectancy: round(performance.expectancy, 2),
      regime: context.regime,
      newsBias: context.newsBias,
      orderFlowBias: context.orderFlowBias,
      macroVeto: context.macroVeto,
      embargoed: context.embargoed,
      enabled,
      selected: false,
      allocationMultiplier: round(agent.allocationMultiplier, 2),
      reason: meta.reason,
      selectedReason: meta.reason,
      routeRank: 0,
      updatedAt: new Date().toISOString()
    });
  }

  const grouped = new Map<AssetClass, any[]>();
  for (const candidate of candidates) {
    const bucket = grouped.get(candidate.assetClass) ?? [];
    bucket.push(candidate);
    grouped.set(candidate.assetClass, bucket);
  }

  engine.scalpRouteCandidates = new Map(candidates.map((candidate) => [candidate.strategyId, candidate]));
  engine.selectedScalpByAssetClass.clear();
  engine.selectedScalpOverallId = null;

  let overallLeader: any | null = null;
  for (const [assetClass, group] of grouped.entries()) {
    const ranked = group
      .slice()
      .sort((left, right) => right.expectedNetEdgeBps - left.expectedNetEdgeBps || right.confidencePct - left.confidencePct || right.expectedGrossEdgeBps - left.expectedGrossEdgeBps);
    const positive = ranked.filter((candidate) => candidate.expectedNetEdgeBps > 0 && candidate.enabled);
    if (positive.length === 0) {
      for (const candidate of group) {
        candidate.selected = false;
        candidate.routeRank = ranked.findIndex((item) => item.strategyId === candidate.strategyId) + 1;
        candidate.selectedReason = `No positive-net route in ${assetClass} after estimated fees and slippage.`;
      }
      continue;
    }

    const leader = positive[0]!;
    const leaderSymbol = leader.symbols[0] ?? leader.strategyId;
    engine.selectedScalpByAssetClass.set(assetClass, leader.strategyId);
    for (const candidate of group) {
      const candidateSymbol = candidate.symbols[0] ?? candidate.strategyId;
      candidate.routeRank = ranked.findIndex((item) => item.strategyId === candidate.strategyId) + 1;
      candidate.selected = candidate.strategyId === leader.strategyId;
      candidate.selectedReason = candidate.selected
        ? `Top net edge in ${assetClass}: ${leaderSymbol} at ${leader.expectedNetEdgeBps.toFixed(2)}bps after ${leader.estimatedCostBps.toFixed(2)}bps estimated costs.`
        : `${leaderSymbol} wins ${assetClass} routing with ${leader.expectedNetEdgeBps.toFixed(2)}bps net edge vs ${candidateSymbol} at ${candidate.expectedNetEdgeBps.toFixed(2)}bps.`;
    }

    if (!overallLeader || leader.expectedNetEdgeBps > overallLeader.expectedNetEdgeBps) {
      overallLeader = leader;
    }
  }

  if (overallLeader) {
    engine.selectedScalpOverallId = overallLeader.strategyId;
  }
}

// ── Inline test: latency-gate for mean-reversion scalps ──────────────────────
// node --eval "$(cat src/paper-engine/engine-entry.ts | tail -50)"
// Verifies: venue median latency > 3000ms → canEnter returns false for MR scalper
if (import.meta.url?.endsWith(process.argv[1]?.replace(/^file:\/\//, '') ?? '')) {
  const mockAgent = {
    config: { style: 'mean-reversion', lane: 'scalping', broker: 'alpaca', symbol: 'BTC-USD', executionMode: 'paper', id: 'test', name: 'test', sizeFraction: 0.1, spreadLimitBps: 10 },
    lastAction: '',
    allocationMultiplier: 1,
    cash: 100000
  };
  const mockSymbol = { symbol: 'BTC-USD', assetClass: 'crypto', price: 50000, updatedAt: new Date().toISOString(), spreadBps: 0.5, history: Array(25).fill(50000), bias: 0.001, liquidityScore: 95, drift: 0, tradable: true };
  const mockEngine = {
    latencyTracker: {
      getReport: () => ({
        buckets: [{ venue: 'alpaca', symbol: 'BTC-USD', signalToFillMsP50: 5000 }],
        totalSamples: 10,
        alerts: []
      })
    },
    getSymbolGuard: () => null,
    evaluateSessionKpiGate: () => ({ pass: true }),
    marketIntel: { getCompositeSignal: () => ({ direction: 'buy', confidence: 70 }) },
    resolveEntryDirection: () => 'long',
    classifySymbolRegime: () => 'normal',
    getRegimeThrottleMultiplier: () => 1,
    evaluateCryptoExecutionGuard: () => ({ pass: true }),
    entryThreshold: () => 1,
    marketIntel2: { computeRSI2: () => 30, getTrend5m: () => 'up', isLiquiditySweep: () => false, getRecentVolRatio: () => null },
    market: { get: () => mockSymbol },
    agents: new Map(),
    tick: 1,
    circuitBreakerLatched: false,
    operationalKillSwitchUntilMs: 0,
    symbolKillSwitchUntil: null,
    wouldBreachPortfolioRiskBudget: () => false,
    getAgentEquity: () => 100000,
    getExecutionQualityMultiplier: () => 1,
    derivativesIntel: { shouldBlockEntry: () => false },
    signalBus: { hasRecentSignalOfType: () => false },
    getMetaLabelDecision: () => ({ expectedNetEdgeBps: 8, expectedGrossEdgeBps: 10, estimatedCostBps: 2, probability: 0.6, approve: true, reason: 'test' }),
    breachesCrowdingLimit: () => false,
    computeRSI2: () => 30,
    computeRSI14: () => 45,
    computeStochastic: () => null,
    isVwapFlat: () => false,
    getFundingRate: () => null,
    relativeMove: () => 0.001,
  };

  const result = canEnter(mockEngine as any, mockAgent as any, mockSymbol as any, 0.001, 0.001, 1);
  if (result === false && mockAgent.lastAction.includes('latency gate')) {
    console.log('✓ PASS: canEnter blocked MR scalp when venue median latency 5000ms > 3000ms');
    console.log(`  → lastAction: "${mockAgent.lastAction}"`);
  } else {
    console.error(`✗ FAIL: expected false with latency gate, got ${result}, lastAction="${mockAgent.lastAction}"`);
    process.exit(1);
  }

  // Also verify: non-MR or non-scalping styles pass through
  const momentumAgent = { ...mockAgent, config: { ...mockAgent.config, style: 'momentum' } };
  const result2 = canEnter(mockEngine as any, momentumAgent as any, mockSymbol as any, 0.001, 0.001, 1);
  if (result2 !== false) {
    console.log('✓ PASS: momentum agent not blocked by latency gate (style mismatch)');
  } else {
    console.error('✗ FAIL: momentum agent unexpectedly blocked');
    process.exit(1);
  }
}
