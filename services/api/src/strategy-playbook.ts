/**
 * Strategy Playbook
 *
 * A typed database of regime-tagged strategy templates.
 * The Strategy Director selects the best template per agent/symbol
 * based on the detected market regime and applies it via applyAgentConfig().
 *
 * Sources:
 *   - Freqtrade community strategies (MIT) — compression/volatility patterns
 *   - Academic: Bollinger, Dual Momentum (Antonacci), VWAP scalping
 *   - OctoBot grid patterns (inspiration) — range/compression grids
 *   - QuantConnect LEAN community — event and trend templates
 */

export type MarketRegime =
  | 'compression'   // Flat, low volatility, no trend — BTC scenario right now
  | 'trending-up'   // Strong uptrend, momentum carries
  | 'trending-down' // Strong downtrend, short-momentum or defensive
  | 'volatile'      // High vol, large candles, unpredictable swings
  | 'range-bound'   // Clear horizontal range, bounces between support/resistance
  | 'news-driven'   // Event / headline risk active
  | 'panic'         // Liquidation cascade or fear spike
  | 'unknown';      // Insufficient data

export type AssetClass = 'crypto' | 'equity' | 'forex' | 'bond' | 'commodity';

export type AgentStyle = 'momentum' | 'mean-reversion' | 'breakout';

export interface StrategyTemplate {
  id: string;
  name: string;
  description: string;
  regime: MarketRegime;
  assetClasses: AssetClass[];  // which asset classes this applies to
  source: string;              // attribution

  // Config overrides to apply to agents via applyAgentConfig()
  style: AgentStyle;
  targetBps: number;
  stopBps: number;
  maxHoldTicks: number;
  cooldownTicks: number;
  sizeFraction: number;
  spreadLimitBps: number;

  // Execution guidance (for Strategy Director reasoning)
  rationale: string;
  edgeConditions: string[];    // conditions under which this has edge
  avoidConditions: string[];   // conditions to NOT apply this
  priority: number;            // 1 = highest priority within regime
}

/**
 * The master strategy playbook.
 *
 * Templates are listed in priority order within each regime.
 * Strategy Director picks the highest-priority applicable template.
 */
export const STRATEGY_PLAYBOOK: StrategyTemplate[] = [

  // ─────────────────────────────────────────────────────────────────────
  // COMPRESSION regime: flat, no momentum, low vol
  // Goal: don't fight the tape. Use tight range-bound or mean-revert plays.
  // Source: Freqtrade BBRSIOptimizedStrategy + OctoBot grid inspiration
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'compression-bollinger-revert',
    name: 'Bollinger Mean-Reversion (Compression)',
    description: 'Buy at lower Bollinger band, sell at upper. No momentum trades. Works in tight ranges.',
    regime: 'compression',
    assetClasses: ['crypto', 'forex', 'equity', 'commodity'],
    source: 'Academic + Freqtrade BBRSIOptimized',
    style: 'mean-reversion',
    targetBps: 12,    // tiny targets — just bounce capture
    stopBps: 10,      // tight stops, chop destroys wide stops
    maxHoldTicks: 30, // get in, get out fast
    cooldownTicks: 8, // wait longer between trades, fewer signals are valid
    sizeFraction: 0.04, // smaller size — lower conviction regime
    spreadLimitBps: 3,
    rationale: 'In compression, price oscillates around a mean. Bollinger bands act as natural reversal anchors. Momentum and breakout strategies have no edge here.',
    edgeConditions: [
      'Price at or beyond lower/upper Bollinger band',
      'Bollinger bandwidth in bottom 20% of recent range (squeeze)',
      'Order flow neutral or contra-directional',
      'No macro or news embargo active',
    ],
    avoidConditions: [
      'Score near zero or low (no setup)',
      'Spreads expanding (risk-off)',
      'News embargo active',
    ],
    priority: 1,
  },
  {
    id: 'compression-grid-tight',
    name: 'Tight Grid Scalp (Compression)',
    description: 'Micro grid entries on repeated oscillation. Tiny targets, fast exits. Cash-preservation mode for no-edge conditions.',
    regime: 'compression',
    assetClasses: ['crypto', 'forex'],
    source: 'OctoBot grid strategy inspiration',
    style: 'mean-reversion',
    targetBps: 8,
    stopBps: 8,
    maxHoldTicks: 20,
    cooldownTicks: 12,
    sizeFraction: 0.03, // very small — 1:1 R:R is just for data collection
    spreadLimitBps: 2,
    rationale: 'When nothing else works, a tight grid captures micro mean-reversion while capping max loss per trade. This is "stay active without blowing up" mode.',
    edgeConditions: [
      'Bollinger bandwidth extremely tight (true squeeze)',
      'Volume low and declining',
      'Spread stable and narrow',
    ],
    avoidConditions: [
      'Any news or macro veto active',
      'Spread expanding',
      'Volume spike (suggests breakout imminent)',
    ],
    priority: 2,
  },
  {
    id: 'compression-cash',
    name: 'Cash / Watch-Only (No-Edge Compression)',
    description: 'When compression score is near zero and no Bollinger setup exists — zero trades, full cooldown.',
    regime: 'compression',
    assetClasses: ['crypto', 'equity', 'forex', 'bond', 'commodity'],
    source: 'First Principles',
    style: 'mean-reversion',
    targetBps: 12,
    stopBps: 10,
    maxHoldTicks: 5,
    cooldownTicks: 30, // effectively park the agent
    sizeFraction: 0.01, // fractional — nearly zero
    spreadLimitBps: 1,  // nothing will pass this spread gate
    rationale: 'No trade is a valid trade. When regime offers no edge and all agents are being rejected, shrink size to near-zero and extend cooldown until regime shifts.',
    edgeConditions: [
      'Firm-level "go to cash" signal from Strategy Director',
      'BTC momentum score near zero for 3+ cycles',
    ],
    avoidConditions: [
      'Any positive composite signal exists',
    ],
    priority: 3,
  },

  // ─────────────────────────────────────────────────────────────────────
  // TRENDING-UP regime: sustained upward move
  // Goal: ride trends, wider targets, trail stops
  // Source: Dual Momentum (Antonacci) + Man AHL trend following inspiration
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'trending-up-dual-momentum',
    name: 'Dual Momentum Trend-Follow (Trending Up)',
    description: 'Strong relative + absolute momentum. Wide targets, wider stops to let winners run.',
    regime: 'trending-up',
    assetClasses: ['crypto', 'equity'],
    source: 'Academic: Antonacci Dual Momentum + QuantConnect LEAN',
    style: 'momentum',
    targetBps: 45,
    stopBps: 25,
    maxHoldTicks: 120,
    cooldownTicks: 4,
    sizeFraction: 0.07,
    spreadLimitBps: 6,
    rationale: 'When both short-term and medium-term returns are positive, ride the momentum. Momentum has documented academic edge during sustained trends.',
    edgeConditions: [
      'SMA20 > SMA50 (bull trend)',
      'Short-term return > 0.5% over 4 ticks',
      'Medium-term return > 0.3% over 8 ticks',
      'Order flow bullish or neutral',
    ],
    avoidConditions: [
      'News-driven volatility spike',
      'Macro veto active',
      'Spread > baseline * 2',
    ],
    priority: 1,
  },
  {
    id: 'trending-up-vwap-pull',
    name: 'VWAP Pullback Entry (Trending Up)',
    description: 'Wait for a pullback to VWAP in an established uptrend, then enter long.',
    regime: 'trending-up',
    assetClasses: ['equity', 'crypto'],
    source: 'Academic: VWAP scalping (common in prop firms)',
    style: 'momentum',
    targetBps: 30,
    stopBps: 18,
    maxHoldTicks: 60,
    cooldownTicks: 5,
    sizeFraction: 0.06,
    spreadLimitBps: 4,
    rationale: 'VWAP is the institutional fair-value anchor. Pullbacks to VWAP on light volume in uptrends are reliable entry points with defined risk.',
    edgeConditions: [
      'Price dips below VWAP by 0.1-0.3%',
      'Underlying trend still intact (SMA20 > SMA50)',
      'Volume decreasing on pullback (healthy correction)',
    ],
    avoidConditions: [
      'High news risk',
      'Volume spike on pullback (distribution)',
    ],
    priority: 2,
  },

  // ─────────────────────────────────────────────────────────────────────
  // TRENDING-DOWN regime: sustained downward move
  // Goal: defensive sizing, short momentum, avoid catching knives
  // Source: Risk parity + short momentum academic
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'trending-down-defensive',
    name: 'Defensive Mean-Reversion (Trending Down)',
    description: 'Short-only mean-reversion at Bollinger upper band. Tighter stops, reduced size.',
    regime: 'trending-down',
    assetClasses: ['crypto', 'equity', 'commodity'],
    source: 'Academic: Trend-following defensive + Freqtrade',
    style: 'mean-reversion',
    targetBps: 20,
    stopBps: 14,
    maxHoldTicks: 40,
    cooldownTicks: 8,
    sizeFraction: 0.04,
    spreadLimitBps: 4,
    rationale: 'In downtrends, only take entries that agree with the directional flow. Mean-reversion at upper Bollinger (overbought in downtrend) has edge. Do not buy dips — dips become lower lows.',
    edgeConditions: [
      'Price at or above upper Bollinger band',
      'Order flow bearish',
      'SMA20 < SMA50',
    ],
    avoidConditions: [
      'Extreme fear on Fear & Greed (contrarian buy setup forming)',
      'News embargo active',
    ],
    priority: 1,
  },
  {
    id: 'trending-down-cash',
    name: 'Risk-Off / Cash (Trending Down)',
    description: 'Minimal trading. Reduce exposure globally during confirmed downtrend. Crypto weakness + macro hostility.',
    regime: 'trending-down',
    assetClasses: ['crypto', 'equity', 'forex', 'bond', 'commodity'],
    source: 'Risk Parity principle',
    style: 'mean-reversion',
    targetBps: 15,
    stopBps: 10,
    maxHoldTicks: 15,
    cooldownTicks: 20,
    sizeFraction: 0.025,
    spreadLimitBps: 2,
    rationale: 'When the whole market is falling and macro is hostile, the best trade is no trade. Shrink size and wait.',
    edgeConditions: [
      'Multiple assets trending down simultaneously',
      'Macro veto active',
      'Risk-off signal from signal bus (75%+ symbols negative)',
    ],
    avoidConditions: [
      'Fear & Greed in extreme fear (contrarian setup)',
    ],
    priority: 2,
  },

  // ─────────────────────────────────────────────────────────────────────
  // VOLATILE regime: large candles, unpredictable, high vol
  // Goal: wider stops to survive noise, reduced size, mean-reversion only
  // Source: Freqtrade volatile strategies + academic wide-stop reversion
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'volatile-wide-stop-reversion',
    name: 'Wide-Stop Mean-Reversion (Volatile)',
    description: 'Bollinger mean-reversion with wider stops to survive volatile swings. Half normal size.',
    regime: 'volatile',
    assetClasses: ['crypto', 'equity', 'commodity'],
    source: 'Freqtrade: NostalgiaForInfinityNext + academic vol-adjusted reversion',
    style: 'mean-reversion',
    targetBps: 25,
    stopBps: 35,  // wider stop to survive vol
    maxHoldTicks: 50,
    cooldownTicks: 10,
    sizeFraction: 0.035, // half normal size — vol kills position sizing
    spreadLimitBps: 8,   // allow wider spreads since vol is high
    rationale: 'High volatility means wider Bollinger bands and wider swings. Mean-reversion still works but needs wider stops and smaller size. Momentum and breakout are dangerous in volatile, whipsaw conditions.',
    edgeConditions: [
      'Price at extreme Bollinger band (>60% position)',
      'Volume spike confirming extreme',
      'Fear & Greed in extreme fear (if buying) or extreme greed (if selling)',
    ],
    avoidConditions: [
      'Spread expansion (liquidity crisis)',
      'News embargo active',
      'Macro veto active',
    ],
    priority: 1,
  },
  {
    id: 'volatile-vixy-momentum',
    name: 'VIX Fear Spike Momentum (Volatile)',
    description: 'Buy VIXY/volatility proxy on spike entries during market panic. Specialized for VIXY agent.',
    regime: 'volatile',
    assetClasses: ['equity'],
    source: 'Proprietary: volatility-regime momentum',
    style: 'momentum',
    targetBps: 100,
    stopBps: 50,
    maxHoldTicks: 40,
    cooldownTicks: 12,
    sizeFraction: 0.04,
    spreadLimitBps: 20,
    rationale: 'VIXY spikes during market panic. This template is only for volatility instruments. When the rest of the portfolio is in defensive mode, VIXY can provide positive returns from fear.',
    edgeConditions: [
      'Risk-off signal from signal bus',
      'Multiple symbols negative simultaneously',
      'Fear & Greed rapidly declining',
    ],
    avoidConditions: [
      'Calm trending markets',
      'Greed regime',
    ],
    priority: 2,
  },

  // ─────────────────────────────────────────────────────────────────────
  // RANGE-BOUND regime: clear support/resistance, horizontal price action
  // Goal: pairs trading, spread capture, range oscillation
  // Source: Academic pairs trading + stat-arb principles
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'range-bound-pairs-spread',
    name: 'Pairs Spread Capture (Range-Bound)',
    description: 'Trade mean-reversion of the BTC/ETH spread. Not directional — market-neutral.',
    regime: 'range-bound',
    assetClasses: ['crypto'],
    source: 'Academic: Statistical Arbitrage / Pairs Trading',
    style: 'mean-reversion',
    targetBps: 15,
    stopBps: 12,
    maxHoldTicks: 40,
    cooldownTicks: 6,
    sizeFraction: 0.05,
    spreadLimitBps: 3,
    rationale: 'In range-bound markets, correlated pairs oscillate around a cointegrated spread. Z-score reversion of the spread provides market-neutral edge regardless of direction.',
    edgeConditions: [
      'BTC and ETH both in range-bound regime',
      'Correlation > 0.8 between paired assets',
      'Z-score of spread > 1.5 standard deviations',
    ],
    avoidConditions: [
      'Correlation break detected (signal bus)',
      'News specific to one leg only',
    ],
    priority: 1,
  },
  {
    id: 'range-bound-bollinger-scalp',
    name: 'Bollinger Range Scalp (Range-Bound)',
    description: 'Scalp reversals at range boundaries defined by Bollinger bands.',
    regime: 'range-bound',
    assetClasses: ['crypto', 'equity', 'forex', 'commodity'],
    source: 'Academic: Bollinger Band scalping',
    style: 'mean-reversion',
    targetBps: 18,
    stopBps: 12,
    maxHoldTicks: 35,
    cooldownTicks: 6,
    sizeFraction: 0.05,
    spreadLimitBps: 3,
    rationale: 'Range-bound markets have defined upper and lower boundaries. Bollinger bands define these dynamically. Reversal entries at the boundaries with confirmation have consistent edge.',
    edgeConditions: [
      'Price at Bollinger extremes (position < 10% or > 90%)',
      'Order flow contra-directional at extreme',
    ],
    avoidConditions: [
      'Bollinger squeeze detected (impending breakout)',
      'Spread expanding',
    ],
    priority: 2,
  },

  // ─────────────────────────────────────────────────────────────────────
  // NEWS-DRIVEN regime: active headline risk
  // Goal: avoid directional exposure, reduce size, wait for post-event normalization
  // Source: QuantConnect event-embargo strategy pattern
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'news-driven-embargo',
    name: 'Post-Event Wait / Reduced Size (News-Driven)',
    description: 'During active news: shrink size, extend cooldown, wait for resolution. Trade only after normalization.',
    regime: 'news-driven',
    assetClasses: ['crypto', 'equity', 'forex', 'bond', 'commodity'],
    source: 'QuantConnect: Event-Embargo Pattern',
    style: 'mean-reversion',
    targetBps: 15,
    stopBps: 12,
    maxHoldTicks: 20,
    cooldownTicks: 20, // long cooldown — wait for dust to settle
    sizeFraction: 0.03,
    spreadLimitBps: 3,
    rationale: 'News-driven moves are unpredictable in direction and magnitude. The edge is in NOT trading during the initial headline chaos, then re-entering after price normalizes.',
    edgeConditions: [
      'News event has resolved (embargo lifted)',
      'Price returned to pre-event range',
      'Spread normalized back to baseline',
    ],
    avoidConditions: [
      'Embargo still active',
      'News bias opposing trade direction',
      'Spread still elevated from news spike',
    ],
    priority: 1,
  },

  // ─────────────────────────────────────────────────────────────────────
  // PANIC regime: liquidation cascade, extreme fear
  // Goal: survival mode — no new entries unless VIXY/gold
  // Source: First principles risk management
  // ─────────────────────────────────────────────────────────────────────
  {
    id: 'panic-survival',
    name: 'Survival Mode (Panic)',
    description: 'Full defensive posture. Close open positions. No new directional entries. Extend cooldowns to maximum.',
    regime: 'panic',
    assetClasses: ['crypto', 'equity', 'forex', 'bond', 'commodity'],
    source: 'First Principles: Risk Management',
    style: 'mean-reversion',
    targetBps: 10,
    stopBps: 8,
    maxHoldTicks: 5,    // exit fast if in position
    cooldownTicks: 60,  // near lockdown
    sizeFraction: 0.015, // near-zero
    spreadLimitBps: 1,   // nothing will pass this in a panic spread
    rationale: 'Panic/liquidation cascades are the #1 killer of leveraged strategies. Do not fight them. Survive first, re-enter after order is restored.',
    edgeConditions: [
      'After prices have stabilized (recentMove back below 1%)',
      'Spread normalized',
    ],
    avoidConditions: [
      'Spread still elevated from panic (> 2x baseline)',
      'Risk-off signal still active',
    ],
    priority: 1,
  },
];

/**
 * Get the best strategy template for a given regime + asset class.
 * Returns templates in priority order.
 */
export function getTemplatesForRegime(
  regime: MarketRegime,
  assetClass: AssetClass
): StrategyTemplate[] {
  return STRATEGY_PLAYBOOK
    .filter((t) => t.regime === regime && t.assetClasses.includes(assetClass))
    .sort((a, b) => a.priority - b.priority);
}

/**
 * Get the single best template for a given regime + asset class.
 */
export function getBestTemplate(
  regime: MarketRegime,
  assetClass: AssetClass
): StrategyTemplate | null {
  return getTemplatesForRegime(regime, assetClass)[0] ?? null;
}

/**
 * Get all templates sorted by regime and priority.
 */
export function getAllTemplates(): StrategyTemplate[] {
  return [...STRATEGY_PLAYBOOK].sort((a, b) =>
    a.regime.localeCompare(b.regime) || a.priority - b.priority
  );
}

/**
 * Detect the firm-wide regime from aggregated market signals.
 *
 * This is a deterministic classifier — no AI needed. Takes in raw
 * signal data that the Strategy Director already has available.
 */
export function detectFirmRegime(signals: {
  symbolRegimes: Record<string, string>;     // per-symbol regimes from classifySymbolRegime
  bollingerSqueeze: Record<string, boolean>; // per-symbol squeeze
  fearGreedValue: number | null;             // 0-100
  riskOffActive: boolean;                    // from signal bus
  newsEmbargoActive: boolean;                // any active embargo
  macroVetoActive: boolean;                  // macro veto from news intel
  avgVolatility: number;                     // average volatility across symbols
  avgRecentMove: number;                     // average absolute recent move
}): MarketRegime {
  const { symbolRegimes, fearGreedValue, riskOffActive, newsEmbargoActive, macroVetoActive, avgVolatility, avgRecentMove } = signals;

  // Count regime votes from individual symbols
  const regimeCounts: Record<string, number> = {};
  for (const regime of Object.values(symbolRegimes)) {
    regimeCounts[regime] = (regimeCounts[regime] ?? 0) + 1;
  }
  const totalSymbols = Object.values(symbolRegimes).length;

  // PANIC: spread shock, extreme vol, or widespread risk-off
  if (riskOffActive || avgVolatility >= 0.03 || avgRecentMove >= 0.025) {
    return 'panic';
  }

  // NEWS-DRIVEN: active embargo or macro veto
  if (newsEmbargoActive || macroVetoActive) {
    return 'news-driven';
  }

  // VOLATILE: high vol but not full panic
  if (avgVolatility >= 0.012 || avgRecentMove >= 0.015) {
    return 'volatile';
  }

  // COMPRESSION: most symbols compressed
  const compressionCount = (regimeCounts['compression'] ?? 0);
  if (compressionCount / Math.max(totalSymbols, 1) >= 0.5) {
    // Check if extreme fear too — that's a buy signal, not compression
    if (fearGreedValue !== null && fearGreedValue <= 20) {
      return 'volatile'; // fear extreme + compression = impending breakout
    }
    return 'compression';
  }

  // TRENDING
  const trendCount = (regimeCounts['trend'] ?? 0);
  if (trendCount / Math.max(totalSymbols, 1) >= 0.4) {
    // Determine direction by drift aggregate
    const panicCount = (regimeCounts['panic'] ?? 0);
    if (panicCount > 0) return 'trending-down';
    // Use fear/greed to determine up vs down
    if (fearGreedValue !== null) {
      if (fearGreedValue <= 40) return 'trending-down';
      if (fearGreedValue >= 55) return 'trending-up';
    }
    return 'trending-up';
  }

  // RANGE-BOUND: mostly chop, no breakouts
  const chopCount = (regimeCounts['chop'] ?? 0);
  if (chopCount / Math.max(totalSymbols, 1) >= 0.4) {
    return 'range-bound';
  }

  return 'unknown';
}
