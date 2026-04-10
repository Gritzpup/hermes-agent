import type {
  AiCouncilDecision,
  AgentFillEvent,
  ExecutionReport,
  MarketSnapshot,
  OverviewSnapshot,
  PaperAgentSnapshot,
  PaperDeskSnapshot,
  PositionSnapshot,
  ResearchCandidate,
  ServiceHealth,
  StrategyReview,
  StrategySnapshot,
  SystemSettings,
  TradeJournalEntry
} from './index.js';

const stamp = (hoursAgo = 0) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

const serviceHealth: ServiceHealth[] = [
  { name: 'api', port: 4300, status: 'healthy', message: 'Control plane online' },
  { name: 'risk-engine', port: 4301, status: 'healthy', message: 'Pilot caps armed' },
  { name: 'market-data', port: 4302, status: 'warning', message: 'Coinbase stock contract discovery pending' },
  { name: 'broker-router', port: 4303, status: 'healthy', message: 'Alpaca paper and Coinbase live routes loaded' },
  { name: 'review-loop', port: 4304, status: 'healthy', message: 'Review queue draining normally' }
];

const navCurve = [98120, 98640, 99110, 99580, 100120, 100580, 100900, 101220, 101910, 102480, 102940, 103240];
const drawdownCurve = [3.4, 3.2, 3.1, 2.9, 2.7, 2.3, 2.1, 1.9, 1.8, 1.6, 1.5, 1.4];
const deskCurve = [100000, 100120, 100460, 100910, 101180, 101520, 101740, 101930, 102260, 102620, 102980, 103240];
const benchmarkCurve = [100000, 100080, 100190, 100420, 100560, 100710, 100900, 101020, 101170, 101360, 101480, 101620];
const aiCouncil: AiCouncilDecision[] = [
  {
    id: 'ai-001',
    symbol: 'BTC-USD',
    agentId: 'agent-btc-scalper',
    agentName: 'BTC Tape Scalper',
    status: 'complete',
    finalAction: 'approve',
    reason: 'Claude approved and Codex agreed the tape setup was clean enough for a paper scalp.',
    timestamp: stamp(0.15),
    primary: {
      provider: 'claude',
      source: 'rules',
      action: 'approve',
      confidence: 81,
      thesis: 'Momentum squeeze is aligned with improving spread and liquidity.',
      riskNote: 'Exit quickly if the move stalls.',
      latencyMs: 2480,
      timestamp: stamp(0.15)
    },
    challenger: {
      provider: 'codex',
      source: 'rules',
      action: 'approve',
      confidence: 72,
      thesis: 'The deterministic score is strong enough to accept the setup in paper mode.',
      riskNote: 'Do not widen the stop.',
      latencyMs: 1620,
      timestamp: stamp(0.14)
    }
  }
];

export function getServiceHealth(): ServiceHealth[] {
  return serviceHealth;
}

export function getOverviewSnapshot(): OverviewSnapshot {
  const oscillation = Math.sin(Date.now() / 3_600_000) * 240;
  const nav = 103_240 + oscillation;
  const dailyPnl = 1_486 + oscillation * 0.6;

  return {
    asOf: new Date().toISOString(),
    nav,
    dailyPnl,
    dailyPnlPct: 1.47,
    drawdownPct: 1.38,
    activeRiskBudgetPct: 28,
    realizedPnl30d: 12_840,
    winRate30d: 58.6,
    expectancyR: 0.42,
    navSparkline: navCurve.map((value, index) => value + Math.sin(Date.now() / 100_000 + index) * 80),
    drawdownSparkline: drawdownCurve,
    heatByBroker: [
      { broker: 'alpaca-paper', equity: 103_240, cash: 48_200, allocatedPct: 49, realizedPnl: 4_320, status: 'connected', mode: 'paper', updatedAt: new Date().toISOString() },
      { broker: 'coinbase-live', equity: 108_520, cash: 52_300, allocatedPct: 51, realizedPnl: 8_520, status: 'connected', mode: 'live', updatedAt: new Date().toISOString() }
    ],
    brokerAccounts: [
      { broker: 'alpaca-paper', mode: 'paper', accountId: 'alpaca-paper', currency: 'USD', cash: 48_200, buyingPower: 96_400, equity: 103_240, status: 'connected', source: 'broker', updatedAt: new Date().toISOString(), availableToTrade: 96_400 },
      { broker: 'coinbase-live', mode: 'live', accountId: 'coinbase-live', currency: 'USD', cash: 52_300, buyingPower: 52_300, equity: 108_520, status: 'connected', source: 'broker', updatedAt: new Date().toISOString(), availableToTrade: 52_300 }
    ],
    serviceHealth
  };
}

export function getPositions(): PositionSnapshot[] {
  return [
    {
      id: 'pos-btc-01',
      broker: 'coinbase-live',
      symbol: 'BTC-USD',
      strategy: 'Scalping Lane',
      assetClass: 'crypto',
      quantity: 0.184,
      avgEntry: 84_652,
      markPrice: 85_204,
      unrealizedPnl: 101.57,
      unrealizedPnlPct: 0.65,
      thesis: 'Microstructure imbalance with tight spread and persistent lift.',
      openedAt: stamp(1.2)
    },
    {
      id: 'pos-paxg-01',
      broker: 'coinbase-live',
      symbol: 'PAXG',
      strategy: 'Recovery Lane',
      assetClass: 'commodity-proxy',
      quantity: 12.4,
      avgEntry: 2_294,
      markPrice: 2_309,
      unrealizedPnl: 186,
      unrealizedPnlPct: 0.65,
      thesis: 'Risk hedge while broad market beta remains elevated.',
      openedAt: stamp(8.5)
    },
    {
      id: 'pos-spy-01',
      broker: 'alpaca-paper',
      symbol: 'SPY',
      strategy: 'Recovery Lane',
      assetClass: 'equity',
      quantity: 32,
      avgEntry: 584.2,
      markPrice: 589.4,
      unrealizedPnl: 166.4,
      unrealizedPnlPct: 0.89,
      thesis: 'Index leadership retained after drawdown reset.',
      openedAt: stamp(14)
    },
    {
      id: 'pos-nvda-01',
      broker: 'alpaca-paper',
      symbol: 'NVDA',
      strategy: 'Recovery Lane',
      assetClass: 'equity',
      quantity: 48,
      avgEntry: 131.8,
      markPrice: 135.6,
      unrealizedPnl: 182.4,
      unrealizedPnlPct: 2.88,
      thesis: 'Relative strength leader on improving risk appetite.',
      openedAt: stamp(26)
    }
  ];
}

export function getOrders(): ExecutionReport[] {
  return [
    {
      id: 'fill-001',
      orderId: 'ord-001',
      broker: 'coinbase-live',
      symbol: 'BTC-USD',
      status: 'filled',
      filledQty: 0.041,
      avgFillPrice: 85_166,
      slippageBps: 2.6,
      latencyMs: 182,
      message: 'Filled against live Coinbase book.',
      timestamp: stamp(0.3)
    },
    {
      id: 'fill-002',
      orderId: 'ord-002',
      broker: 'alpaca-paper',
      symbol: 'QQQ',
      status: 'accepted',
      filledQty: 12,
      avgFillPrice: 0,
      slippageBps: 0,
      latencyMs: 96,
      message: 'Queued in Alpaca paper simulator.',
      timestamp: stamp(0.8)
    },
    {
      id: 'fill-003',
      orderId: 'ord-003',
      broker: 'coinbase-live',
      symbol: 'PAXG',
      status: 'rejected',
      filledQty: 0,
      avgFillPrice: 0,
      slippageBps: 0,
      latencyMs: 44,
      message: 'Rejected by pilot cap: notional too large.',
      timestamp: stamp(2.1)
    }
  ];
}

export function getStrategies(): StrategySnapshot[] {
  return [
    {
      id: 'strategy-scalping-btc',
      name: 'Scalping Lane / BTC',
      lane: 'scalping',
      stage: 'shadow-live',
      mode: 'live',
      broker: 'coinbase-live',
      symbols: ['BTC-USD'],
      status: 'active',
      dailyPnl: 812,
      lastReviewAt: stamp(3),
      summary: 'Rules-first microstructure engine with Claude veto enabled.'
    },
    {
      id: 'strategy-recovery-equities',
      name: 'Recovery Lane / Leaders',
      lane: 'recovery',
      stage: 'paper',
      mode: 'paper',
      broker: 'alpaca-paper',
      symbols: ['SPY', 'QQQ', 'NVDA', 'MSFT'],
      status: 'warming',
      dailyPnl: 264,
      lastReviewAt: stamp(6),
      summary: 'Post-selloff leader ranking with balance-sheet filters and AI review notes.'
    }
  ];
}

export function getResearchCandidates(): ResearchCandidate[] {
  return [
    {
      id: 'cand-btc',
      symbol: 'BTC-USD',
      strategy: 'Scalping Lane',
      score: 92,
      expectedEdgeBps: 18,
      catalyst: 'Bid ladder holding, ask pressure thinning, realized vol compressing.',
      aiVerdict: 'Take only with strict timeout; edge decays fast after 4 minutes.',
      riskStatus: 'approved',
      broker: 'coinbase-live'
    },
    {
      id: 'cand-qqq',
      symbol: 'QQQ',
      strategy: 'Recovery Lane',
      score: 81,
      expectedEdgeBps: 64,
      catalyst: 'Broad index leadership restored after macro flush.',
      aiVerdict: 'Good candidate for paper accumulation while live equities adapter settles.',
      riskStatus: 'review',
      broker: 'alpaca-paper'
    },
    {
      id: 'cand-paxg',
      symbol: 'PAXG',
      strategy: 'Recovery Lane',
      score: 76,
      expectedEdgeBps: 42,
      catalyst: 'Gold proxy stabilizing while beta remains noisy.',
      aiVerdict: 'Use as hedge, not as primary profit engine.',
      riskStatus: 'approved',
      broker: 'coinbase-live'
    }
  ];
}

export function getReviews(): StrategyReview[] {
  return [
    {
      id: 'review-001',
      strategy: 'Scalping Lane / BTC',
      stage: 'shadow-live',
      pnl30d: 5_640,
      winRate: 59.1,
      expectancy: 0.44,
      recommendation: 'Keep the current edge filter, but reduce size during spread expansion.',
      proposedChanges: [
        'Lower max notional from $2,500 to $2,000 during high-volatility sessions.',
        'Tighten timeout from 6 minutes to 4 minutes when spread exceeds 5 bps.'
      ],
      updatedAt: stamp(5)
    },
    {
      id: 'review-002',
      strategy: 'Recovery Lane / Leaders',
      stage: 'paper',
      pnl30d: 2_460,
      winRate: 54.2,
      expectancy: 0.31,
      recommendation: 'Hold in paper while the ranking model builds a broader event set.',
      proposedChanges: [
        'Raise cash-flow weighting in the scorecard.',
        'Exclude names with widening estimate dispersion.'
      ],
      updatedAt: stamp(18)
    }
  ];
}

export function getJournal(): TradeJournalEntry[] {
  return [
    {
      id: 'journal-001',
      symbol: 'BTC-USD',
      assetClass: 'crypto',
      broker: 'coinbase-live',
      strategy: 'Scalping Lane',
      thesis: 'Absorption at prior local low with improving tape speed.',
      entryAt: stamp(7),
      exitAt: stamp(6.9),
      realizedPnl: 142,
      realizedPnlPct: 0.23,
      slippageBps: 1.8,
      spreadBps: 3.1,
      aiComment: 'Best entries still come when tape and spread align, not just momentum.',
      exitReason: 'Target reached before timeout.',
      verdict: 'winner'
    },
    {
      id: 'journal-002',
      symbol: 'QQQ',
      assetClass: 'equity',
      broker: 'alpaca-paper',
      strategy: 'Recovery Lane',
      thesis: 'Leader rotation resumed after macro reset.',
      entryAt: stamp(28),
      exitAt: stamp(22),
      realizedPnl: -86,
      realizedPnlPct: -0.41,
      slippageBps: 0.7,
      spreadBps: 1.1,
      aiComment: 'Thesis was early; breadth confirmation lagged.',
      exitReason: 'Time stop with breadth deterioration.',
      verdict: 'loser'
    }
  ];
}

export function getMarketSnapshots(): MarketSnapshot[] {
  return [
    { symbol: 'BTC-USD', broker: 'coinbase-live', assetClass: 'crypto', lastPrice: 85_204, changePct: 1.1, volume: 38_240_000, spreadBps: 3.1, liquidityScore: 94, status: 'live' },
    { symbol: 'PAXG', broker: 'coinbase-live', assetClass: 'commodity-proxy', lastPrice: 2_309, changePct: 0.4, volume: 1_180_000, spreadBps: 4.4, liquidityScore: 78, status: 'live' },
    { symbol: 'SPY', broker: 'alpaca-paper', assetClass: 'equity', lastPrice: 589.4, changePct: 0.9, volume: 12_800_000, spreadBps: 1.4, liquidityScore: 96, status: 'delayed' },
    { symbol: 'QQQ', broker: 'alpaca-paper', assetClass: 'equity', lastPrice: 507.2, changePct: 1.3, volume: 9_420_000, spreadBps: 1.6, liquidityScore: 93, status: 'delayed' }
  ];
}

export function getSettings(): SystemSettings {
  return {
    paperBroker: 'alpaca-paper',
    liveBroker: 'coinbase-live',
    universe: ['BTC-USD', 'PAXG', 'SPY', 'QQQ', 'NVDA', 'MSFT', 'AMZN', 'META'],
    riskCaps: {
      maxTradeNotional: 5_000,
      maxDailyLoss: 1_200,
      maxStrategyExposurePct: 22,
      maxSymbolExposurePct: 12,
      maxDrawdownPct: 4,
      maxSlippageBps: 12
    },
    killSwitches: [
      'broker disconnect',
      'stale market data',
      'daily loss breach',
      'session drawdown breach',
      'excessive slippage',
      'manual operator override'
    ],
    notes: [
      'Alpaca is paper-only by design.',
      'Coinbase is live-only by design.',
      'Coinbase stock contract discovery is isolated inside the live adapter.'
    ]
  };
}

export function getPaperDeskSnapshot(): PaperDeskSnapshot {
  const phase = Date.now() / 180_000;
  const fillPulse = Math.sin(phase) * 120;

  const agents: PaperAgentSnapshot[] = [
    {
      id: 'agent-btc-scalper',
      name: 'BTC Tape Scalper',
      lane: 'scalping',
      broker: 'alpaca-paper',
      status: 'in-trade',
      equity: 26_420 + Math.sin(phase) * 180,
      dayPnl: 412 + Math.sin(phase) * 36,
      realizedPnl: 268,
      returnPct: 1.65,
      winRate: 61.4,
      totalTrades: 18,
      openPositions: 1,
      lastAction: 'Bought pullback into reclaimed bid wall.',
      lastSymbol: 'BTC-USD',
      focus: 'Microstructure imbalance and spread compression.',
      lastExitPnl: 42,
      curve: deskCurve.map((value, index) => value / 4 + Math.sin(phase + index / 3) * 48)
    },
    {
      id: 'agent-index-rebound',
      name: 'Index Rebound Hunter',
      lane: 'recovery',
      broker: 'alpaca-paper',
      status: 'watching',
      equity: 25_930 + Math.cos(phase * 0.7) * 140,
      dayPnl: 188 + Math.cos(phase * 0.7) * 28,
      realizedPnl: 146,
      returnPct: 0.74,
      winRate: 55.8,
      totalTrades: 11,
      openPositions: 2,
      lastAction: 'Holding QQQ and SPY while breadth stabilizes.',
      lastSymbol: 'QQQ',
      focus: 'Post-shock leader rotation with index confirmation.',
      lastExitPnl: 28,
      curve: deskCurve.map((value, index) => value / 4 - 120 + Math.cos(phase * 0.7 + index / 4) * 36)
    },
    {
      id: 'agent-gold-hedge',
      name: 'Hedge and Flight Monitor',
      lane: 'recovery',
      broker: 'alpaca-paper',
      status: 'cooldown',
      equity: 25_410 + Math.sin(phase * 0.5) * 90,
      dayPnl: 94 + Math.sin(phase * 0.5) * 18,
      realizedPnl: 84,
      returnPct: 0.38,
      winRate: 53.2,
      totalTrades: 9,
      openPositions: 1,
      lastAction: 'Reduced hedge after volatility normalized.',
      lastSymbol: 'PAXG',
      focus: 'Protective rotation and volatility dampening.',
      lastExitPnl: 16,
      curve: deskCurve.map((value, index) => value / 4 - 240 + Math.sin(phase * 0.5 + index / 5) * 28)
    },
    {
      id: 'agent-leader-scout',
      name: 'Leader Scout',
      lane: 'recovery',
      broker: 'alpaca-paper',
      status: 'watching',
      equity: 25_780 + Math.cos(phase * 0.9) * 112,
      dayPnl: 126 + Math.cos(phase * 0.9) * 24,
      realizedPnl: 322,
      returnPct: 1.12,
      winRate: 57.1,
      totalTrades: 14,
      openPositions: 3,
      lastAction: 'Queued NVDA, MSFT, and AMZN for next paper wave.',
      lastSymbol: 'NVDA',
      focus: 'Relative-strength ranking and balance-sheet quality.',
      lastExitPnl: 58,
      curve: deskCurve.map((value, index) => value / 4 - 80 + Math.cos(phase * 0.9 + index / 6) * 32)
    }
  ];

  const fills: AgentFillEvent[] = [
    {
      id: 'paper-fill-001',
      agentId: 'agent-btc-scalper',
      agentName: 'BTC Tape Scalper',
      symbol: 'BTC-USD',
      side: 'buy',
      status: 'filled',
      price: 85_118,
      pnlImpact: 0,
      note: 'Opened 0.18 BTC paper scalp on reclaim of local bid stack.',
      timestamp: stamp(0.1)
    },
    {
      id: 'paper-fill-002',
      agentId: 'agent-index-rebound',
      agentName: 'Index Rebound Hunter',
      symbol: 'QQQ',
      side: 'buy',
      status: 'filled',
      price: 507.2,
      pnlImpact: 146,
      note: 'Scaled into paper rebound basket after breadth stabilized.',
      timestamp: stamp(0.4)
    },
    {
      id: 'paper-fill-003',
      agentId: 'agent-gold-hedge',
      agentName: 'Hedge and Flight Monitor',
      symbol: 'PAXG',
      side: 'sell',
      status: 'filled',
      price: 2_308,
      pnlImpact: 84,
      note: 'Trimmed hedge after risk budget cooled and spread tightened.',
      timestamp: stamp(0.7)
    },
    {
      id: 'paper-fill-004',
      agentId: 'agent-leader-scout',
      agentName: 'Leader Scout',
      symbol: 'NVDA',
      side: 'buy',
      status: 'accepted',
      price: 138.9,
      pnlImpact: fillPulse,
      note: 'Queued paper probe while earnings drift remains supportive.',
      timestamp: stamp(1.1)
    }
  ];

  return {
    asOf: new Date().toISOString(),
    chartWindow: 'Last 12 intervals',
    startingEquity: 100_000,
    totalEquity: 103_540 + fillPulse,
    totalDayPnl: 820 + fillPulse * 0.8,
    totalReturnPct: 3.54,
    realizedPnl: 820,
    realizedGrossPnl: 910,
    realizedFeesUsd: 90,
    realizedReturnPct: 0.82,
    totalTrades: 52,
    winRate: 57.8,
    activeAgents: agents.filter((agent) => agent.status === 'in-trade').length,
    deskCurve: deskCurve.map((value, index) => value + Math.sin(phase + index / 4) * 90),
    benchmarkCurve: benchmarkCurve.map((value, index) => value + Math.cos(phase * 0.6 + index / 5) * 40),
    agents,
    fills,
    marketFocus: getMarketSnapshots(),
    aiCouncil,
    analytics: {
      profitFactor: 1.63,
      avgWinner: 112,
      avgLoser: 71,
      avgHoldTicks: 4.6,
      recentWinRate: 58.2,
      totalOpenRisk: 468,
      adaptiveMode: 'bounded deterministic paper tuning',
      verificationNote: 'This snapshot is still seeded mock data. The real adaptive paper telemetry now comes from services/api/src/paper-engine.ts.'
    },
    executionBands: [
      {
        agentId: 'agent-btc-scalper',
        agentName: 'BTC Tape Scalper',
        symbol: 'BTC-USD',
        status: 'in-trade',
        entryPrice: 85_118,
        currentPrice: 85_204,
        stopPrice: 84_965,
        targetPrice: 85_407,
        unrealizedPnl: 15.48,
        unrealizedPnlPct: 0.18,
        lastAction: 'Managing BTC-USD scalp while spread stays compressed.'
      }
    ],
    tuning: [
      {
        agentId: 'agent-btc-scalper',
        agentName: 'BTC Tape Scalper',
        symbol: 'BTC-USD',
        style: 'momentum',
        expectancy: 84,
        profitFactor: 1.63,
        avgWinner: 112,
        avgLoser: 71,
        avgHoldTicks: 4.6,
        winRate: 58.2,
        targetBps: 34,
        stopBps: 18,
        maxHoldTicks: 6,
        spreadLimitBps: 6,
        sizeFractionPct: 14,
        lastAdjustment: 'Holding steady while paper sample remains favorable.',
        improvementBias: 'hold-steady',
        mistakeSummary: 'No dominant pattern in the latest mock sample.',
        mistakeScore: 12.5,
        mistakeTrend: 'stable',
        performanceTrend: 'stable',
        lastAdjustmentImproved: true,
        allocationMultiplier: 1,
        allocationScore: 0.92,
        allocationReason: 'Mock allocation remains neutral.'
      }
    ],
    marketTape: [
      {
        symbol: 'BTC-USD',
        broker: 'alpaca-paper',
        assetClass: 'crypto',
        status: 'live',
        source: 'mock',
        updatedAt: stamp(0),
        lastPrice: 85_204,
        changePct: 1.1,
        spreadBps: 3.1,
        liquidityScore: 94,
        candles: [
          { index: 0, open: 84_920, high: 84_986, low: 84_902, close: 84_974 },
          { index: 1, open: 84_974, high: 85_040, low: 84_952, close: 85_012 },
          { index: 2, open: 85_012, high: 85_166, low: 84_998, close: 85_118 },
          { index: 3, open: 85_118, high: 85_248, low: 85_076, close: 85_204 }
        ],
        markers: [
          {
            id: 'paper-fill-001',
            symbol: 'BTC-USD',
            side: 'buy',
            status: 'filled',
            price: 85_118,
            agentName: 'BTC Tape Scalper',
            timestamp: stamp(0.1)
          }
        ]
      }
    ],
    sources: [
      {
        id: 'mock-paper',
        label: 'mock paper desk',
        mode: 'mock',
        detail: 'Seeded fallback snapshot for contracts demos only.'
      }
    ],
    signals: []
  };
}
