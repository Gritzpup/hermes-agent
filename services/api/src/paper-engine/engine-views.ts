// @ts-nocheck
/**
 * Engine Views
 *
 * Read-only view/snapshot methods extracted from PaperScalpingEngine.
 * Each function takes the engine instance as the first parameter and
 * delegates all state access through it.
 */

import type {
  AgentLiveReadiness,
  BrokerId,
  DataSourceStatus,
  PaperAgentSnapshot,
  PaperTapeSnapshot,
  ReadinessGate
} from '@hermes/contracts';
import { average, clamp, pickLast, round } from '../paper-engine-utils.js';
import { evaluateKpiGate } from '../kpi-gates.js';
import { HISTORY_LIMIT, TICK_MS } from './types.js';

export function getExecutionQualityByBroker(engine: any): Array<{
  broker: BrokerId;
  score: number;
  avgSlippageBps: number;
  avgLatencyMs: number;
  partialFillRatePct: number;
  rejectRatePct: number;
  sampleCount: number;
}> {
  const journal = engine.getMetaJournalEntries().slice(-200);
  const brokers: BrokerId[] = ['alpaca-paper', 'oanda-rest', 'coinbase-live'];
  return brokers.map((broker) => {
    const rows = journal.filter((entry: any) => entry.broker === broker);
    const sampleCount = rows.length;
    const avgSlippageBps = sampleCount > 0
      ? average(rows.map((entry: any) => Math.abs(entry.slippageBps)))
      : 0;
    const avgLatencyMs = sampleCount > 0
      ? average(rows.map((entry: any) => Number.isFinite(entry.latencyMs) ? (entry.latencyMs as number) : 0))
      : 0;
    const counters = engine.executionQualityCounters.get(broker) ?? { attempts: 0, rejects: 0, partialFills: 0 };
    const rejectRatePct = counters.attempts > 0 ? (counters.rejects / counters.attempts) * 100 : 0;
    const partialFillRatePct = counters.attempts > 0 ? (counters.partialFills / counters.attempts) * 100 : 0;
    const score = clamp(
      100
        - avgSlippageBps * 2.2
        - avgLatencyMs / 120
        - rejectRatePct * 1.4
        - partialFillRatePct * 0.9,
      5,
      100
    );
    return {
      broker,
      score: round(score, 1),
      avgSlippageBps: round(avgSlippageBps, 2),
      avgLatencyMs: round(avgLatencyMs, 1),
      partialFillRatePct: round(partialFillRatePct, 2),
      rejectRatePct: round(rejectRatePct, 2),
      sampleCount
    };
  });
}

export function formatBrokerLabel(engine: any, broker: BrokerId): string {
  switch (broker) {
    case 'coinbase-live':
      return 'Coinbase live';
    case 'oanda-rest':
      return 'OANDA practice';
    case 'alpaca-paper':
    default:
      return 'Alpaca paper';
  }
}

export function buildMarketTape(engine: any): PaperTapeSnapshot[] {
  const visibleFills = engine.getVisibleFills();
  // Use agent's configured broker for routing, not market data source
  const agentBrokerMap = new Map(Array.from(engine.agents.values()).map((a: any) => [a.config.symbol, a.config.broker]));
  return Array.from(engine.market.values()).map((symbol: any) => ({
    symbol: symbol.symbol,
    broker: agentBrokerMap.get(symbol.symbol) ?? symbol.broker,
    assetClass: symbol.assetClass,
    status: symbol.marketStatus,
    source: symbol.sourceMode,
    updatedAt: symbol.updatedAt,
    session: symbol.session,
    tradable: symbol.tradable,
    qualityFlags: [...symbol.qualityFlags],
    lastPrice: round(symbol.price, 2),
    changePct: round(symbol.openPrice > 0 ? ((symbol.price - symbol.openPrice) / symbol.openPrice) * 100 : 0, 2),
    spreadBps: round(symbol.spreadBps, 2),
    liquidityScore: round(symbol.liquidityScore, 0),
    candles: engine.toCandles(symbol.history),
    markers: visibleFills
      .filter((fill: any) => fill.symbol === symbol.symbol)
      .slice(0, 6)
      .map((fill: any) => ({
        id: fill.id,
        symbol: fill.symbol,
        side: fill.side,
        status: fill.status,
        price: fill.price,
        agentName: fill.agentName,
        timestamp: fill.timestamp
      }))
  }));
}

export function analyzeSignals(engine: any): void {
  const now = new Date().toISOString();
  for (const symbol of engine.market.values()) {
    if (symbol.baseSpreadBps > 0 && symbol.spreadBps > symbol.baseSpreadBps * 1.5) {
      engine.signalBus.emit({
        type: 'spread-expansion',
        symbol: symbol.symbol,
        severity: symbol.spreadBps > symbol.baseSpreadBps * 2.5 ? 'critical' : 'warning',
        message: `${symbol.symbol} spread ${symbol.spreadBps.toFixed(1)} bps exceeds baseline ${symbol.baseSpreadBps.toFixed(1)} bps.`,
        timestamp: now
      });
    }
  }

  const btc = engine.market.get('BTC-USD');
  const eth = engine.market.get('ETH-USD');
  if (btc && eth && btc.openPrice > 0 && eth.openPrice > 0) {
    const btcChange = (btc.price - btc.openPrice) / btc.openPrice;
    const ethChange = (eth.price - eth.openPrice) / eth.openPrice;
    if ((btcChange > 0.005 && ethChange < -0.005) || (btcChange < -0.005 && ethChange > 0.005)) {
      engine.signalBus.emit({
        type: 'correlation-break',
        symbol: 'BTC-USD/ETH-USD',
        severity: 'warning',
        message: `BTC ${(btcChange * 100).toFixed(2)}% vs ETH ${(ethChange * 100).toFixed(2)}% divergence.`,
        timestamp: now
      });
    }
  }

  const symbols = Array.from(engine.market.values()).filter((s: any) => s.price > 0 && s.openPrice > 0);
  const negative = symbols.filter((s: any) => s.price < s.openPrice).length;
  if (symbols.length >= 3 && negative / symbols.length > 0.75) {
    engine.signalBus.emit({
      type: 'risk-off',
      symbol: 'DESK',
      severity: negative / symbols.length > 0.8 ? 'critical' : 'warning',
      message: `${negative}/${symbols.length} symbols negative. Risk-off conditions detected.`,
      timestamp: now
    });
  }
}

export function getDataSources(engine: any): DataSourceStatus[] {
  const tradableSymbols = Array.from(engine.market.values())
    .filter((symbol: any) => engine.hasTradableTape(symbol))
    .map((symbol: any) => symbol.symbol);
  const blockedSymbols = Array.from(engine.market.values())
    .filter((symbol: any) => !engine.hasTradableTape(symbol))
    .map((symbol: any) => `${symbol.symbol} (${engine.describeTapeFlags(symbol)})`);

  const brokerAutonomousAgents = Array.from(engine.agents.values())
    .filter((agent: any) => agent.config.executionMode === 'broker-paper' && agent.config.autonomyEnabled);

  const armedVenues = Array.from(new Set(brokerAutonomousAgents.map((a: any) => a.config.broker?.split('-')[0] ?? 'internal')));
  const armedSymbols = brokerAutonomousAgents.map((a: any) => a.config.symbol);

  const watchOnlyLanes = Array.from(engine.agents.values())
    .filter((agent: any) => agent.config.executionMode === 'watch-only' || !agent.config.autonomyEnabled)
    .map((agent: any) => agent.config.symbol);

  const venueList = armedVenues.length > 1
    ? `${armedVenues.slice(0, -1).join(', ')} and ${armedVenues.slice(-1)}`
    : armedVenues[0] || 'internal';

  return [
    {
      id: 'market-data',
      label: 'market data',
      mode: tradableSymbols.length > 0 ? 'live' : 'service',
      detail: tradableSymbols.length > 0
        ? `Tradable broker-fed tape currently drives ${tradableSymbols.join(', ')}. ${blockedSymbols.length > 0 ? `Autonomous entries are blocked for ${blockedSymbols.join(', ')}.` : 'All tracked paper symbols currently meet session and quote-quality gates.'}`
        : 'No symbols currently meet the session and quote-quality gates for autonomous trading.'
    },
    {
      id: 'paper-engine',
      label: 'paper execution',
      mode: brokerAutonomousAgents.length > 0 ? 'live' : 'service',
      detail: brokerAutonomousAgents.length > 0
        ? `Broker-backed ${venueList} paper routing is armed for ${Array.from(new Set(armedSymbols)).join(', ')}. Only Hermes-owned broker-filled exits count toward firm win rates. ${watchOnlyLanes.length > 0 ? `Watch-only lanes: ${Array.from(new Set(watchOnlyLanes)).join(', ')}.` : ''}`.trim()
        : 'No broker-backed paper lanes are armed yet.'
    },
    {
      id: 'ai-council',
      label: 'ai council',
      mode: 'service',
      detail: 'Claude is primary. Codex only challenges low-confidence or borderline setups.'
    }
  ];
}

export function getLiveReadinessReport(engine: any): any {
  const agents = Array.from(engine.agents.values()).map((agent: any) => toLiveReadiness(engine, agent));
  const blockers = agents.filter((a: any) => !a.eligible).map((a: any) => `${a.agentId}: ${a.reason ?? 'not eligible'}`);
  return {
    asOf: new Date().toISOString(),
    broker: 'multi',
    overallEligible: blockers.length === 0,
    summary: blockers.length === 0 ? 'All agents eligible for live trading' : `${blockers.length} agents blocked`,
    blockers: blockers.slice(0, 10),
    nextActions: blockers.length > 0 ? ['Review blocked agents', 'Check SLO status'] : ['Monitor performance'],
    agents
  };
}

export function toLiveReadiness(engine: any, agent: any): AgentLiveReadiness {
  const symbol = engine.market.get(agent.config.symbol);
  const outcomes = pickLast(agent.recentOutcomes, 12);
  const wins = outcomes.filter((value: number) => value > 0);
  const losses = outcomes.filter((value: number) => value < 0);
  const grossWins = wins.reduce((sum: number, value: number) => sum + value, 0);
  const grossLosses = Math.abs(losses.reduce((sum: number, value: number) => sum + value, 0));
  const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? 9.99 : 0;
  const expectancy = outcomes.length > 0 ? average(outcomes) : 0;
  const winRate = agent.trades > 0 ? (agent.wins / agent.trades) * 100 : 0;
  const confidencePct = clamp((agent.allocationScore / 1.8) * 100, 0, 100);
  const kpiGate = evaluateKpiGate({
    scope: 'agent',
    sampleCount: agent.trades,
    winRatePct: winRate,
    profitFactor,
    expectancy,
    netEdgeBps: undefined,
    confidencePct,
    drawdownPct: undefined
  });
  const cryptoSymbol = agent.config.symbol.endsWith('-USD');
  const gates: ReadinessGate[] = [
    {
      name: 'asset venue fit',
      passed: cryptoSymbol,
      actual: agent.config.symbol,
      required: 'Coinbase live rollout should start with crypto symbols only',
      severity: cryptoSymbol ? 'info' : 'blocker'
    },
    {
      name: 'broker-backed paper path',
      passed: agent.config.executionMode === 'broker-paper',
      actual: agent.config.executionMode,
      required: 'strategy must prove itself on a broker-backed paper route before live promotion',
      severity: 'blocker'
    },
    {
      name: 'sample size',
      passed: agent.trades >= 20,
      actual: `${agent.trades} trades`,
      required: 'at least 20 completed paper trades',
      severity: 'blocker'
    },
    {
      name: 'paper profitability',
      passed: agent.realizedPnl > 0 && profitFactor >= 1.25 && expectancy > 0,
      actual: `PnL ${round(agent.realizedPnl, 2)}, PF ${profitFactor.toFixed(2)}, expectancy ${expectancy.toFixed(2)}`,
      required: 'positive PnL, PF >= 1.25, expectancy > 0',
      severity: 'blocker'
    },
    {
      name: 'kpi ratio',
      passed: kpiGate.passed,
      actual: `${kpiGate.ratioPct.toFixed(1)}% (${kpiGate.grade})`,
      required: `>= ${kpiGate.thresholds.minRatioPct.toFixed(1)}% and no KPI blockers`,
      severity: 'blocker'
    },
    {
      name: 'win rate',
      passed: winRate >= 52,
      actual: `${winRate.toFixed(1)}%`,
      required: 'at least 52% paper win rate',
      severity: 'warning'
    },
    {
      name: 'spread discipline',
      passed: (symbol?.spreadBps ?? Infinity) <= Math.min(agent.config.spreadLimitBps, 5),
      actual: `${(symbol?.spreadBps ?? 999).toFixed(2)} bps`,
      required: '<= 5.00 bps on current tape',
      severity: 'warning'
    },
    {
      name: 'market data provenance',
      passed: engine.hasTradableTape(symbol),
      actual: symbol ? `${symbol.marketStatus}/${symbol.sourceMode}/${symbol.session}/${symbol.tradable ? 'tradable' : engine.describeTapeFlags(symbol)}` : 'missing',
      required: 'live regular-session tradable market snapshots for autonomous deployment',
      severity: 'blocker'
    },
    {
      name: 'size discipline',
      passed: agent.config.sizeFraction <= 0.12,
      actual: `${(agent.config.sizeFraction * 100).toFixed(2)}%`,
      required: '<= 12.00% of agent capital for first live deployment',
      severity: 'warning'
    }
  ];
  const eligible = gates.every((gate) => gate.passed || gate.severity === 'info');

  return {
    agentId: agent.config.id,
    agentName: agent.config.name,
    symbol: agent.config.symbol,
    eligible,
    mode: eligible ? 'candidate' : gates.some((gate) => gate.severity === 'blocker' && !gate.passed) ? 'blocked' : 'paper-only',
    realizedPnl: round(agent.realizedPnl, 2),
    trades: agent.trades,
    winRate: round(winRate, 1),
    profitFactor: round(profitFactor, 2),
    expectancy: round(expectancy, 2),
    kpiRatio: kpiGate.ratioPct,
    lastAdjustment: agent.lastAdjustment,
    gates
  };
}

export function toAgentSnapshot(engine: any, agent: any): PaperAgentSnapshot {
  const equity = engine.getAgentEquity(agent);
  const netPnl = engine.getAgentNetPnl(agent);
  const winRate = agent.trades === 0 ? 0 : (agent.wins / agent.trades) * 100;
  const symbol = engine.market.get(agent.config.symbol);
  const directionBias = agent.position
    ? engine.getPositionDirection(agent.position)
    : 'neutral';
  const executionQualityScore = getExecutionQualityByBroker(engine).find((row: any) => row.broker === agent.config.broker)?.score ?? 0;
  const sessionKpiGate = symbol ? engine.evaluateSessionKpiGate(symbol).message : 'Session gate unavailable.';
  const killSwitch = engine.getSymbolGuard(agent.config.symbol);
  const entryThrottle = symbol ? engine.getRegimeThrottleMultiplier(symbol) : 1;
  const operationalGate = engine.circuitBreakerLatched
    ? `Circuit breaker (${engine.circuitBreakerScope}) active.`
    : engine.operationalKillSwitchUntilMs > Date.now()
      ? `Operational kill switch until ${new Date(engine.operationalKillSwitchUntilMs).toISOString()}.`
      : 'clear';

  return {
    id: agent.config.id,
    name: agent.config.name,
    lane: 'scalping',
    broker: agent.config.broker,
    status: agent.status,
    equity,
    dayPnl: netPnl,
    realizedPnl: round(agent.realizedPnl, 2),
    feesPaid: round(agent.feesPaid, 2),
    returnPct: agent.startingEquity > 0 ? round((netPnl / agent.startingEquity) * 100, 2) : 0,
    winRate: round(winRate, 1),
    totalTrades: agent.trades,
    openPositions: agent.position ? 1 : 0,
    lastAction: agent.lastAction,
    lastSymbol: agent.lastSymbol,
    focus: agent.config.focus,
    lastExitPnl: round(agent.lastExitPnl, 2),
    directionBias,
    executionQualityScore: round(executionQualityScore, 1),
    sessionKpiGate,
    symbolKillSwitchUntil: killSwitch ? new Date(killSwitch.blockedUntilMs).toISOString() : null,
    entryThrottle: round(entryThrottle, 2),
    operationalGate,
    curve: [...agent.curve]
  };
}

export function getDeskAgentStates(engine: any): any[] {
  const activeStates = ['in-trade', 'entering', 'exiting'];
  const paperTradeAgents = Array.from(engine.agents.values()).filter(
    (agent: any) => activeStates.includes(agent.status) || agent.position !== null
  );
  const brokerPaperPilots = Array.from(engine.agents.values()).filter(
    (agent: any) => agent.config.executionMode === 'broker-paper' && agent.config.autonomyEnabled
  );

  const combined = [...new Set([...brokerPaperPilots, ...paperTradeAgents])];
  return combined.length > 0 ? combined : Array.from(engine.agents.values());
}

export function getVisibleFills(engine: any): any[] {
  const deskAgentIds = new Set(engine.getDeskAgentStates().map((agent: any) => agent.config.id));
  return engine.fills.filter((fill: any) => deskAgentIds.has(fill.agentId));
}

export function getDeskStartingEquity(engine: any): number {
  const alpacaBaseline = engine.brokerPaperAccount?.dayBaseline ?? 0;
  const oandaBaseline = engine.brokerOandaAccount?.dayBaseline ?? 0;
  // Coinbase: use STARTING_EQUITY as baseline (constant defined in paper-engine or imported)
  const coinbaseBaseline = engine.STARTING_EQUITY ?? 100000;
  const brokerTotal = alpacaBaseline + oandaBaseline + coinbaseBaseline;
  const agentStartingTotal = engine.getDeskAgentStates().reduce((sum: number, agent: any) => sum + agent.startingEquity, 0);

  if (brokerTotal < agentStartingTotal && agentStartingTotal > 0) {
    return round(agentStartingTotal, 2);
  }
  return round(brokerTotal, 2);
}

export function getDeskEquity(engine: any): number {
  const alpacaEquity = engine.brokerPaperAccount?.equity ?? 0;
  const oandaEquity = engine.brokerOandaAccount?.equity ?? 0;
  const cbAgents = Array.from(engine.agents.values()).filter((a: any) => a.config.broker === 'coinbase-live');
  const cbPaperPnl = cbAgents.reduce((s, a) => s + a.realizedPnl, 0);
  const coinbaseEquity = (engine.STARTING_EQUITY ?? 100000) + cbPaperPnl;
  const brokerTotal = alpacaEquity + oandaEquity + coinbaseEquity;
  const agentEquityTotal = engine.getDeskAgentStates().reduce((sum: number, agent: any) => sum + engine.getAgentEquity(agent), 0);

  if (brokerTotal < agentEquityTotal && agentEquityTotal > 0) {
    return round(agentEquityTotal, 2);
  }
  return round(brokerTotal, 2);
}

export function getMarketSnapshots(engine: any): any[] {
  return Array.from(engine.market.values()).map((symbol: any) => ({
    symbol: symbol.symbol,
    broker: symbol.broker,
    assetClass: symbol.assetClass,
    lastPrice: round(symbol.price, symbol.assetClass === 'equity' ? 2 : 2),
    changePct: symbol.openPrice > 0 ? ((symbol.price - symbol.openPrice) / symbol.openPrice) * 100 : 0,
    volume: Math.round(symbol.volume),
    spreadBps: round(symbol.spreadBps, 2),
    liquidityScore: Math.round(symbol.liquidityScore),
    status: symbol.marketStatus,
    source: symbol.sourceMode,
    session: symbol.session,
  }));
}

export function getSnapshot(engine: any): any {
  const agentStates = Array.from(engine.agents.values());
  const deskAgents = engine.getDeskAgentStates();
  const visibleFills = engine.getVisibleFills();
  const startingEquity = engine.getDeskStartingEquity();
  const agents = agentStates.map((agent: any) => engine.toAgentSnapshot(agent));
  const totalEquity = engine.getDeskEquity();
  const realizedPnl = agentStates.reduce((sum: number, agent: any) => sum + agent.realizedPnl, 0);
  const realizedFeesUsd = agentStates.reduce((sum: number, agent: any) => sum + agent.feesPaid, 0);
  const realizedGrossPnl = realizedPnl + realizedFeesUsd;
  const totalTrades = agentStates.reduce((sum: number, agent: any) => sum + agent.trades, 0);
  const totalWins = agentStates.reduce((sum: number, agent: any) => sum + agent.wins, 0);
  const analytics = engine.buildDeskAnalytics();

  return {
    asOf: new Date().toISOString(),
    chartWindow: `Last ${HISTORY_LIMIT} paper ticks`,
    startingEquity,
    totalEquity,
    totalDayPnl: totalEquity - startingEquity,
    totalReturnPct: startingEquity > 0 ? ((totalEquity - startingEquity) / startingEquity) * 100 : 0,
    realizedPnl,
    realizedGrossPnl,
    realizedFeesUsd,
    realizedReturnPct: (engine.STARTING_EQUITY ?? 100000) > 0 ? (realizedPnl / (engine.STARTING_EQUITY ?? 100000)) * 100 : 0,
    totalTrades,
    winRate: totalTrades === 0 ? 0 : (totalWins / totalTrades) * 100,
    activeAgents: deskAgents.filter((agent: any) => agent.status === 'in-trade' || agent.position !== null).length,
    deskCurve: [...engine.deskCurve],
    benchmarkCurve: [...engine.benchmarkCurve],
    agents,
    fills: visibleFills,
    marketFocus: engine.getMarketSnapshots(),
    aiCouncil: (() => {
      const live = engine.aiCouncil.getRecentDecisions();
      if (live.length > 0) return live;
      // Fall back to building decisions from traces
      const traces = engine.aiCouncil.getTraces(30);
      if (traces.length === 0) return [];
      const byDecision = new Map();
      for (const t of traces) {
        const key = t.decisionId ?? `${t.symbol}:${t.agentName}`;
        if (!byDecision.has(key)) {
          byDecision.set(key, {
            id: key,
            symbol: t.symbol,
            agentId: t.agentId,
            agentName: t.agentName ?? '',
            timestamp: t.timestamp,
            status: 'complete',
            finalAction: 'reject',
            reason: '',
            panel: []
          });
        }
        const d = byDecision.get(key);
        d.panel.push({
          provider: t.role,
          action: t.parsedAction ?? 'skip',
          confidence: t.parsedConfidence ?? 0,
          source: t.transport ?? 'cli',
          latencyMs: t.latencyMs ?? 0,
          timestamp: t.timestamp,
          thesis: t.parsedThesis ?? '',
          riskNote: t.parsedRiskNote ?? ''
        });
        if (t.parsedAction === 'approve' || (t.parsedAction === 'reject' && d.finalAction !== 'approve')) {
          d.finalAction = t.parsedAction;
        }
        if (!d.reason && t.parsedThesis) d.reason = t.parsedThesis.slice(0, 120);
      }
      return Array.from(byDecision.values()).slice(0, 8);
    })(),
    analytics,
    executionBands: engine.buildExecutionBands(),
    tuning: engine.buildStrategyTelemetry(),
    marketTape: engine.buildMarketTape(),
    sources: engine.getDataSources(),
    signals: engine.signalBus.getRecent(20),
    weeklyReportPath: engine.latestWeeklyReport?.path ?? null,
  };
}

export function getPositions(engine: any): any[] {
  return Array.from(engine.agents.values())
    .filter((agent: any) => agent.position && agent.config.executionMode !== 'broker-paper')
    .map((agent: any) => {
      const position = agent.position;
      const symbol = engine.market.get(agent.config.symbol);
      const entryPrice = round(position?.entryPrice ?? 0, 2);
      const markPrice = round(symbol?.price ?? entryPrice, 2);
      const quantity = round(position?.quantity ?? 0, 6);
      const unrealizedPnl = round(
        position ? engine.getPositionUnrealizedPnl(position, markPrice) : 0,
        2
      );
      const notional = entryPrice * quantity;
      const holdMinutes = (engine.tick - (position?.entryTick ?? engine.tick)) * (TICK_MS / 60_000);

      return {
        id: `${agent.config.id}-paper-position`,
        broker: engine.getAgentBroker(agent),
        symbol: agent.config.symbol,
        strategy: `${agent.config.name} / scalping`,
        assetClass: symbol?.assetClass ?? 'crypto',
        quantity,
        avgEntry: entryPrice,
        markPrice,
        unrealizedPnl,
        unrealizedPnlPct: notional > 0 ? round((unrealizedPnl / notional) * 100, 3) : 0,
        thesis: position?.note ?? agent.config.focus,
        openedAt: (holdMinutes + 1).toFixed(0) + 'm ago',
        source: 'paper-engine'
      };
    });
}

export function getRiskControlSnapshot(engine: any): any {
  return {
    circuitBreaker: {
      active: engine.circuitBreakerLatched,
      scope: engine.circuitBreakerScope,
      reason: engine.circuitBreakerReason,
      ...(engine.circuitBreakerArmedAt ? { armedAt: engine.circuitBreakerArmedAt } : {}),
      reviewed: engine.circuitBreakerReviewed
    },
    operationalKillSwitch: {
      active: engine.operationalKillSwitchUntilMs > Date.now(),
      reason: engine.operationalKillSwitchUntilMs > Date.now()
        ? 'Stale market data or high route latency detected.'
        : 'clear',
      until: engine.operationalKillSwitchUntilMs > Date.now()
        ? new Date(engine.operationalKillSwitchUntilMs).toISOString()
        : null
    },
    slo: engine.latestSlo
  };
}

export function getOpportunitySnapshot(engine: any) {
  return {
    asOf: new Date().toISOString(),
    selectedOverallId: engine.selectedScalpOverallId,
    selectedByLane: engine.selectedScalpOverallId ? { scalping: engine.selectedScalpOverallId } : {},
    selectedByAssetClass: Object.fromEntries(engine.selectedScalpByAssetClass.entries()) as Partial<Record<string, string>>,
    candidates: Array.from(engine.scalpRouteCandidates.values())
  };
}

export function getWalkForwardSnapshot(engine: any): any[] {
  return Array.from(engine.walkForwardResults.values());
}

export function getLossForensics(engine: any, limit = 12, symbol?: string): any[] {
  let rows = engine.forensicRows;
  if (symbol) {
    rows = rows.filter((r: any) => r.symbol === symbol);
  }
  return rows.slice(-limit).reverse();
}

export function getMetaLabelSnapshot(engine: any): any[] {
  return Array.from(engine.agents.values())
    .map((agent: any) => {
      const symbol = engine.market.get(agent.config.symbol);
      if (!symbol) return null;
      const decision = engine.getMetaLabelDecision(agent, symbol, 0, engine.marketIntel.getCompositeSignal(agent.config.symbol));
      return {
        agentId: agent.config.id,
        symbol: agent.config.symbol,
        style: agent.config.style,
        score: decision.probability * 100,
        approve: decision.approve,
        probability: decision.probability,
        reason: decision.reason
      };
    })
    .filter(Boolean);
}

export function hasTradableTape(engine: any, symbol: any): boolean {
  if (!symbol) return false;
  return (
    (symbol.marketStatus === 'live' || symbol.marketStatus === 'delayed')
    && symbol.sourceMode !== 'mock'
    && symbol.sourceMode !== 'simulated'
    && symbol.price > 0
    && symbol.tradable
    && symbol.qualityFlags.length === 0
    && (symbol.assetClass !== 'equity' || symbol.session === 'regular')
  );
}

export function describeTapeFlags(engine: any, symbol: any): string {
  if (symbol.qualityFlags.length > 0) {
    return symbol.qualityFlags.join(', ');
  }
  if (symbol.session !== 'regular' && symbol.assetClass === 'equity') {
    return `${symbol.session}-session`;
  }
  return `${symbol.marketStatus}/${symbol.sourceMode}`;
}

export function toCandles(engine: any, history: number[]) {
  const points = pickLast(history, 24);
  const candles = [];

  for (let index = 0; index < points.length; index += 3) {
    const window = points.slice(index, index + 3);
    if (window.length === 0) continue;
    const open = window[0] ?? 0;
    const close = window[window.length - 1] ?? open;
    candles.push({
      index: candles.length,
      open: round(open, 2),
      high: round(Math.max(...window), 2),
      low: round(Math.min(...window), 2),
      close: round(close, 2)
    });
  }

  return candles;
}

export function normalizePresentationState(engine: any): void {
  const currentDeskEquity = engine.getDeskEquity();
  const currentBenchmarkEquity = engine.getBenchmarkEquity();
  const latestDeskEquity = engine.deskCurve.at(-1);
  const latestBenchmarkEquity = engine.benchmarkCurve.at(-1);

  if (latestDeskEquity === undefined || Math.abs(latestDeskEquity - currentDeskEquity) > Math.max(500, Math.abs(currentDeskEquity) * 0.25)) {
    engine.deskCurve.splice(0, engine.deskCurve.length, currentDeskEquity);
  }

  if (latestBenchmarkEquity === undefined || Math.abs(latestBenchmarkEquity - currentBenchmarkEquity) > Math.max(500, Math.abs(currentBenchmarkEquity) * 0.25)) {
    engine.benchmarkCurve.splice(0, engine.benchmarkCurve.length, currentBenchmarkEquity);
  }
}
