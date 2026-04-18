# Hermes Trading Firm - Improvement Analysis

**Generated:** 2026-04-16
**Focus:** Increase win rate, automate missing features, prepare for live trading

---

## Executive Summary

### Trading Performance Analysis (879 trades)

| Symbol | Trades | Win Rate | P&L | Verdict |
|---------|--------|----------|-----|---------|
| XRP-USD | 78 | **74%** | +$166.05 | ⭐ STAR PERFORMER |
| VIXY | 1 | 100% | +$2.98 | Small sample |
| SOL-USD | 10 | 70% | +$3.50 | Good, expand sample |
| ETH-USD | 320 | 61% | +$31.24 | ✅ Good |
| BTC-USD | 470 | 47% | **-$1,105.92** | 🚨 STOP THIS |

**Key Finding:** BTC-USD is destroying your P&L. At 47% win rate with 470 trades, it's lost over $1,100. Either fix the BTC strategy or kill it.

---

## Priority 1: IMMEDIATE WINS (This Week)

### 1.1 Capital Reallocation (High Impact, Low Effort)

**Problem:** Equal capital allocation to all symbols despite vastly different performance.

**Action:**
```typescript
// services/api/src/capital-allocator.ts - Adjust allocation multipliers
const ALLOCATION_MULTIPLIERS = {
  'XRP-USD': 1.5,   // Best performer - press size
  'ETH-USD': 1.2,   // Good performer - slight press
  'BTC-USD': 0.0,    // STOP TRADING - worst performer
  'SOL-USD': 1.0,    // Keep as-is, need more data
};
```

**Expected Impact:** +$50-100/day by stopping BTC losses alone.

---

### 1.2 Fix BTC-USD Entry Logic

**Problem:** BTC-USD has 47% win rate. The code shows it's getting a 1.4x threshold boost but still entering bad setups.

**Root Cause Analysis:**
- Entry threshold boost is applied but not enough
- BTC trades 24/7 with lower volatility windows
- The 4-6 UTC dead zone filter exists but might not be catching the real problem

**Action:** Add stricter BTC filters in `engine-entry.ts`:
```typescript
// In canEnter() for BTC-USD specifically:
// 1. Require higher confidence (>70%)
// 2. Only trade during US market hours (14-21 UTC)
// 3. Require RSI(2) < 30 or > 70 (not neutral)
// 4. Block if recent 3 trades were losers
```

---

### 1.3 Increase XRP-USD Position Size

**Problem:** XRP-USD has 74% win rate but might be under-sized.

**Action:** Double or triple XRP-USD allocation multiplier.

---

## Priority 2: TECHNICAL IMPROVEMENTS (This Month)

### 2.1 Missing Data Signals (Critical Gap)

**What's Missing:**

| Signal | Source | Cost | Impact |
|---------|--------|------|--------|
| Order Flow Imbalance | Binance/Coinbase WebSocket | FREE | High |
| Funding Rates | Binance API | FREE | High |
| Liquidation Heatmap | Coinglass API | FREE tier | High |
| Social Sentiment | LunarCrush | $30/mo | Medium |
| On-Chain Metrics | Glassnode | $29/mo | Medium |

**Recommended Premium APIs:**
1. **Binance WebSocket** - Real-time order book depth (FREE)
2. **Coinglass Liquidation Data** - See where stop hunts happen (FREE)
3. **LunarCrush Social** - Track viral coins before pumps (~$30/mo)

**Implementation:** Add to `services/api/src/market-intel.ts`:
```typescript
// Liquidation detection
async function fetchBinanceLiquidations(symbol: string) {
  const resp = await fetch(`https://api.coinglass.com/api/pro/v1/liquidationheatmap?symbol=${symbol}`);
  // Detect concentrated liquidation walls -> fakeouts
}

// Funding rate tracking
async function fetchFundingRates(symbol: string) {
  const resp = await fetch(`https://api.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
  // High funding = bear funding = shorts paying -> contrarian signal
}
```

---

### 2.2 AI Council Prompt Improvements

**Problem:** AI council has high error rate (Ollama 404s, rate limits) and prompts could be better.

**Current Prompt Weaknesses:**
1. No explicit win rate optimization guidance
2. No regime-specific instructions
3. Missing cost-of-carry awareness for crypto

**Improved Prompt Strategy:**
```typescript
// In ai-council-prompts.ts - Add regime-aware instructions

const IMPROVED_PROMPT_TEMPLATE = `
You are the primary trade reviewer for Hermes.

CRITICAL CONTEXT:
- Current regime: {regime} (panic/trend/normal/compression)
- Our best performing symbol is XRP-USD (74% win rate)
- BTC-USD has 47% win rate - be EXTRA skeptical of BTC entries

WIN RATE OPTIMIZATION:
- Approve only if you believe this trade has >55% chance of profit
- Consider: entry price vs recent range, spread cost, holding time
- Crypto: Account for funding rates (check if longs/shorts paying)
- Reject if: spread > 2x your confidence, neutral RSI(2), choppy tape

RISK-ADJUSTED SCORING:
- If confidence < 60%, default to 'review'
- If confidence > 80% AND spread < 1%, 'approve'
- Always 'reject' if expected loss > 2x expected gain
`;
```

---

### 2.3 Stop-Loss Optimization

**Problem:** Fixed stop-losses don't adapt to volatility.

**Solution:** Implement ATR-based dynamic stops
```typescript
// In engine-trading.ts
function computeDynamicStop(entryPrice: number, atr: number, volatility: number): number {
  // In high volatility (ATR > 2%), widen stops
  // In low volatility, tighten stops
  const atrMultiplier = volatility > 2 ? 2.5 : volatility > 1 ? 2.0 : 1.5;
  return entryPrice * (1 - (atr * atrMultiplier / 100));
}
```

---

### 2.4 Session-Based Trading Filter

**Problem:** Trading 24/7 in crypto when volume/concentration varies wildly.

**Add these time filters:**
```typescript
// Crypto session optimization
const CRYPTO_BEST_HOURS = {
  'XRP-USD': [14, 15, 16, 17, 18, 19, 20, 21], // US market hours
  'BTC-USD': [14, 15, 16, 21, 22, 23, 0, 1],   // US + Asia overlap
  'ETH-USD': [14, 15, 16, 17, 18, 19, 20],       // US hours
};

function isOptimalSession(symbol: string, hour: number): boolean {
  const optimalHours = CRYPTO_BEST_HOURS[symbol];
  if (!optimalHours) return true;
  return optimalHours.includes(hour);
}
```

---

## Priority 3: AUTOMATION GAPS (Next Month)

### 3.1 Missing Automations

| Feature | Status | Priority | Implementation |
|---------|--------|----------|----------------|
| Cross-exchange arbitrage | Basic | HIGH | Compare Binance vs Coinbase for XRP/ETH |
| Funding rate hedging | None | HIGH | Monitor funding, flip when rate > 0.05% |
| Correlation alerts | None | MEDIUM | Warn when 3+ positions correlate |
| Drawdown circuit breaker | Basic | HIGH | Stop ALL trading at -3% daily drawdown |
| Trade journal analysis | None | MEDIUM | Weekly report on win rate by symbol/time |

---

### 3.2 Cross-Exchange Arbitrage

**Opportunity:** XRP and ETH trade on both Coinbase and Binance with price differences.

**Logic:**
```typescript
async function checkArbitrage(symbol: string): Promise<void> {
  const coinbasePrice = await fetchCoinbase(symbol);
  const binancePrice = await fetchBinance(symbol);
  
  const spread = Math.abs(coinbasePrice - binancePrice) / binancePrice;
  
  if (spread > 0.001) { // >0.1% spread
    // Buy on cheaper exchange, sell on expensive
    console.log(`ARB OPPORTUNITY: ${symbol} spread ${(spread * 100).toFixed(3)}%`);
  }
}
```

---

### 3.3 Regime Detection Enhancement

**Current:** Uses Fear & Greed + basic trend detection.

**Missing:**
1. VIX correlation (when VIX spikes, reduce crypto exposure)
2. Dollar strength (DXY correlation with crypto)
3. Fed meeting calendar (high-volatility periods to avoid)

**Quick Addition:**
```typescript
// In market-intel.ts - Add DXY correlation
async function getDxySignal(): Promise<'risk-on' | 'risk-off' | 'neutral'> {
  const dxyResp = await fetch('https://api.fxlogo.com/api/quotes/DX.fmt');
  const dxy = await dxyResp.json();
  
  if (dxy.price > 105) return 'risk-off'; // Strong dollar = risk-off
  if (dxy.price < 100) return 'risk-on';  // Weak dollar = risk-on
  return 'neutral';
}
```

---

## Priority 4: LIVE TRADING PREP

### 4.1 Before Going Live, You Need:

1. **Slippage Analysis** - Paper trading assumes X bps slippage. Measure actual slippage vs expected.
2. **Order Execution Latency** - How long from signal to fill?
3. **Broker API Reliability** - What's the actual fill rate vs rejection rate?
4. **Capital Requirements** - Minimum balance for each broker to avoid margin calls.

### 4.2 Staged Live Deployment Plan

```
Week 1: Live XRP-USD only (best performer, smallest position)
Week 2: Add ETH-USD
Week 3: Evaluate BTC-USD with tiny size
Week 4: Scale successful strategies, kill BTC
```

### 4.3 Risk Controls Before Live

```typescript
const LIVE_RISK_LIMITS = {
  maxDailyLoss: 50,        // Stop if down $50/day
  maxOpenPositions: 3,      // Never more than 3 concurrent
  maxPositionSize: 0.1,    // Never >10% of equity per trade
  maxLeverage: 1,           // NO LEVERAGE initially
  minWinRate: 55,           // Kill strategy if below 55% for 20 trades
};
```

---

## Implementation Roadmap

### Week 1 (This Week)
- [ ] Stop BTC-USD trading (or reduce to 10% size)
- [ ] Double XRP-USD allocation
- [ ] Add session-based time filters
- [ ] Fix lane learning logic (already done)

### Week 2
- [ ] Implement ATR-based dynamic stops
- [ ] Add liquidation heatmap data
- [ ] Improve AI council prompts
- [ ] Add correlation alerts

### Week 3
- [ ] Implement funding rate monitoring
- [ ] Add cross-exchange price comparison
- [ ] Build trade journal weekly report
- [ ] Test XRP live with $100

### Week 4
- [ ] Evaluate live results
- [ ] Scale winning strategies
- [ ] Kill losing strategies
- [ ] Full live deployment if profitable

---

## Data Appendix: Full Journal Analysis

```
Symbol      | Trades | Win% | Winners | Losers | PnL      | Verdict
------------|--------|------|---------|--------|----------|--------
XRP-USD     |     78 | 74%  |      58 |     20 | +$166.05 | STAR PERFORMER
VIXY        |      1 | 100% |       1 |      0 |   +$2.98 | Small sample
SOL-USD     |     10 | 70%  |       7 |      3 |   +$3.50 | Good
ETH-USD     |    320 | 61%  |     197 |     88 |  +$31.24 | Good
BTC-USD     |    470 | 47%  |     221 |    213 | -$1105.92| STOP THIS
```

**Total P&L:** ~-$902 (mostly BTC-USD loss)

---

## Conclusion

The Hermes trading firm has a solid foundation but:
1. **BTC-USD is the #1 problem** - fix or kill it
2. **XRP-USD is under-utilized** - press size
3. **Missing signals** - liquidation data, funding rates
4. **AI prompts need refinement** - more regime-aware guidance
5. **Time-based filters** - crypto trades 24/7 but you should trade sessions

**Expected improvement:** +$100-200/day by stopping BTC losses alone.
