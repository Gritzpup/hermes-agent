// @ts-nocheck
import { randomUUID } from 'node:crypto';
import { round } from '../paper-engine-utils.js';
import { TICK_MS } from './types.js';
import { btcStopoutAt } from './engine-compute.js';

const OUTCOME_HISTORY_LIMIT = 200;

// FIX: wall-clock max hold gates by asset class (defense in depth alongside tick-based).
// These survive engine restarts and tick drift — tick-based alone breaks if engine.tick
// resets or if TICK_MS drifts from the assumed 1000ms.
// forex: 2h (avoid overnight financing), crypto: 30min, equity: 1h, bond: 4h, commodity: 2h.
const MAX_HOLD_MS: Record<string, number> = {
  forex:    2 * 60 * 60 * 1000,  // 2 hours
  crypto:   30 * 60 * 1000,       // 30 minutes
  equity:   60 * 60 * 1000,        // 1 hour
  bond:     4  * 60 * 60 * 1000,  // 4 hours
  commodity: 2 * 60 * 60 * 1000,  // 2 hours
  default:  60 * 60 * 1000,        // 1 hour fallback
};

export async function manageOpenPosition(engine: any, agent: any, symbol: any, score: number): Promise<void> {
    const position = agent.position;
    if (!position) return;
    engine.maybeTrailBrokerStop(agent, symbol);
    const direction = engine.getPositionDirection(position);
    const directionalMaxHoldTicks = symbol.assetClass === 'crypto' && direction === 'short'
      ? Math.max(6, Math.floor(agent.config.maxHoldTicks * 0.85))
      : agent.config.maxHoldTicks;
    position.peakPrice = direction === 'short'
      ? Math.min(position.peakPrice, symbol.price)
      : Math.max(position.peakPrice, symbol.price);

    const holdTicks = Math.max(0, engine.tick - position.entryTick);

    // FIX: wall-clock max hold — survives engine restart and tick drift.
    const assetClass = symbol.assetClass ?? 'default';
    const maxHoldMs = MAX_HOLD_MS[assetClass] ?? MAX_HOLD_MS.default;
    const entryAtMs = position.entryAt ? new Date(position.entryAt).getTime() : Date.now() - holdTicks * TICK_MS;
    const heldMs = Date.now() - entryAtMs;
    if (heldMs > maxHoldMs) {
      await closePosition(engine, agent, symbol, `wall-clock max hold (${(heldMs / 60000).toFixed(0)}min > ${(maxHoldMs / 60000).toFixed(0)}min ${assetClass} limit)`);
      return;
    }

    const effectiveSpreadBps = Math.max(symbol.spreadBps, 3);
    const exitSpreadCost = position.entryPrice * (effectiveSpreadBps / 10_000);
    const breakEvenPrice = direction === 'short'
      ? position.entryPrice - exitSpreadCost
      : position.entryPrice + exitSpreadCost;
    const gain = direction === 'short'
      ? breakEvenPrice - symbol.price
      : symbol.price - breakEvenPrice;
    const peakGain = direction === 'short'
      ? breakEvenPrice - position.peakPrice
      : position.peakPrice - breakEvenPrice;
    const isGreen = gain >= 0;

    const directionalReturnPct = direction === 'short'
      ? ((position.entryPrice - symbol.price) / position.entryPrice) * 100
      : ((symbol.price - position.entryPrice) / position.entryPrice) * 100;

    if ((direction === 'short' && symbol.price <= position.targetPrice) || (direction === 'long' && symbol.price >= position.targetPrice)) {
      await closePosition(engine, agent, symbol, `target reached (+${directionalReturnPct.toFixed(2)}%)`);
      return;
    }

    if (peakGain > exitSpreadCost && gain > 0 && gain < peakGain * 0.5 && holdTicks >= 5) {
      await closePosition(engine, agent, symbol, `trailing stop (locked ${((gain / position.entryPrice) * 10000).toFixed(1)}bps of ${((peakGain / position.entryPrice) * 10000).toFixed(1)}bps peak)`);
      return;
    }

    const embargo = engine.eventCalendar.getEmbargo(symbol.symbol);
    if (embargo.blocked && holdTicks >= 3) {
      if (isGreen) {
        await closePosition(engine, agent, symbol, `embargo exit green (${embargo.reason})`);
        return;
      }
      const lossFromBreakeven = Math.abs((symbol.price - breakEvenPrice) / position.entryPrice) * 10_000;
      if (lossFromBreakeven < 5) {
        await closePosition(engine, agent, symbol, `embargo exit near-BE (${embargo.reason}, -${lossFromBreakeven.toFixed(1)}bps)`);
        return;
      }
    }

    if (holdTicks >= directionalMaxHoldTicks && isGreen) {
      await closePosition(engine, agent, symbol, `time stop green (+${((gain / position.entryPrice) * 10000).toFixed(1)}bps)`);
      return;
    }

    // FIX: tighten catastrophic stop for forex/bond/commodity to prevent overnight gap risk.
    // GBP_USD suffered 2 losses of ~$1,000 each with the 2% crypto-level stop. For forex,
    // 2% = 200+ pip stop on GBP/USD, which is far too loose for intraday. Tighter stops:
    //   forex/equity: momentum=0.75% (75pip EUR/GBP), breakout=0.60%, mean-reversion=0.50%
    //   bond/commodity: similar to forex — tighter than crypto defaults
    //   crypto: keep existing (momentum=0.98=2%, breakout=0.985=1.5%, mean-reversion=0.99=1%)
    // The wall-clock max hold (2h forex, 30min crypto) provides the primary time exit;
    // catastrophic stop is the last-resort safety net for flash crashes / weekend gaps.
    const styleDefaults: Record<string, Record<string, number>> = {
      crypto:   { momentum: 0.98, breakout: 0.985, 'mean-reversion': 0.99 },
      forex:   { momentum: 0.75, breakout: 0.60, 'mean-reversion': 0.50 },
      equity:  { momentum: 0.75, breakout: 0.60, 'mean-reversion': 0.50 },
      bond:    { momentum: 0.75, breakout: 0.60, 'mean-reversion': 0.50 },
      commodity: { momentum: 0.75, breakout: 0.60, 'mean-reversion': 0.50 },
    };
    const assetDefaults = styleDefaults[symbol.assetClass] ?? styleDefaults.crypto!;
    const catastrophicPct = assetDefaults[agent.config.style] ?? 0.98;
    const catastrophicStop = direction === 'short'
      ? position.entryPrice * (1 + (1 - catastrophicPct))
      : position.entryPrice * catastrophicPct;
    if ((direction === 'short' && symbol.price >= catastrophicStop) || (direction === 'long' && symbol.price <= catastrophicStop)) {
      await closePosition(engine, agent, symbol, `catastrophic stop (${((1 - catastrophicPct) * 100).toFixed(1)}%)`);
      return;
    }

    if (holdTicks >= directionalMaxHoldTicks * 3) {
      await closePosition(engine, agent, symbol, `extended hold cut (${holdTicks} ticks, ${directionalReturnPct.toFixed(3)}%)`);
      return;
    }

    agent.status = 'in-trade';
    agent.lastAction = `Managing ${symbol.symbol} ${direction} scalp with ${holdTicks}/${directionalMaxHoldTicks} ticks elapsed.`;
  }

export async function openPosition(engine: any, agent: any, symbol: any, score: number): Promise<void> {
    // Record a council decision for every trade entry so the dashboard shows votes
    const newsSignal = engine.newsIntel.getSignal(symbol.symbol);
    const macroNews = engine.newsIntel.getMacroSignal();
    const decision = engine.aiCouncil.requestDecision({
      agentId: agent.config.id,
      agentName: agent.config.name,
      symbol: symbol.symbol,
      style: agent.config.style,
      score,
      shortReturnPct: 0,
      mediumReturnPct: 0,
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
    });

    const entryMeta = engine.buildEntryMeta(agent, symbol, score);
    const direction = engine.resolveEntryDirection(agent, symbol, score);
    if (!entryMeta.tags.includes(`dir-${direction}`)) {
      entryMeta.tags = [...entryMeta.tags, `dir-${direction}`];
    }
    agent.pendingCouncilDecision = decision;
    if (agent.config.executionMode === 'broker-paper') {
      await engine.openBrokerPaperPosition(agent, symbol, score, entryMeta, decision, direction);
      return;
    }

    const sizedFraction = agent.config.sizeFraction * agent.allocationMultiplier;
    const notional = Math.min(engine.getAgentEquity(agent) * sizedFraction, agent.cash * 0.9);
    if (notional <= 50) {
      agent.status = 'watching';
      agent.lastAction = 'Waiting for capital recycle after recent trades.';
      return;
    }

    const fillPrice = direction === 'short'
      ? symbol.price * (1 - (symbol.spreadBps / 10_000) * 0.25)
      : symbol.price * (1 + (symbol.spreadBps / 10_000) * 0.25);
    const quantity = notional / fillPrice;

    const entryFees = quantity * fillPrice * engine.getFeeRate(symbol.assetClass);
    agent.cash -= (notional + entryFees);
    agent.realizedPnl -= entryFees;
    agent.feesPaid = round(agent.feesPaid + entryFees, 4);
    agent.position = {
      direction,
      quantity,
      entryPrice: fillPrice,
      entryTick: engine.tick,
      entryAt: new Date().toISOString(),
      stopPrice: engine.computeDynamicStop(fillPrice, agent, symbol, direction),
      targetPrice: engine.computeDynamicTarget(fillPrice, agent, symbol, direction),
      peakPrice: fillPrice,
      note: engine.entryNote(agent.config.style, symbol, score),
      entryMeta
    };
    agent.status = 'in-trade';
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = agent.position.note;
    engine.recordFill({
      agent,
      symbol,
      orderId: `sim-${agent.config.id}-${direction === 'short' ? 'sell' : 'buy'}-${Date.now()}`,
      side: direction === 'short' ? 'sell' : 'buy',
      status: 'filled',
      price: fillPrice,
      pnlImpact: -entryFees,
      note: engine.entryNote(agent.config.style, symbol, score),
      councilAction: decision.finalAction,
      councilConfidence: Math.max(decision.primary.confidence, decision.challenger?.confidence ?? 0),
      councilReason: decision.reason
    });
    console.log(`[TRADE] ${agent.config.name} OPEN ${direction.toUpperCase()} ${symbol.symbol} price=$${fillPrice.toFixed(2)} qty=${quantity.toFixed(6)} notional=$${(quantity * fillPrice).toFixed(2)} broker=${agent.config.broker} council=${decision.finalAction}`);
    engine.persistStateSnapshot();
  }

const BTC_STOPOUT_REASONS = new Set(['stop-loss', 'trailing stop', 'catastrophic stop']);

export async function closePosition(engine: any, agent: any, symbol: any, reason: string, forcePnl?: number): Promise<void> {
    // Record BTC-USD stopout timestamp for 15-min re-entry block.
    // Allowlist excludes 'time stop green' (profitable time exit) and any other non-loss exit.
    if (symbol.symbol === 'BTC-USD') {
      const reasonBase = reason.toLowerCase().split('(')[0].trim();
      if (BTC_STOPOUT_REASONS.has(reasonBase)) {
        btcStopoutAt.set('BTC-USD', Date.now());
      }
    }
    if (agent.config.executionMode === 'broker-paper') {
      await engine.closeBrokerPaperPosition(agent, symbol, reason);
      return;
    }

    const position = agent.position;
    if (!position) return;

    const direction = engine.getPositionDirection(position);
    const exitPrice = direction === 'short'
      ? symbol.price * (1 + (symbol.spreadBps / 10_000) * 0.25)
      : symbol.price * (1 - (symbol.spreadBps / 10_000) * 0.25);
    const grossPnl = engine.computeGrossPnl(position, exitPrice, position.quantity);
    const fees = position.quantity * exitPrice * engine.getFeeRate(symbol.assetClass);
    const realized = forcePnl !== undefined ? forcePnl : grossPnl - fees;
    const costBasis = position.entryPrice * position.quantity;
    engine.noteTradeOutcome(agent, symbol, realized, reason);

    agent.cash += costBasis + realized;
    agent.realizedPnl = round(agent.realizedPnl + realized, 2);
    agent.feesPaid = round(agent.feesPaid + fees, 4);
    agent.lastExitPnl = realized;
    agent.trades += 1;
    if (realized >= 0) {
      agent.wins += 1;
    } else {
      agent.losses += 1;
    }
    console.log(`[TRADE] ${agent.config.name} CLOSE ${symbol.symbol} pnl=$${realized.toFixed(4)} entry=$${position.entryPrice.toFixed(2)} exit=$${exitPrice.toFixed(2)} reason=${reason} total_trades=${agent.trades} total_pnl=$${agent.realizedPnl.toFixed(2)}`);

    const realizedPnlPct = (realized / costBasis) * 100;
    const verdict = realized > 0 ? 'winner' : realized < 0 ? 'loser' : 'scratch';
    const aiComment = realized >= 0
      ? 'The setup worked because the entry waited for spread compression before committing size.'
      : 'The setup lost edge before the tape could follow through. Tightening entry quality matters more than trading more often.';
    const holdTicks = engine.tick - position.entryTick;
    const journalContext = engine.buildJournalContext(symbol);

    // FIX 2b: Compute realized round-trip cost (simulated path)
    const entrySpreadBps = typeof position.entryMeta?.estimatedCostBps === 'number'
      ? Math.max(0, (position.entryMeta.estimatedCostBps - symbol.spreadBps) / 2)
      : symbol.spreadBps;
    const avgNotional = (position.entryPrice + exitPrice) / 2 * position.quantity;
    const feeBps = avgNotional > 0 ? round((fees / avgNotional) * 10_000, 2) : 0;
    const realizedCostBps = round(entrySpreadBps + symbol.spreadBps + feeBps, 2);

    engine.recordFill({
      agent,
      symbol,
      orderId: `sim-${agent.config.id}-${direction === 'short' ? 'buy' : 'sell'}-${Date.now()}`,
      side: direction === 'short' ? 'buy' : 'sell',
      status: 'filled',
      price: exitPrice,
      pnlImpact: realized,
      note: `Closed paper scalp at ${round(exitPrice, 2)} on ${reason}.`,
      source: 'simulated'
    });
    engine.recordJournal({
      id: `paper-journal-${Date.now()}-${agent.config.id}-${randomUUID()}`,
      symbol: symbol.symbol,
      assetClass: symbol.assetClass,
      broker: agent.config.broker,
      strategy: `${agent.config.name} / scalping`,
      strategyId: agent.config.id,
      lane: 'scalping',
      thesis: position.note,
      entryAt: position.entryAt ?? new Date().toISOString(),
      entryTimestamp: position.entryAt ?? new Date().toISOString(),
      exitAt: new Date().toISOString(),
      realizedPnl: round(realized, 2),
      realizedPnlPct: round(realizedPnlPct, 3),
      slippageBps: round(symbol.spreadBps * 0.25, 2),
      spreadBps: round(symbol.spreadBps, 2),
      realizedCostBps,
      holdTicks,
      confidencePct: journalContext.confidencePct,
      regime: journalContext.regime,
      newsBias: journalContext.newsBias,
      orderFlowBias: journalContext.orderFlowBias,
      macroVeto: journalContext.macroVeto,
      embargoed: journalContext.embargoed,
      tags: [...journalContext.tags, `dir-${direction}`],
      ...(position.entryMeta ? {
        entryScore: position.entryMeta.score,
        entryHeuristicProbability: position.entryMeta.heuristicProbability,
        entryContextualProbability: position.entryMeta.contextualProbability,
        entryTrainedProbability: position.entryMeta.trainedProbability,
        entryApprove: position.entryMeta.approve,
        entryReason: position.entryMeta.reason,
        entryConfidencePct: position.entryMeta.confidencePct,
        entryRegime: position.entryMeta.regime,
        entryNewsBias: position.entryMeta.newsBias,
        entryOrderFlowBias: position.entryMeta.orderFlowBias,
        entryMacroVeto: position.entryMeta.macroVeto,
        entryEmbargoed: position.entryMeta.embargoed,
        entryTags: position.entryMeta.tags,
        estimatedCostBps: position.entryMeta.estimatedCostBps,
        expectedGrossEdgeBps: position.entryMeta.expectedGrossEdgeBps,
        expectedNetEdgeBps: position.entryMeta.expectedNetEdgeBps
      } : {}),
      aiComment,
      exitReason: reason,
      verdict,
      source: 'simulated'
    });

    engine.pushPoint(agent.recentOutcomes, round(realized, 2), OUTCOME_HISTORY_LIMIT);
    engine.pushPoint(agent.recentHoldTicks, holdTicks, OUTCOME_HISTORY_LIMIT);
    engine.checkSymbolKillswitch(agent);
    engine.applyAdaptiveTuning(agent, symbol);
    engine.evaluateChallengerProbation(agent, symbol);

    agent.position = null;
    agent.status = 'cooldown';
    agent.cooldownRemaining = engine.getAdaptiveCooldown(agent, symbol);
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = `Booked ${realized >= 0 ? 'gain' : 'loss'} on ${symbol.symbol}: ${round(realized, 2)} after ${reason}.`;
    engine.persistStateSnapshot();
  }

export function updateArbAgent(engine: any, agent: any, symbol: any): void {
    if (!agent.config.autonomyEnabled) {
      agent.status = 'watching';
      agent.lastAction = `Arb scanner disabled — autonomy not enabled.`;
      return;
    }

    if (agent.cooldownRemaining > 0) {
      agent.cooldownRemaining -= 1;
      agent.status = 'cooldown';
      return;
    }

    // Find the same symbol on the OTHER broker
    const myBroker = agent.config.broker;
    const counterBroker = myBroker === 'coinbase-live' ? 'alpaca-paper' : 'coinbase-live';

    // Find any agent on the counter-broker trading the same symbol to get its price view
    const counterAgent = Array.from(engine.agents.values()).find(
      (other) => other.config.symbol === agent.config.symbol && other.config.broker === counterBroker
    );
    const counterSymbol = counterAgent ? engine.market.get(counterAgent.config.symbol) : null;

    if (!counterSymbol || counterSymbol.price <= 0 || symbol.price <= 0) {
      agent.status = 'watching';
      agent.lastAction = `Waiting for price data on both venues for ${symbol.symbol}.`;
      return;
    }

    // If already in an arb position, check exit
    if (agent.position) {
      const holdTicks = engine.tick - agent.position.entryTick;
      const gain = symbol.price - agent.position.entryPrice;

      // Close arb after short hold or if spread collapsed
      if (holdTicks >= agent.config.maxHoldTicks || gain > 0) {
        const pnl = gain * agent.position.quantity;
        agent.cash += (agent.position.entryPrice * agent.position.quantity) + pnl;
        agent.realizedPnl = round(agent.realizedPnl + pnl, 2);
        agent.lastExitPnl = pnl;
        agent.trades += 1;
        if (pnl > 0) agent.wins += 1;
        console.log(`[ARB] ${agent.config.name} closed ${symbol.symbol} arb: pnl=$${pnl.toFixed(4)} hold=${holdTicks} ticks`);
        engine.pushPoint(agent.recentOutcomes, round(pnl, 2), OUTCOME_HISTORY_LIMIT);
        const exitPrice = symbol.price;
        engine.recordFill({
          agent, symbol,
          orderId: `arb-${agent.config.id}-exit-${Date.now()}`,
          side: 'sell', status: 'filled', price: exitPrice, pnlImpact: round(pnl, 4),
          note: `Arb exit ${symbol.symbol}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)} after ${holdTicks} ticks`,
          source: 'simulated'
        });
        agent.position = null;
        agent.status = 'cooldown';
        agent.cooldownRemaining = engine.getAdaptiveCooldown(agent, symbol);
        agent.lastAction = `Arb closed on ${symbol.symbol}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(4)}`;
        return;
      }

      agent.status = 'in-trade';
      agent.lastAction = `Holding ${symbol.symbol} arb position (${holdTicks}/${agent.config.maxHoldTicks} ticks).`;
      return;
    }

    // Detect arb opportunity: Coinbase native orderbook vs Alpaca pass-through pricing
    // Coinbase (native exchange) typically has tighter spreads than Alpaca (market maker markup).
    // Use the orderflow data from market-intel to model the real Coinbase bid/ask.
    const orderFlow = engine.marketIntel.getSnapshot().orderFlow.find((f) => f.symbol === symbol.symbol);
    const coinbaseMid = symbol.price;
    const coinbaseSpreadBps = orderFlow?.spreadBps ?? symbol.spreadBps;
    // Alpaca adds ~3-8bps markup on top of exchange price for crypto
    const alpacaMarkupBps = symbol.assetClass === 'crypto' ? 5 : 2;
    const alpacaMid = coinbaseMid * (1 + alpacaMarkupBps / 10_000);
    const spreadBetweenVenues = Math.abs(alpacaMid - coinbaseMid);
    const spreadBps = (spreadBetweenVenues / coinbaseMid) * 10_000;

    // Arb edge = venue spread minus both sides' execution costs
    const totalCostBps = coinbaseSpreadBps + symbol.spreadBps + 2; // 2bps safety margin
    const arbEdgeBps = spreadBps - totalCostBps;

    if (arbEdgeBps <= 0) {
      agent.status = 'watching';
      agent.lastAction = `Scanning ${symbol.symbol} arb: venue spread ${spreadBps.toFixed(1)}bps, cost ${totalCostBps.toFixed(1)}bps, no edge.`;
      return;
    }

    // Arb detected! Buy on cheaper venue (Coinbase native is typically cheaper)
    const buyPrice = Math.min(coinbaseMid, alpacaMid);
    const notional = engine.getAgentEquity(agent) * agent.config.sizeFraction * agent.allocationMultiplier;
    if (notional <= 50) {
      agent.status = 'watching';
      agent.lastAction = 'Arb detected but insufficient capital.';
      return;
    }

    const quantity = round(notional / buyPrice, 6);
    agent.cash -= notional;
    const arbNote = `Arb entry: ${spreadBps.toFixed(1)}bps venue spread, ${arbEdgeBps.toFixed(1)}bps edge after costs. Buy@${buyPrice.toFixed(2)} (${coinbaseMid < alpacaMid ? 'Coinbase' : 'Alpaca'} cheaper).`;
    agent.position = {
      direction: 'long',
      quantity,
      entryPrice: buyPrice,
      entryTick: engine.tick,
      entryAt: new Date().toISOString(),
      stopPrice: buyPrice * 0.999,
      targetPrice: buyPrice * (1 + arbEdgeBps / 10_000),
      peakPrice: buyPrice,
      note: arbNote
    };
    agent.status = 'in-trade';
    agent.lastSymbol = symbol.symbol;
    agent.lastAction = `ARB ENTRY: ${symbol.symbol} ${arbEdgeBps.toFixed(1)}bps edge, bought at ${buyPrice.toFixed(2)}`;
    console.log(`[ARB] ${agent.config.name} entered ${symbol.symbol}: edge=${arbEdgeBps.toFixed(1)}bps, qty=${quantity}, notional=$${notional.toFixed(2)}`);

    engine.recordFill({
      agent, symbol,
      orderId: `arb-${agent.config.id}-${Date.now()}`,
      side: 'buy', status: 'filled', price: buyPrice, pnlImpact: 0,
      note: arbNote,
      source: 'simulated'
    });
  }
