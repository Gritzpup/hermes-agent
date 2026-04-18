// @ts-nocheck
import { round } from '../paper-engine-utils.js';
import { recordExpiredOrder } from './engine-broker-execution.js';
import { flattenOandaBeforeSessionEnd } from './engine-broker.js';

// Re-export everything from split modules so existing imports from engine-trading.js don't break
export {
  manageOpenPosition,
  openPosition,
  closePosition,
  updateArbAgent
} from './engine-trading-positions.js';

export {
  getPositionDirection,
  getPositionUnrealizedPnl,
  maybeTrailBrokerStop,
  getFeeRate,
  roundTripFeeBps,
  computeDynamicStop,
  computeDynamicTarget,
  resolveEntryDirection,
  computeGrossPnl,
  getSessionBucket,
  getVolatilityBucket,
  noteTradeOutcome,
  getAgentNetPnl,
  getAgentEquity,
  getDeskEquity,
  getBenchmarkEquity,
  computeHalfKelly,
  breachesCrowdingLimit,
  getEffectiveLeverage
} from './engine-trading-helpers.js';

// Local imports used by step() and updateAgent()
import { openPosition, closePosition, manageOpenPosition, updateArbAgent } from './engine-trading-positions.js';
import { buildCapitalAllocatorSnapshot } from '../capital-allocator.js';

export async function step(engine: any, isRedisTick = false): Promise<void> {
    if (engine.stepInFlight) {
      return;
    }
    engine.stepInFlight = true;

    try {
    engine.tick += 1;
    const { pushLog } = await import('../services/live-log.js');

    // Only perform heavy disk-polling sync if we ARE NOT in a high-speed Redis tick cycle
    if (!isRedisTick) {
      engine.syncMarketFromRuntime(true);
    }
    engine.analyzeSignals();
    engine.regimeKpis = engine.buildRegimeKpis();
    engine.evaluateSloAndOperationalKillSwitch();
    engine.evaluatePortfolioCircuitBreaker();

    // ── Firm capital ceiling: build snapshot → store on engine → pass to allocation ──
    // buildCapitalAllocatorSnapshot is the single source of truth for per-sleeve
    // targetWeightPct (which encodes SYMBOL_POLICY).  Storing it here so the engine's
    // refreshCapitalAllocation(snapshot) method can forward it down to CapitalManager
    // where Math.min(bandit, firmCap) enforces SYMBOL_POLICY as an absolute ceiling.
    const allocCtx = {
      asOf: new Date().toISOString(),
      capital: engine.getDeskEquity(),
      paperDesk: engine.buildDeskAnalytics(),
      liveReadiness: { overallEligible: false, agents: [] },
      opportunityPlan: { candidates: [], summary: '' },
      strategySnapshots: [],
      copySleeve: null,
      copyBacktest: null,
      macroSnapshot: null,
      macroBacktest: null,
    } satisfies Parameters<typeof buildCapitalAllocatorSnapshot>[0];
    const capitalAllocSnapshot = buildCapitalAllocatorSnapshot(allocCtx);
    engine._capitalAllocSnapshot = capitalAllocSnapshot;
    engine.refreshCapitalAllocation(capitalAllocSnapshot);
    engine.recordTickEvent();

    await engine.reconcileBrokerPaperState();
    // FIX: flatten OANDA positions before NY session close to avoid overnight financing bleed.
    // The $37.83 GBP_USD overnight charge was caused by positions held past 5PM ET close.
    flattenOandaBeforeSessionEnd(engine);
    engine.refreshScalpRoutePlan();
    await engine.processEventDrivenExitQueue();
    engine.maybeGenerateWeeklyReport();

    // Shadow Insider Bot: dynamically pivot to highest-conviction insider signal
    if (engine.tick % 60 === 0) {
      const shadowAgent = Array.from(engine.agents.values()).find((a) => a.config.id === 'agent-shadow-insider');
      if (shadowAgent && !shadowAgent.position) {
        const topSignal = engine.insiderRadar.getTopBullishSignal(0.6);
        if (topSignal) {
          const targetSymbol = topSignal.symbol.includes('-') || topSignal.symbol.includes('_')
            ? topSignal.symbol
            : topSignal.symbol; // Stock tickers don't need suffix for Alpaca
          if (targetSymbol !== shadowAgent.config.symbol && engine.market.has(targetSymbol)) {
            console.log(`[shadow-insider] Pivoting to ${targetSymbol} (conviction=${topSignal.convictionScore.toFixed(2)}, ${topSignal.direction}, cluster=${topSignal.isCluster})`);
            shadowAgent.config.symbol = targetSymbol;
            // Scale size with conviction: 0.6 → 3%, 0.8 → 5%, 1.0 → 6%
            shadowAgent.config.sizeFraction = round(0.03 + topSignal.convictionScore * 0.03, 3);
          }
        }
      }
    }

    for (const agent of engine.agents.values()) {
      await updateAgent(engine, agent);
    }

    // Log trade activity
    const states = Array.from(engine.agents.values());
    const inTrade = states.filter((a: any) => a.status === 'in-trade').length;
    const cooldown = states.filter((a: any) => a.status === 'cooldown').length;
    const totalTrades = states.reduce((s: number, a: any) => s + a.trades, 0);
    const totalPnl = states.reduce((s: number, a: any) => s + a.realizedPnl, 0);
    const deskEq = engine.getDeskEquity();

    // Live log: only emit meaningful events, not every agent's unchanged status
    pushLog('engine', `tick ${engine.tick} | ${inTrade} in-trade ${cooldown} cooldown | ${totalTrades} trades $${totalPnl.toFixed(2)} PnL | equity $${deskEq.toFixed(2)}`);

    // Only log agents that are actively doing something interesting
    for (const a of states as any[]) {
      const sym = engine.market.get(a.config.symbol);
      if (a.status === 'in-trade' && a.position && sym) {
        const pnl = engine.getPositionUnrealizedPnl(a.position, sym.price);
        pushLog(a.config.name, `IN TRADE ${a.config.symbol} @ ${sym.price.toFixed(2)} | unrealized ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
      } else if (a.status === 'cooldown' && a.cooldownRemaining <= 1) {
        pushLog(a.config.name, `cooldown ending | ${a.lastAction?.slice(0, 60) ?? ''}`);
      }
      // Only log action changes, not repeated identical status
    }

    if (engine.tick % 10 === 0) {
      console.log(`[engine] tick=${engine.tick} inTrade=${inTrade} cooldown=${cooldown} trades=${totalTrades} pnl=$${totalPnl.toFixed(2)} equity=$${deskEq.toFixed(2)}`);
    }

    // Feed council with active trade candidates every tick so the dashboard shows votes.
    // Pass the real composite-signal confidence instead of a hardcoded placeholder so the
    // rules fallback reflects actual conviction; otherwise every in-trade vote was stuck at
    // `score=5` (=> always 'review').
    for (const agent of engine.agents.values()) {
      if (agent.position || agent.status === 'in-trade') {
        const symbol = engine.market.get(agent.config.symbol);
        if (symbol) {
          const intel = engine.marketIntel.getCompositeSignal(symbol.symbol);
          const score = intel?.tradeable ? Math.min(10, Math.round((intel.confidence ?? 0) / 10)) : 0;
          engine.aiCouncil.requestDecision({
            agentId: agent.config.id, agentName: agent.config.name, symbol: symbol.symbol,
            style: agent.config.style, score, shortReturnPct: 0, mediumReturnPct: 0,
            lastPrice: symbol.price, spreadBps: symbol.spreadBps,
            liquidityScore: Math.round(symbol.liquidityScore), focus: agent.config.focus
          });
        }
      }
    }

    if (true) { // Always record history in paper engine during active steps
      engine.normalizePresentationState();
      engine.pushPoint(engine.deskCurve, engine.getDeskEquity());
      engine.pushPoint(engine.benchmarkCurve, engine.getBenchmarkEquity());
      engine.persistStateSnapshot();
    }
    } finally {
      engine.stepInFlight = false;
    }
  }

export async function updateAgent(engine: any, agent: any): Promise<void> {
    const symbol = engine.market.get(agent.config.symbol);
    if (!symbol) return;

    if (agent.config.executionMode === 'watch-only') {
      agent.status = 'watching';
      agent.lastAction = `${symbol.symbol} is watch-only until a broker-backed paper venue is enabled for this lane.`;
      engine.pushPoint(agent.curve, engine.getAgentEquity(agent));
      return;
    }

    // Arbitrage agents use a dedicated handler
    if (agent.config.style === 'arbitrage') {
      updateArbAgent(engine, agent, symbol);
      engine.pushPoint(agent.curve, engine.getAgentEquity(agent));
      return;
    }

    if (!agent.config.autonomyEnabled) {
      const activePilots = Array.from(engine.agents.values())
        .filter((candidate) => candidate.config.executionMode === 'broker-paper' && candidate.config.autonomyEnabled)
        .map((candidate) => candidate.config.symbol);
      agent.status = 'watching';
      agent.lastAction = `${symbol.symbol} is broker-backed but not armed for autonomous trading yet. Active pilot lanes: ${activePilots.join(', ') || 'none'}.`;
      engine.pushPoint(agent.curve, engine.getAgentEquity(agent));
      return;
    }

    const symbolGuard = engine.getSymbolGuard(symbol.symbol);
    if (!agent.position && symbolGuard) {
      agent.status = 'cooldown';
      agent.cooldownRemaining = Math.max(agent.cooldownRemaining, 2);
      agent.lastAction = `${symbol.symbol} kill-switch active until ${new Date(symbolGuard.blockedUntilMs).toISOString()}: ${symbolGuard.blockReason}`;
      engine.pushPoint(agent.curve, engine.getAgentEquity(agent));
      return;
    }

    if (agent.pendingOrderId) {
      // Auto-clear stuck pending orders after 10 ticks (~30 seconds)
      agent.cooldownRemaining = (agent.cooldownRemaining ?? 0) + 1;
      if (agent.cooldownRemaining > 10) {
        console.log(`[paper-engine] Clearing stuck pending order ${agent.pendingOrderId} for ${agent.config.symbol} after 10 ticks`);
        recordExpiredOrder(agent.pendingOrderId, agent.config.id, agent.pendingSide ?? 'buy');
        agent.pendingOrderId = null;
        agent.pendingSide = null;
        agent.cooldownRemaining = 2;
      } else {
        agent.status = 'cooldown';
        agent.lastAction = `Waiting for ${agent.pendingSide ?? 'broker'} order ${agent.pendingOrderId} to settle at ${engine.formatBrokerLabel(agent.config.broker)}.`;
        engine.pushPoint(agent.curve, engine.getAgentEquity(agent));
        return;
      }
    }

    const tapeQualityBlock = engine.getTapeQualityBlock(symbol);
    const liveTapeAvailable = !tapeQualityBlock;

    if (liveTapeAvailable) {
      engine.rollToLiveSampleWindow(agent, symbol);
    }

    if (agent.position && tapeQualityBlock) {
      await closePosition(engine, agent, symbol, 'tape quality gate');
      if (agent.position) {
        agent.lastAction = `Tried to flatten ${symbol.symbol} because the tape no longer met session/quote-quality rules, but the broker position is still open.`;
      }
      engine.pushPoint(agent.curve, engine.getAgentEquity(agent));
      return;
    }

    if (!agent.position && tapeQualityBlock) {
      agent.status = 'watching';
      agent.lastAction = tapeQualityBlock;
      engine.pushPoint(agent.curve, engine.getAgentEquity(agent));
      return;
    }

    const riskOff = engine.signalBus.hasRecentSignalOfType('risk-off', 30_000);
    if (riskOff && (riskOff.severity === 'warning' || riskOff.severity === 'critical') && !agent.position) {
      agent.cooldownRemaining = Math.max(agent.cooldownRemaining, 2);
    }

    const spreadSignal = engine.signalBus.hasRecentSignal('spread-expansion', symbol.symbol, 30_000);
    if (spreadSignal && !agent.position) {
      agent.status = 'watching';
      agent.lastAction = `Skipping ${symbol.symbol} entry: ${spreadSignal.message}`;
      engine.pushPoint(agent.curve, engine.getAgentEquity(agent));
      return;
    }

    const shortReturn = engine.relativeMove(symbol.history, 4);
    const mediumReturn = engine.relativeMove(symbol.history, 8);
    const spreadOkay = symbol.spreadBps <= agent.config.spreadLimitBps;
    const score = engine.getEntryScore(agent.config.style, shortReturn, mediumReturn, symbol);
    // Market intelligence gate: only enter in direction of confirmed order flow
    const intel = engine.marketIntel.getCompositeSignal(symbol.symbol);
    const intelBlocked = intel.tradeable && (
      (score > 0 && (intel.direction === 'sell' || intel.direction === 'strong-sell')) ||
      (score < 0 && (intel.direction === 'buy' || intel.direction === 'strong-buy'))
    );
    const newsSignal = engine.newsIntel.getSignal(symbol.symbol);
    const macroNews = engine.newsIntel.getMacroSignal();
    const calendarEmbargo = engine.eventCalendar.getEmbargo(symbol.symbol);
    // In paper mode, skip all news blocks — agents need to trade to collect data
    const newsBlocked = false;

    if (!agent.position && newsBlocked) {
      agent.status = 'watching';
      agent.lastAction = newsSignal.veto
        ? `News veto on ${symbol.symbol}: ${newsSignal.reasons[0] ?? 'critical symbol-specific headline risk.'}`
        : `Skipping ${symbol.symbol}: news flow leans ${newsSignal.direction} with ${newsSignal.confidence}% confidence.`;
      engine.pushPoint(agent.curve, engine.getAgentEquity(agent));
      return;
    }

    const metaDecision = engine.getMetaLabelDecision(agent, symbol, score, intel);
    if (!agent.position && !metaDecision.approve) {
      agent.status = 'watching';
      agent.lastAction = `Meta-label veto on ${symbol.symbol}: ${metaDecision.reason}`;
      engine.pushPoint(agent.curve, engine.getAgentEquity(agent));
      return;
    }

    const entryAllowed = !intelBlocked && !newsBlocked && metaDecision.approve && engine.canEnter(agent, symbol, shortReturn, mediumReturn, score);
    const strongRulesApproval = agent.config.executionMode !== 'broker-paper' && score >= engine.fastPathThreshold(agent.config.style);
    const aiDecision = entryAllowed
      ? engine.aiCouncil.requestDecision({
          agentId: agent.config.id,
          agentName: agent.config.name,
          symbol: symbol.symbol,
          style: agent.config.style,
          score,
          shortReturnPct: shortReturn * 100,
          mediumReturnPct: mediumReturn * 100,
          lastPrice: symbol.price,
          spreadBps: symbol.spreadBps,
          liquidityScore: Math.round(symbol.liquidityScore),
          focus: agent.config.focus,
          newsSummary: newsSignal.articleCount > 0
            ? `${newsSignal.direction} news ${newsSignal.confidence}%: ${newsSignal.reasons[0] ?? 'recent symbol headlines'}`
            : 'No meaningful symbol-specific news signal.',
          macroSummary: macroNews.articleCount > 0
            ? `${macroNews.direction} macro ${macroNews.confidence}%: ${macroNews.reasons[0] ?? 'recent macro headlines'}`
            : 'No meaningful macro news signal.'
        })
      : null;
    const brokerRulesApproval = entryAllowed && engine.canUseBrokerRulesFastPath(agent, symbol, score, aiDecision);
    const routeBlock = engine.getRouteBlock(agent, symbol);
    const precisionBlock = engine.getPrecisionBlock(agent, symbol);
    const managerBlock = engine.getManagerBlock(agent, symbol);

    if (agent.position) {
      await manageOpenPosition(engine, agent, symbol, score);
    } else if (routeBlock) {
      agent.status = 'cooldown';
      agent.cooldownRemaining = Math.max(agent.cooldownRemaining, 4);
      agent.lastAction = routeBlock;
    } else if (precisionBlock) {
      agent.status = 'cooldown';
      agent.cooldownRemaining = Math.max(agent.cooldownRemaining, 4);
      agent.lastAction = precisionBlock;
    } else if (managerBlock) {
      agent.status = 'cooldown';
      agent.cooldownRemaining = Math.max(agent.cooldownRemaining, 3);
      agent.lastAction = managerBlock;
    } else if (agent.cooldownRemaining > 0) {
      agent.cooldownRemaining -= 1;
      agent.status = 'cooldown';
      agent.lastAction = `Cooling down after ${agent.lastSymbol} scalp.`;
    } else if (spreadOkay && entryAllowed) {
      if (aiDecision?.status === 'complete') {
        if (aiDecision.finalAction === 'approve') {
          await openPosition(engine, agent, symbol, score);
        } else if (brokerRulesApproval) {
          await openPosition(engine, agent, symbol, score);
          agent.lastAction = `${agent.lastAction} Entered on manager rules fast-path.`;
        } else {
          // Hard veto: council says review/reject → hold. Applies to paper and live alike.
          // (Previously paper-broker mode bypassed the veto "to collect data"; that turned
          // the council into theater. Data now comes from trades the council approved.)
          agent.status = 'watching';
          agent.lastAction = engine.describeAiState(aiDecision);
        }
      } else if (strongRulesApproval || brokerRulesApproval) {
        await openPosition(engine, agent, symbol, score);
        agent.lastAction = brokerRulesApproval
          ? `${agent.lastAction} Entered on manager rules fast-path while AI council runs in advisory mode.`
          : `${agent.lastAction} Entered on strong rules fast-path while AI council reviews the setup in parallel.`;
      } else if (aiDecision) {
        agent.status = 'watching';
        agent.lastAction = engine.describeAiState(aiDecision);
      } else {
        agent.status = 'watching';
        agent.lastAction = engine.describeWatchState(agent.config.style, symbol, score);
      }
    } else {
      agent.status = 'watching';
      agent.lastAction = engine.describeWatchState(agent.config.style, symbol, score);
    }

    engine.pushPoint(agent.curve, engine.getAgentEquity(agent));
  }
