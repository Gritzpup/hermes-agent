/**
 * Adverse-news auto-flatten — unit test
 * Verifies: BTC-USD long closed when newsIntel returns bearish direction with high confidence.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Shallow mock of engine-trading-positions so we can intercept closePosition ──
const closedReasons: string[] = [];
let mockClosePosition: any;

vi.mock('./engine-trading-positions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./engine-trading-positions.js')>();
  mockClosePosition = vi.fn(async (
    _eng: any, agent: any, _symbol: any, reason: string
  ) => {
    closedReasons.push(reason);
    agent.position = null; // simulate the real side-effect
  });
  return {
    ...actual,
    manageOpenPosition: actual.manageOpenPosition,
    // expose our stub so test can pass engine methods through
  };
});

import { manageOpenPosition } from './engine-trading-positions.js';

function makeSymbol() {
  return { symbol: 'BTC-USD', assetClass: 'crypto', price: 49_000, spreadBps: 5 };
}

function makeAgent(direction: 'long' | 'short', entryTick = 5) {
  return {
    position: {
      direction,
      quantity: 0.01,
      entryPrice: 50_000,
      entryTick,
      entryAt: new Date().toISOString(),
      peakPrice: 50_000,
      stopPrice: 49_000,
      targetPrice: direction === 'long' ? 51_000 : 49_000,
    },
    config: {
      id: 'test-agent', name: 'test', style: 'momentum',
      maxHoldTicks: 30, symbol: 'BTC-USD', sizeFraction: 0.1, executionMode: 'paper',
    },
    status: 'in-trade',
    cash: 9_500,
    feesPaid: 0,
    realizedPnl: 0,
  };
}

function makeEngine(newsSignal: any) {
  return {
    tick: 10,
    newsIntel: {
      getSignal: () => newsSignal,
      getMacroSignal: () => ({ direction: 'neutral', confidence: 0, veto: false }),
    },
    eventCalendar: { getEmbargo: () => ({ blocked: false }) },
    maybeTrailBrokerStop: () => {},
    getPositionDirection: (p: any) => p.direction,
    getAgentEquity: () => 10_000,
    // engine.closeBrokerPaperPosition is called for 'paper' executionMode
    closeBrokerPaperPosition: vi.fn(),
  };
}

beforeEach(() => { closedReasons.length = 0; });

describe('adverse-news auto-flatten', () => {
  it('closes long when news direction=bearish with confidence >= 75', async () => {
    const engine = makeEngine({ direction: 'bearish', confidence: 90, veto: false });
    const agent = makeAgent('long', 5); // holdTicks = 10 - 5 = 5 >= 2
    const sym = makeSymbol();

    await manageOpenPosition(engine as any, agent, sym, 0.8);

    expect(agent.position).toBeNull();
    expect(closedReasons[0]).toContain('adverse-news auto-flatten');
    expect(closedReasons[0]).toContain('bearish');
    expect(closedReasons[0]).toContain('90');
  });

  it('closes short when news direction=bullish with confidence >= 75', async () => {
    const engine = makeEngine({ direction: 'bullish', confidence: 80, veto: false });
    const agent = makeAgent('short', 5);
    const sym = makeSymbol();

    await manageOpenPosition(engine as any, agent, sym, 0.8);

    expect(agent.position).toBeNull();
    expect(closedReasons[0]).toContain('adverse-news auto-flatten');
    expect(closedReasons[0]).toContain('bullish');
  });

  it('does NOT close when confidence < 75 (sub-threshold noise)', async () => {
    const engine = makeEngine({ direction: 'bearish', confidence: 60, veto: false });
    const agent = makeAgent('long', 5);
    const sym = makeSymbol();

    await manageOpenPosition(engine as any, agent, sym, 0.8);

    expect(agent.position).not.toBeNull();
    expect(closedReasons).toHaveLength(0);
  });

  it('does NOT close when holdTicks < 2 (newly opened position)', async () => {
    const engine = makeEngine({ direction: 'bearish', confidence: 90, veto: false });
    const agent = makeAgent('long', 9); // holdTicks = 10 - 9 = 1 < 2
    const sym = makeSymbol();

    await manageOpenPosition(engine as any, agent, sym, 0.8);

    expect(agent.position).not.toBeNull();
    expect(closedReasons).toHaveLength(0);
  });

  it('does NOT close long when news direction=bullish (position aligned)', async () => {
    const engine = makeEngine({ direction: 'bullish', confidence: 90, veto: false });
    const agent = makeAgent('long', 5);
    const sym = makeSymbol();

    await manageOpenPosition(engine as any, agent, sym, 0.8);

    expect(agent.position).not.toBeNull();
    expect(closedReasons).toHaveLength(0);
  });
});
