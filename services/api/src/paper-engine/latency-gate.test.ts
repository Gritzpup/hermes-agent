/**
 * Latency Gate — unit test
 * Verifies: mean-reversion scalps blocked when venue median latency > 3000ms
 */

import { describe, it, expect } from 'vitest';
import { canEnter } from './engine-entry.js';

// Helper function (same as in engine-entry.ts)
function getVenueMedianLatencyMs(report: { buckets: Array<{ venue: string; signalToFillMsP50: number }> }, venue: string): number {
  const buckets = report.buckets.filter(b => b.venue === venue && b.signalToFillMsP50 > 0);
  if (!buckets.length) return 0;
  return buckets.reduce((sum, b) => sum + b.signalToFillMsP50, 0) / buckets.length;
}

describe('getVenueMedianLatencyMs', () => {
  it('extracts median from single bucket', () => {
    const report = { buckets: [{ venue: 'alpaca', signalToFillMsP50: 5000 }] };
    expect(getVenueMedianLatencyMs(report, 'alpaca')).toBe(5000);
  });

  it('averages multiple venue buckets', () => {
    const report = { buckets: [
      { venue: 'alpaca', signalToFillMsP50: 4000 },
      { venue: 'alpaca', signalToFillMsP50: 6000 },
      { venue: 'oanda', signalToFillMsP50: 200 }
    ] };
    expect(getVenueMedianLatencyMs(report, 'alpaca')).toBe(5000);
  });

  it('returns 0 when no matching venue', () => {
    const report = { buckets: [{ venue: 'oanda', signalToFillMsP50: 200 }] };
    expect(getVenueMedianLatencyMs(report, 'alpaca')).toBe(0);
  });

  it('correctly gates: 5000ms > 3000ms threshold', () => {
    const report = { buckets: [{ venue: 'alpaca', signalToFillMsP50: 5000 }] };
    const median = getVenueMedianLatencyMs(report, 'alpaca');
    expect(median > 3000).toBe(true);
  });
});

describe('canEnter latency gate', () => {
  const mockSymbol: any = { 
    symbol: 'BTC-USD', assetClass: 'crypto', price: 50000, 
    updatedAt: new Date().toISOString(), spreadBps: 0.5, 
    history: Array(25).fill(50000), bias: 0.001, liquidityScore: 95, 
    drift: 0, tradable: true 
  };
  
  const baseEngine: any = {
    getSymbolGuard: () => null,
    evaluateSessionKpiGate: () => ({ pass: true }),
    marketIntel: { 
      getCompositeSignal: () => ({ direction: 'buy', confidence: 70 }), 
      computeRSI2: () => 30, getTrend5m: () => 'up', isLiquiditySweep: () => false, 
      getRecentVolRatio: () => null, isVwapFlat: () => false, getFearGreedValue: () => 50, 
      getSnapshot: () => ({ bollinger: [] }) 
    },
    resolveEntryDirection: () => 'long',
    classifySymbolRegime: () => 'normal',
    getRegimeThrottleMultiplier: () => 1,
    evaluateCryptoExecutionGuard: () => ({ pass: true }),
    entryThreshold: () => 1,
    computeRSI2: () => 30,
    computeRSI14: () => 45,
    computeStochastic: () => null,
    isVwapFlat: () => false,
    getFundingRate: () => null,
    relativeMove: () => 0.001,
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
    getTrend5m: () => 'up',
    isLiquiditySweep: () => false,
    getRecentVolRatio: () => null,
    market: { get: () => mockSymbol },
  };

  it('blocks MR scalp when venue median latency > 3000ms', () => {
    const highLatencyEngine = {
      ...baseEngine,
      latencyTracker: {
        getReport: () => ({
          buckets: [{ venue: 'alpaca', symbol: 'BTC-USD', signalToFillMsP50: 5000 }],
          totalSamples: 10,
          alerts: []
        })
      }
    };
    const agent: any = {
      config: { style: 'mean-reversion', lane: 'scalping', broker: 'alpaca', symbol: 'BTC-USD', executionMode: 'paper', id: 'test', name: 'test', sizeFraction: 0.1, spreadLimitBps: 10 },
      lastAction: '',
      allocationMultiplier: 1,
      cash: 100000
    };
    
    const result = canEnter(highLatencyEngine, agent, mockSymbol, 0.001, 0.001, 1);
    expect(result).toBe(false);
    expect(agent.lastAction).toContain('latency gate');
    expect(agent.lastAction).toContain('alpaca');
    expect(agent.lastAction).toContain('5000ms > 3000ms');
  });

  it('allows MR scalp when venue median latency < 3000ms', () => {
    const lowLatencyEngine = {
      ...baseEngine,
      latencyTracker: {
        getReport: () => ({
          buckets: [{ venue: 'alpaca', symbol: 'BTC-USD', signalToFillMsP50: 1000 }],
          totalSamples: 10,
          alerts: []
        })
      }
    };
    const agent: any = {
      config: { style: 'mean-reversion', lane: 'scalping', broker: 'alpaca', symbol: 'BTC-USD', executionMode: 'paper', id: 'test', name: 'test', sizeFraction: 0.1, spreadLimitBps: 10 },
      lastAction: '',
      allocationMultiplier: 1,
      cash: 100000
    };
    
    const result = canEnter(lowLatencyEngine, agent, mockSymbol, 0.001, 0.001, 1);
    // Result may be false due to other gates, but should NOT be latency gate
    if (result === false) {
      expect(agent.lastAction).not.toContain('latency gate');
    }
  });

  it('does not apply latency gate to non-scalping lanes', () => {
    const highLatencyEngine = {
      ...baseEngine,
      latencyTracker: {
        getReport: () => ({
          buckets: [{ venue: 'alpaca', symbol: 'BTC-USD', signalToFillMsP50: 5000 }],
          totalSamples: 10,
          alerts: []
        })
      }
    };
    const agent: any = {
      config: { style: 'mean-reversion', lane: 'maker', broker: 'alpaca', symbol: 'BTC-USD', executionMode: 'paper', id: 'test', name: 'test', sizeFraction: 0.1, spreadLimitBps: 10 },
      lastAction: '',
      allocationMultiplier: 1,
      cash: 100000
    };
    
    const result = canEnter(highLatencyEngine, agent, mockSymbol, 0.001, 0.001, 1);
    // Should not be blocked by latency gate (maker lane)
    if (result === false) {
      expect(agent.lastAction).not.toContain('latency gate');
    }
  });
});
