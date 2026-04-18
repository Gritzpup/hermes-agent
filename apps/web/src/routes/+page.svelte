<script lang="ts">
  import { onMount } from 'svelte';
  import type {
    BrokerAccountSnapshot,
    LaneRollup,
    OverviewSnapshot,
    PaperDeskSnapshot,
    PositionSnapshot,
    ResearchCandidate
  } from '@hermes/contracts';
  import type { PageData } from './$types';
  import { currency, percent, signed } from '$lib/format';
  import MetricCard from '$lib/components/MetricCard.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import StatusPill from '$lib/components/StatusPill.svelte';
  import CapitalAllocatorSection from '$lib/components/CapitalAllocatorSection.svelte';
  import PilotProgressSection from '$lib/components/PilotProgressSection.svelte';
  import LearningHistorySection from '$lib/components/LearningHistorySection.svelte';
  import AiCouncilTraceSection from '$lib/components/AiCouncilTraceSection.svelte';
  import CopySleeveSection from '$lib/components/CopySleeveSection.svelte';
  import MacroPreservationSection from '$lib/components/MacroPreservationSection.svelte';
  import QuarterOutlookSection from '$lib/components/QuarterOutlookSection.svelte';
  import InsiderRadarSection from '$lib/components/InsiderRadarSection.svelte';
  import TerminalsSection from '$lib/components/TerminalsSection.svelte';
  import VenueMatrixSection from '$lib/components/VenueMatrixSection.svelte';
  import DashboardDiagnosticsSection from '$lib/components/DashboardDiagnosticsSection.svelte';
  import MarketSignalsSection from '$lib/components/MarketSignalsSection.svelte';
  import TapeChart from '$lib/components/TapeChart.svelte';
  import BrokerStripSection from '$lib/components/BrokerStripSection.svelte';
  import ExecutionAnalyticsSection from '$lib/components/ExecutionAnalyticsSection.svelte';
  import TraderScoreboardSection from '$lib/components/TraderScoreboardSection.svelte';
  import {
    createSyntheticLiveRouteAccount,
    isBrokerConnected
  } from '$lib/broker-status';
  import { dashboardResourceStatus, startGlobalSSE, stopGlobalSSE } from '$lib/sse-store';
  import {
    councilSources,
    formatCouncilSource,
    formatCouncilVoteLabel,
    getCouncilSourceCounts,
    getCouncilSourceSummary
  } from '$lib/council';
  import { primeProfitAudio, syncProfitAudio } from '$lib/services/profit-audio';

  export let data: PageData;

  const BROKER_STARTING_EQUITY = 100_000;

  let overview: OverviewSnapshot = data.overview;
  let positions: PositionSnapshot[] = data.positions;
  let research: ResearchCandidate[] = data.research;
  let paperDesk: PaperDeskSnapshot = data.paperDesk;
  let connectionState = 'paper telemetry connected';
  let compositeSignals: Array<{ symbol: string; direction: string; confidence: number; rsi2?: number; stochastic?: { k: number; d: number; crossover: string }; obiWeighted?: number; reasons?: string[] }> = [];
  let fearGreedData: { value: number; label: string; regime: string } | null = null;
  const sessionStartedAt = Date.now();
  let sessionElapsed = '0m';
  let feedMessageCount = 0;
  let lastFeedTimestamp = '';

  // Traffic lights + trade alerts
  let brokerLightState = new Map<string, { state: 'blue' | 'green' | 'yellow' | 'red'; flashUntil: number }>();
  let prevBrokerTradeCounts = new Map<string, { trades: number; pnl: number }>();
  let tradeAlerts: Array<{ id: number; type: 'profit' | 'loss' | 'breakeven'; message: string; pnl: number; expiresAt: number }> = [];
  let alertCounter = 0;

  let lastExecutionActionKey = '';

  function updateTrafficLights(desk: PaperDeskSnapshot) {
    const now = Date.now();
    const byBroker = new Map<string, { trades: number; pnl: number }>();
    for (const agent of desk.agents) {
      const prev = byBroker.get(agent.broker) ?? { trades: 0, pnl: 0 };
      byBroker.set(agent.broker, { trades: prev.trades + agent.totalTrades, pnl: prev.pnl + agent.realizedPnl });
    }

    for (const [broker, current] of byBroker) {
      const prev = prevBrokerTradeCounts.get(broker);
      if (prev && current.trades > prev.trades) {
        const pnlDelta = current.pnl - prev.pnl;
        const newTrades = current.trades - prev.trades;
        const state = pnlDelta > 0.001 ? 'green' : pnlDelta < -0.001 ? 'red' : 'yellow';
        brokerLightState.set(broker, { state, flashUntil: now + 5000 });

        // Fire alert
        const type = pnlDelta > 0.001 ? 'profit' : pnlDelta < -0.001 ? 'loss' : 'breakeven';
        const label = broker === 'alpaca-paper' ? 'Alpaca' : broker === 'oanda-rest' ? 'OANDA' : 'Coinbase';
        const verb = type === 'profit' ? 'took profit' : type === 'loss' ? 'took a loss' : 'broke even';
        tradeAlerts = [
          { id: ++alertCounter, type, message: `${label} ${verb} · ${newTrades} exit${newTrades > 1 ? 's' : ''} · ${new Date().toLocaleTimeString()}`, pnl: pnlDelta, expiresAt: now + 120_000 },
          ...tradeAlerts.filter((a) => now < a.expiresAt).slice(0, 12)
        ];
      }
      const light = brokerLightState.get(broker);
      if (light && now > light.flashUntil) {
        brokerLightState.set(broker, { state: 'blue', flashUntil: 0 });
      }
    }

    // Expire old alerts
    tradeAlerts = tradeAlerts.filter((a) => now < a.expiresAt);

    prevBrokerTradeCounts = byBroker;
    brokerLightState = brokerLightState;
  }

  // Derive traffic light state: flash on exits, otherwise show live agent activity
  // Traffic light states: green=in-trade, cyan=AI thinking, yellow=cooldown, white=scanning, blue=idle
  $: brokerLights = (() => {
    const result: Record<string, string> = {};
    const now = Date.now();
    for (const broker of ['alpaca-paper', 'coinbase-live', 'oanda-rest']) {
      const flash = brokerLightState.get(broker);
      if (flash && now < flash.flashUntil) {
        result[broker] = flash.state;
        continue;
      }
      const agents = paperDesk.agents.filter((a) => a.broker === broker);
      const inTrade = agents.some((a) => a.status === 'in-trade');
      const inCooldown = agents.some((a) => a.status === 'cooldown');
      // Check if AI council is evaluating for any agent on this broker
      const councilBusy = paperDesk.aiCouncil.some((d) =>
        (d.status === 'evaluating' || d.status === 'queued') && agents.some((a) => a.name === d.agentName)
      );
      // White flicker only when at least one agent has a strong signal (close to entering)
      const hotSignal = agents.some((a) => {
        if (a.status !== 'watching') return false;
        const scoreMatch = a.lastAction.match(/Score\s+([-\d.]+)/);
        return scoreMatch && Math.abs(parseFloat(scoreMatch[1])) > 2;
      });
      result[broker] = inTrade ? 'green' : councilBusy ? 'cyan' : inCooldown ? 'yellow' : hotSignal ? 'white' : 'blue';
    }
    return result;
  })();
  $: brokerFlashing = (() => {
    const result: Record<string, boolean> = {};
    const now = Date.now();
    for (const broker of ['alpaca-paper', 'coinbase-live', 'oanda-rest']) {
      const flash = brokerLightState.get(broker);
      const agents = paperDesk.agents.filter((a) => a.broker === broker);
      const inTrade = agents.some((a) => a.status === 'in-trade');
      const councilBusy = paperDesk.aiCouncil.some((d) =>
        (d.status === 'evaluating' || d.status === 'queued') && agents.some((a) => a.name === d.agentName)
      );
      result[broker] = (flash && now < flash.flashUntil) || inTrade || councilBusy;
    }
    return result;
  })();

  function formatElapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  const pickDefaultTapeSymbol = (desk: PaperDeskSnapshot): string => {
    const activeSymbols = [...new Set(desk.agents.filter((agent) => agent.status !== 'watching').map((agent) => agent.lastSymbol).filter(Boolean))];
    const nonBtcActive = activeSymbols.find((symbol) => symbol !== 'BTC-USD');
    if (nonBtcActive) return nonBtcActive;
    const nonBtcTape = desk.marketTape.find((tape) => tape.symbol !== 'BTC-USD' && tape.tradable !== false)?.symbol;
    return nonBtcTape ?? activeSymbols[0] ?? desk.marketTape[0]?.symbol ?? '';
  };

  function pickExecutionAction(
    desk: PaperDeskSnapshot,
    allowedSymbols: string[] = []
  ): { key: string; symbol: string } | null {
    const allowed = allowedSymbols.length > 0 ? new Set(allowedSymbols) : null;
    const symbolAllowed = (symbol: string) => !allowed || allowed.has(symbol);

    const latestFill = [...(desk.fills ?? [])]
      .filter((fill) => symbolAllowed(fill.symbol))
      .sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp))[0];
    if (latestFill) {
      return {
        key: `fill:${latestFill.id}:${latestFill.timestamp}`,
        symbol: latestFill.symbol
      };
    }

    const activeBand = (desk.executionBands ?? [])
      .filter((band) => symbolAllowed(band.symbol) && band.status === 'in-trade')
      .sort((left, right) => {
        const leftScore = left.status === 'in-trade' ? 1 : 0;
        const rightScore = right.status === 'in-trade' ? 1 : 0;
        return rightScore - leftScore;
      })[0];
    if (activeBand) {
      return {
        key: `band:${activeBand.symbol}:${activeBand.status}:${activeBand.lastAction}`,
        symbol: activeBand.symbol
      };
    }

    return null;
  }

  let selectedSymbol = pickDefaultTapeSymbol(data.paperDesk);

  $: traderRows = [...(paperDesk.agents ?? [])].sort(
    (left, right) => (right.winRate ?? 0) - (left.winRate ?? 0) || (right.totalTrades ?? 0) - (left.totalTrades ?? 0) || (right.realizedPnl ?? 0) - (left.realizedPnl ?? 0)
  );
  $: winningTraders = traderRows.filter((agent) => (agent.totalTrades ?? 0) > 0 && (agent.winRate ?? 0) >= 50).length;
  $: profitableTraders = [...(paperDesk.agents ?? [])]
    .filter((agent) => agent.dayPnl > 0 && (agent.totalTrades > 0 || agent.openPositions > 0))
    .sort((left, right) => right.dayPnl - left.dayPnl || right.realizedPnl - left.realizedPnl);
  $: profitLeaders = profitableTraders.slice(0, 3);
  $: profitableTraderPnl = profitableTraders.reduce((sum, agent) => sum + agent.dayPnl, 0);
  $: brokerAccounts = overview.brokerAccounts ?? [];
  $: alpacaAccount = brokerAccounts.find((a) => a.broker === 'alpaca-paper');
  $: oandaAccount = brokerAccounts.find((a) => a.broker === 'oanda-rest');
  $: brokerRouterHealth = overview.serviceHealth?.find((entry) => entry.name === 'broker-router')?.status;
  $: alpacaLiveAccount = createSyntheticLiveRouteAccount('alpaca-paper', brokerRouterHealth, overview.asOf);
  $: oandaLiveAccount = createSyntheticLiveRouteAccount('oanda-rest', brokerRouterHealth, overview.asOf);
  $: coinbaseRealAccount = brokerAccounts.find((a) => a.broker === 'coinbase-live');
  $: liveRouteAccounts = [alpacaLiveAccount, coinbaseRealAccount, oandaLiveAccount].filter(
    (account): account is NonNullable<typeof account> => Boolean(account)
  );
  $: coinbasePaperAgents = paperDesk.agents.filter((a) => a.broker === 'coinbase-live');
  // CB paper stats: broker rollup (journal-wide for coinbase-live) is authoritative —
  // it includes maker/grid/pairs trades which aren't in paperDesk.agents (those are
  // scalper-only). Fall back to agent sums if rollup missing.
  $: cbRollup = (paperDesk.brokerRollups ?? []).find((b) => b.broker === 'coinbase-live');
  $: cbPaperPnl = cbRollup?.realizedPnl ?? coinbasePaperAgents.reduce((s, a) => s + a.realizedPnl, 0);
  $: coinbasePaperEquity = BROKER_STARTING_EQUITY + cbPaperPnl;
  $: cbPaperTrades = cbRollup?.trades ?? coinbasePaperAgents.reduce((s, a) => s + a.totalTrades, 0);
  $: cbPaperWins = cbRollup?.wins ?? coinbasePaperAgents.reduce((s, a) => s + Math.round(a.totalTrades * a.winRate / 100), 0);
  $: cbPaperOpen = coinbasePaperAgents.filter((a) => a.status === 'in-trade').length;
  $: cbPaperWinRate = cbRollup ? cbRollup.winRate : (cbPaperTrades > 0 ? (cbPaperWins / cbPaperTrades) * 100 : 0);
  $: cbLight = brokerLights['coinbase-live'] ?? 'blue';
  $: cbFlashing = brokerFlashing['coinbase-live'] ?? false;
  // Legend active states — light up when any broker agent is in that state
  $: legendInTrade = paperDesk.agents.some((a) => a.status === 'in-trade');
  $: legendCouncil = paperDesk.aiCouncil.some((d) => d.status === 'evaluating' || d.status === 'queued');
  $: legendHot = paperDesk.agents.some((a) => { const m = a.lastAction.match(/Score\s+([-\d.]+)/); return m !== null && Math.abs(parseFloat(m[1]!)) > 2; });
  $: legendCooldown = paperDesk.agents.some((a) => a.status === 'cooldown');
  $: firmEquity = brokerAccounts.reduce((sum, account) => sum + account.equity, 0);
  $: coinbaseEquity = coinbaseRealAccount?.equity ?? 0;
  // Paper equity: prefer broker accounts, fallback to paperDesk.totalEquity (journal + broker calc)
  // COO FIX: When brokers disconnect, brokerAccounts is empty — use paperDesk.totalEquity instead.
  $: paperEquity = brokerAccounts.length > 0
    ? (alpacaAccount?.equity ?? 0) + (oandaAccount?.equity ?? 0) + coinbasePaperEquity
    : (paperDesk.totalEquity ?? 0);
  // Paper PnL metrics including all paper agents (Alpaca + OANDA + Coinbase paper).
  // Prefer broker-reported unrealized/realized when available (authoritative from the
  // broker API); fall back to the journal-derived paperDesk numbers otherwise.
  $: allPaperAgents = paperDesk.agents;
  $: paperBrokerUnrealized = brokerAccounts.reduce((sum, a) => sum + (typeof a.unrealizedPnl === 'number' ? a.unrealizedPnl : 0), 0);
  $: paperBrokerRealized = brokerAccounts.reduce((sum, a) => sum + (typeof a.realizedPnl === 'number' ? a.realizedPnl : 0), 0);
  $: paperRealizedPnl = paperBrokerRealized !== 0 ? paperBrokerRealized : paperDesk.realizedPnl;
  $: paperUnrealizedPnl = paperBrokerUnrealized !== 0
    ? paperBrokerUnrealized
    : (paperDesk.totalDayPnl - paperDesk.realizedPnl);
  $: paperTotalPnl = paperRealizedPnl + paperUnrealizedPnl;
  $: paperStartingEquity = BROKER_STARTING_EQUITY * 3; // 3 paper brokers
  // Firm-level totals from lane rollups (journal-wide, includes maker/grid/pairs/scalping
  // across all brokers). paperDesk.winRate is scalper-only and misleading.
  $: firmLanes = paperDesk.lanes ?? [];
  $: firmTotalTrades = firmLanes.reduce((s, l) => s + l.trades, 0);
  $: firmTotalWins = firmLanes.reduce((s, l) => s + l.wins, 0);
  $: firmTotalLosses = firmLanes.reduce((s, l) => s + l.losses, 0);
  $: firmWinRate = (firmTotalWins + firmTotalLosses) > 0
    ? (firmTotalWins / (firmTotalWins + firmTotalLosses)) * 100
    : 0;
  // Open risk: use broker-reported unrealized as the "at risk" floating number when the
  // internal analytics is zero (maker/grid/pairs positions aren't in engine.agents state).
  $: firmOpenRisk = paperBrokerUnrealized !== 0
    ? Math.abs(paperBrokerUnrealized)
    : (paperDesk.analytics?.totalOpenRisk ?? 0);
  $: firmOpenPositions = brokerAccounts.reduce((sum: number, a: BrokerAccountSnapshot) => sum + ((a as any).positions?.length ?? 0), 0);
  $: connectedBrokers = brokerAccounts.filter((account) => isBrokerConnected(account.status));

  // Per-broker trade stats from agents + real broker positions
  $: brokerTradeStats = new Map(brokerAccounts.map((account) => {
    const agents = paperDesk.agents.filter((a) => a.broker === account.broker);
    const trades = agents.reduce((s, a) => s + a.totalTrades, 0);
    const wins = agents.reduce((s, a) => s + Math.round(a.totalTrades * a.winRate / 100), 0);
    const pnl = agents.reduce((s, a) => s + a.realizedPnl, 0);
    // Count open positions from real broker data + agent status
    const agentOpen = agents.filter((a) => a.status === 'in-trade').length;
    const brokerOpen = positions.filter((p) => p.broker === account.broker && (p.quantity ?? 0) > 0.001).length;
    // For OANDA, check if equity != cash (means positions are open)
    const hasOpenValue = account.equity > 0 && Math.abs(account.equity - account.cash) > 1;
    const active = Math.max(agentOpen, brokerOpen, hasOpenValue ? 1 : 0);
    return [account.broker, { trades, wins, pnl, active }] as const;
  }));
  $: councilFallbackCount = paperDesk.aiCouncil.filter((decision) => getCouncilSourceSummary(decision).fallback).length;
  $: councilSourceCounts = getCouncilSourceCounts(paperDesk.aiCouncil);
  $: councilSourceRows = councilSources.map((source) => ({
    source,
    label: formatCouncilSource(source),
    count: councilSourceCounts[source]
  }));
  $: councilTransportSummary = councilSourceCounts.totalVotes === 0
    ? 'idle'
    : [
        councilSourceCounts.cli > 0 ? `${councilSourceCounts.cli} cli` : null,
        councilFallbackCount > 0 ? `${councilFallbackCount} fallback` : null,
      ].filter(Boolean).join(' · ');

  $: executionTapes = paperDesk.marketTape;
  $: if (executionTapes.length > 0 && !executionTapes.find((tape) => tape.symbol === selectedSymbol)) {
    selectedSymbol = executionTapes[0]?.symbol ?? '';
  }
  $: selectedTape =
    executionTapes.find((tape) => tape.symbol === selectedSymbol) ?? executionTapes[0];
  $: selectedBand =
    paperDesk.executionBands.find((band) => band.symbol === selectedTape?.symbol) ?? null;
  $: selectedTapeFlags =
    selectedTape?.qualityFlags?.length
      ? selectedTape.qualityFlags.join(', ')
      : selectedTape?.tradable
        ? 'tradable'
        : 'blocked';

  onMount(() => {
    startGlobalSSE();
    primeProfitAudio(paperDesk);
    const source = new EventSource('/api/feed');

    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as {
        overview?: OverviewSnapshot;
        positions?: PositionSnapshot[];
        paperDesk?: PaperDeskSnapshot;
        marketIntel?: {
          fearGreed?: { value: number; label: string; regime: string } | null;
          compositeSignals?: Array<{ symbol: string; direction: string; confidence: number; rsi2?: number; stochastic?: { k: number; d: number; crossover: string }; obiWeighted?: number; reasons?: string[] }>;
        };
      };

      feedMessageCount += 1;
      lastFeedTimestamp = new Date().toLocaleTimeString();

      // Frontend data integrity log — every 20th message, dump key values to console
      if (feedMessageCount % 20 === 1) {
        console.log(
          `[hermes-feed] msg#${feedMessageCount} at ${lastFeedTimestamp}`,
          '| nav:', payload.overview?.nav,
          '| equity:', payload.paperDesk?.totalEquity,
          '| dayPnl:', payload.paperDesk?.totalDayPnl,
          '| realized:', payload.paperDesk?.realizedPnl,
          '| winRate:', payload.paperDesk?.winRate,
          '| agents:', payload.paperDesk?.activeAgents,
          '| trades:', payload.paperDesk?.totalTrades,
          '| tapes:', payload.paperDesk?.marketTape?.length,
          '| fills:', payload.paperDesk?.fills?.length,
          '| council:', payload.paperDesk?.aiCouncil?.length,
          '| brokerHeat:', payload.overview?.brokerAccounts?.map((account: {broker: string; equity: number; status: string; mode: string}) => `${account.broker}=$${account.equity}[${account.mode}/${account.status}]`).join(', ')
        );
      }

      if (payload.overview) overview = payload.overview;
      if (payload.positions) positions = payload.positions;
      if (payload.paperDesk) {
        syncProfitAudio(payload.paperDesk);
        updateTrafficLights(payload.paperDesk);
        paperDesk = payload.paperDesk;
        const nextAction = pickExecutionAction(payload.paperDesk);
        const nextExecutionTapes = payload.paperDesk.marketTape;
        if (nextAction && nextAction.key !== lastExecutionActionKey) {
          lastExecutionActionKey = nextAction.key;
          selectedSymbol = nextAction.symbol;
        } else if (!nextExecutionTapes.find((tape) => tape.symbol === selectedSymbol)) {
          selectedSymbol = pickDefaultTapeSymbol(payload.paperDesk);
        }
      }
      if (payload.marketIntel) {
        if (payload.marketIntel.compositeSignals) compositeSignals = payload.marketIntel.compositeSignals;
        if (payload.marketIntel.fearGreed !== undefined) fearGreedData = payload.marketIntel.fearGreed;
      }
    };

    source.onerror = () => {
      connectionState = 'paper telemetry reconnecting';
    };

    source.onopen = () => {
      connectionState = 'paper telemetry connected';
    };

    const elapsedTimer = setInterval(() => {
      sessionElapsed = formatElapsed(Date.now() - sessionStartedAt);
    }, 1000);

    return () => {
      source.close();
      stopGlobalSSE();
      clearInterval(elapsedTimer);
    };
  });
</script>

<div class="activity-bar">
  <div class="activity-bar__status">
    <span class="activity-bar__dot" class:activity-bar__dot--live={connectionState === 'paper telemetry connected'}></span>
    <span class="activity-bar__label">{connectionState}</span>
    <span class="activity-bar__time">{sessionElapsed}</span>
  </div>
  <div class="activity-bar__feed">
    {#if tradeAlerts.length === 0}
      <span class="activity-bar__empty">Waiting for trade activity...</span>
    {/if}
    {#each tradeAlerts as alert (alert.id)}
      <div class={`activity-bar__alert activity-bar__alert--${alert.type}`}>
        <span class="activity-bar__icon">{#if alert.type === 'profit'}+{:else if alert.type === 'loss'}-{:else}={/if}</span>
        <span>{alert.message}</span>
        <strong>{signed(alert.pnl)}</strong>
      </div>
    {/each}
  </div>
</div>

<div class="hero-label">PAPER</div>
<section class="grid-hero">
  <MetricCard
    title="Paper Firm Equity"
    value={currency(paperEquity)}
    delta={`3 brokers · ${signed(paperEquity - paperStartingEquity)} from $${(paperStartingEquity / 1000).toFixed(0)}k`}
    points={paperDesk.deskCurve}
    tone={paperEquity >= paperStartingEquity ? 'positive' : 'negative'}
  />
  <MetricCard
    title="Realized PnL"
    value={signed(paperRealizedPnl)}
    delta={paperBrokerRealized !== 0 ? 'Broker-reported (all paper brokers)' : 'Journal-derived (all paper brokers)'}
    points={[]}
    tone={paperRealizedPnl >= 0 ? 'positive' : 'negative'}
  />
  <MetricCard
    title="Unrealized PnL"
    value={signed(paperUnrealizedPnl)}
    delta={paperBrokerUnrealized !== 0 ? 'Broker-reported floating on open positions' : 'Open positions (derived from equity)'}
    points={[]}
    tone={paperUnrealizedPnl >= 0 ? 'positive' : 'negative'}
  />
  <MetricCard
    title="Total PnL"
    value={signed(paperTotalPnl)}
    delta="Realized + Unrealized"
    points={paperDesk.benchmarkCurve}
    tone={paperTotalPnl >= 0 ? 'positive' : 'negative'}
  />
  <MetricCard
    title="Firm Win Rate"
    value={`${firmWinRate.toFixed(1)}%`}
    delta={`${firmTotalTrades} trades across ${firmLanes.filter((l) => l.trades > 0).length} lanes · ${firmTotalWins}W / ${firmTotalLosses}L`}
    points={firmLanes.filter((l) => l.trades > 0).map((l) => l.winRate)}
    tone={firmWinRate >= 52 ? 'positive' : 'warning'}
  />
  <MetricCard
    title="Open Risk"
    value={firmOpenRisk > 0 ? currency(firmOpenRisk) : '\u2014'}
    delta={firmOpenPositions > 0
      ? `${firmOpenPositions} broker${firmOpenPositions === 1 ? '' : 's'} with floating exposure`
      : `Avg hold ${(paperDesk.analytics?.avgHoldTicks ?? 0).toFixed(1)} ticks`}
    points={paperDesk.executionBands?.map((band) => band.currentPrice) ?? []}
    tone={firmOpenRisk !== 0 ? 'warning' : 'positive'}
  />
</section>
<div class="hero-label hero-label--live">LIVE</div>
<section class="grid-hero grid-hero--live">
  <MetricCard
    title="Live Firm Equity"
    value={coinbaseEquity > 0 ? currency(coinbaseEquity) : '\u2014'}
    delta="Coinbase wallet"
    points={[]}
    tone={coinbaseEquity > 0 ? 'positive' : 'warning'}
  />
  <MetricCard title="Realized PnL" value={'\u2014'} delta="No live trades yet" points={[]} tone="warning" />
  <MetricCard title="Unrealized PnL" value={'\u2014'} delta="No live positions" points={[]} tone="warning" />
  <MetricCard title="Total PnL" value={'\u2014'} delta="Activate after paper profits" points={[]} tone="warning" />
  <MetricCard title="Win Rate" value={'\u2014'} delta="No live exits" points={[]} tone="warning" />
  <MetricCard title="Open Risk" value={'\u2014'} delta="No live exposure" points={[]} tone="warning" />
</section>

<BrokerStripSection
  {brokerLights}
  {brokerFlashing}
  {legendInTrade}
  {legendCouncil}
  {legendHot}
  {legendCooldown}
  {alpacaAccount}
  {oandaAccount}
  {alpacaLiveAccount}
  {oandaLiveAccount}
  {coinbaseRealAccount}
  {coinbasePaperEquity}
  {coinbaseEquity}
  {cbPaperTrades}
  {cbPaperWinRate}
  {cbPaperPnl}
  {cbPaperOpen}
  {cbLight}
  {cbFlashing}
  {brokerTradeStats}
  {BROKER_STARTING_EQUITY}
/>

<Panel title="Venue Matrix" subtitle="Exact broker mode, account state, visible tape, and sleeve coverage per venue. VIXY is explicitly surfaced on the Alpaca row." aside="routing truth">
  <VenueMatrixSection
    brokerAccounts={brokerAccounts}
    {liveRouteAccounts}
    paperDesk={paperDesk}
    serviceHealth={overview.serviceHealth}
    mode="summary"
  />
</Panel>

<div class="command-center">
<div class="command-center__main">
<div class="deck-label">Execution and telemetry</div>

<Panel title="Market Signals" subtitle="RSI(2), Stochastic(14,3,3), weighted order book imbalance, and Fear/Greed. Updated every tick from MarketIntel." aside="live indicators">
  <MarketSignalsSection signals={compositeSignals.map((s) => {
    const tape = paperDesk.marketTape?.find((t) => t.symbol === s.symbol);
    return { ...s, tradable: tape?.tradable ?? true, tapeStatus: tape?.status ?? 'unknown' };
  })} fearGreed={fearGreedData} />
</Panel>

<Panel title="Live Terminals" subtitle="Real-time service telemetry via SSE." aside="live telemetry">
  <div class="light-legend light-legend--terminal">
    <span class="light-legend__item light-legend__item--active"><span class="traffic-light traffic-light--sky"></span> council</span>
    <span class="light-legend__item light-legend__item--active"><span class="traffic-light traffic-light--violet"></span> thesis</span>
    <span class="light-legend__item light-legend__item--active"><span class="traffic-light traffic-light--green"></span> approve</span>
    <span class="light-legend__item light-legend__item--active"><span class="traffic-light traffic-light--red"></span> reject</span>
    <span class="light-legend__item light-legend__item--active"><span class="traffic-light traffic-light--cyan"></span> signal</span>
    <span class="light-legend__item light-legend__item--active"><span class="traffic-light traffic-light--blue"></span> data</span>
    <span class="light-legend__item light-legend__item--active"><span class="traffic-light traffic-light--lime"></span> broker</span>
    <span class="light-legend__item light-legend__item--active"><span class="traffic-light traffic-light--amber"></span> metric</span>
    <span class="light-legend__item light-legend__item--active"><span class="traffic-light traffic-light--crimson"></span> error</span>
    <span class="light-legend__item light-legend__item--active"><span class="traffic-light traffic-light--orange"></span> learning</span>
  </div>
  <TerminalsSection />
</Panel>
<div class="deck-label">Decision engine</div>

<section class="dual-grid">
  <Panel title="AI Council Queue" subtitle="Claude, Codex, and Gemini review the setup in parallel. Consensus approvals move forward; hard vetoes stay sidelined.">
    {#if councilFallbackCount > 0}
      <div class="advisory-banner">
        <span>Fallback active</span>
        <span>{councilFallbackCount} of {paperDesk.aiCouncil.length} decisions fell back to API or rules instead of the configured CLI transports.</span>
      </div>
    {/if}
    <div class="council-source-mix">
      <div class="council-source-head">
        <span class="eyebrow">Council source mix</span>
        <span class="subtle">{councilSourceCounts.totalVotes} votes across {councilSourceCounts.totalDecisions} complete decisions</span>
      </div>
      <div class="council-source-breakdown">
        {#each councilSourceRows as row}
          <div class={`council-source-pill council-source-pill--${row.source}`}>
            <span>{row.label}</span>
            <strong>{row.count}</strong>
          </div>
        {/each}
      </div>
    </div>
    <div class="list-card">
      {#if paperDesk.aiCouncil.length === 0}
        <article class="list-item">
          <div class="panel-header">
            <div>
              <h4>Waiting for candidates</h4>
              <p>The council queue remains idle when market tape is stale, delayed, or during regular trading hour pauses.</p>
            </div>
          </div>
        </article>
      {:else}
        {#each paperDesk.aiCouncil as decision}
          {@const sourceSummary = getCouncilSourceSummary(decision)}
          <article class="list-item">
            <div class="panel-header">
              <div>
                <h4>{decision.symbol} · {decision.agentName}</h4>
                <p>{decision.reason}</p>
              </div>
              <StatusPill label={sourceSummary.label} status={sourceSummary.tone} />
            </div>
            <p class="subtle">
              Final {decision.finalAction} ·
              {#if decision.status === 'queued'}
                queued for CLI review
              {:else if decision.status === 'evaluating'}
                evaluating with CLI
              {:else if decision.status === 'error'}
                council error
              {:else if decision.panel?.length}
                {#each decision.panel as vote, index}
                  {formatCouncilVoteLabel(vote)} {vote.action} {vote.confidence}%{index < decision.panel.length - 1 ? ' · ' : ''}
                {/each}
              {:else}
                {formatCouncilVoteLabel(decision.primary)} {decision.primary.action} {decision.primary.confidence}% ·
                {#if decision.challenger}
                  {formatCouncilVoteLabel(decision.challenger)} {decision.challenger.action} {decision.challenger.confidence}%
                {:else}
                  no challenger vote yet
                {/if}
              {/if}
            </p>
          </article>
        {/each}
      {/if}
    </div>
  </Panel>

  <Panel title="Execution Tape" subtitle="Recent paper fills with price and realized impact, so the operator can verify every move.">
    <div class="ticker-list">
      {#if paperDesk.fills.length === 0}
        <article class="ticker-item">
          <h4>No recent paper fills</h4>
          <p>The execution tape will populate once the desk performs its first broker-backed exit or manual flatten event.</p>
        </article>
      {:else}
        {#each paperDesk.fills as fill}
          {@const council = paperDesk.aiCouncil.find(c => c.symbol === fill.symbol && c.agentName === fill.agentName && Math.abs(new Date(c.timestamp).getTime() - new Date(fill.timestamp).getTime()) < 5 * 60 * 1000)}
          {@const sourceSummary = council ? getCouncilSourceSummary(council) : { label: 'Simulated Entry', tone: 'neutral' }}
          <article class="ticker-item">
            <h4>{fill.agentName} · {fill.symbol} · {fill.side}</h4>
            <p><strong class={`status-${sourceSummary.tone || 'neutral'}`}>[{sourceSummary.label}]</strong> {fill.note}</p>
            <p class="subtle">
              {fill.status} at {currency(fill.price)} · impact
              <span class:status-positive={fill.pnlImpact >= 0} class:status-negative={fill.pnlImpact < 0}>
                {signed(fill.pnlImpact)}
              </span>
              · {new Date(fill.timestamp).toLocaleTimeString()}
            </p>
          </article>
        {/each}
      {/if}
    </div>
  </Panel>

  <Panel
    title="Lane Rollups"
    subtitle="30-day P&L and win rate by strategy lane, last 30 days. All 4 lanes shown even if zero trades."
    aside="lane truth"
  >
    {#if paperDesk.lanes && paperDesk.lanes.length > 0}
      <div class="lane-rollups">
        {#each paperDesk.lanes as lane}
          {@const tone = lane.trades === 0 ? 'neutral' : lane.realizedPnl >= 0 ? 'positive' : 'negative'}
          <div class="lane-card lane-card--{tone}">
            <span class="lane-card__name">{lane.lane}</span>
            <span class="lane-card__pnl" class:positive={lane.realizedPnl > 0} class:negative={lane.realizedPnl < 0}>
              {signed(lane.realizedPnl)}
            </span>
            <span class="lane-card__stat">{lane.trades} trade{lane.trades !== 1 ? 's' : ''}</span>
            <span class="lane-card__stat">{lane.winRate.toFixed(1)}% WR</span>
            <span class="lane-card__stat">{lane.wins}W / {lane.losses}L</span>
          </div>
        {/each}
      </div>
    {:else}
      <p class="subtle">No journal entries in the last 30 days.</p>
    {/if}
  </Panel>
</section>

<div class="deck-label">Insider Intel</div>
<Panel title="Insider Radar" subtitle="Real-time corporate insider filings (SEC Form 4) and congressional trading data. High-conviction clusters are flagged for the Strategy Director.">
  <InsiderRadarSection />
</Panel>

<div class="deck-label">Market execution</div>

<section class="operator-grid">
  <Panel
    title="Execution Matrix"
    subtitle="Candles are marked to the shared market-data service. Fills, stops, and targets come from the paper engine."
    aside="paper telemetry"
  >
    <div class="execution-matrix__head">
      <label class="execution-matrix__symbol-select">
        <span class="eyebrow">Chart symbol</span>
        <select bind:value={selectedSymbol}>
          {#each executionTapes as tape}
            <option value={tape.symbol}>
              {tape.symbol} · {(tape.lastPrice ?? 0).toFixed(2)} · {(tape.changePct ?? 0) >= 0 ? '+' : ''}{(tape.changePct ?? 0).toFixed(2)}%
            </option>
          {/each}
        </select>
      </label>
    </div>

    {#if selectedTape}
      <TapeChart tape={selectedTape} band={selectedBand} />

      <div class="technical-readout">
        <div class="readout-card">
          <span class="eyebrow">Spread</span>
          <strong>{(selectedTape?.spreadBps ?? 0).toFixed(2)} bps</strong>
          <small>Liquidity {selectedTape.liquidityScore} · {selectedTape.session ?? 'unknown'} session</small>
        </div>
        <div class="readout-card">
          <span class="eyebrow">Band</span>
          <strong>{selectedBand?.entryPrice ? currency(selectedBand.entryPrice) : 'flat'}</strong>
          <small>
            {#if selectedBand?.entryPrice}
              stop {currency(selectedBand.stopPrice ?? 0)} · target {currency(selectedBand.targetPrice ?? 0)}
            {:else}
              waiting for entry approval
            {/if}
          </small>
        </div>
        <div class="readout-card">
          <span class="eyebrow">Tape Gate</span>
          <strong>{selectedTape.tradable ? 'tradable' : 'blocked'}</strong>
          <small>{selectedTapeFlags}</small>
        </div>
        <div class="readout-card">
          <span class="eyebrow">Source</span>
          <strong>{selectedTape.source ?? 'unknown'}</strong>
          <small>{selectedTape.updatedAt ? `updated ${new Date(selectedTape.updatedAt).toLocaleTimeString()}` : 'no freshness timestamp'}</small>
        </div>
        <div class="readout-card">
          <span class="eyebrow">Action</span>
          <strong>{selectedBand?.status ?? 'watching'}</strong>
          <small>{selectedBand?.lastAction ?? 'No current action.'}</small>
        </div>
      </div>
    {/if}
  </Panel>

  <Panel
    title="Verification Layer"
    subtitle="This shows exactly which parts of the firm are running on live broker-fed inputs and which sleeves are still paper or practice routed."
    aside="provenance"
  >
    <div class="source-list">
      {#each paperDesk.sources as source}
        <article class={`source-card source-card--${source.mode}`}>
          <div class="source-card__head">
            <span class="eyebrow">{source.mode}</span>
            <strong>{source.label}</strong>
          </div>
          <p>{source.detail}</p>
        </article>
      {/each}
    </div>

    <div class="verification-note">
      <strong>Verification note</strong>
      <p>{paperDesk.analytics.verificationNote}</p>
    </div>
  </Panel>
</section>
<div class="deck-label">Execution analytics</div>

<ExecutionAnalyticsSection {paperDesk} />
<div class="deck-label">Trader scoreboard</div>

<TraderScoreboardSection {traderRows} {research} {positions} />
</div>
<div class="command-center__rail">
<div class="deck-label">Reference and outlook</div>

<div class="rail-wide">
  <Panel title="Quarter Outlook" subtitle="Simulation-backed last-quarter results and next-quarter scenario bands by asset class. Treat these as estimates, not promises." aside="simulated">
    <QuarterOutlookSection mode="summary" />
  </Panel>
</div>

<div class="rail-wide">
  <Panel title="Pilot Progress" subtitle="What is actually active right now: broker-backed lanes, watch-only lanes, live tape, and current AI council load." aside="reality check">
    <PilotProgressSection paperDesk={paperDesk} mode="summary" />
  </Panel>
</div>

<div class="deck-label">Learning and governance</div>
<div class="rail-wide rail-grid-2">
  <Panel title="Learning History" subtitle="Persisted review-loop logs with 7d and 30d trend windows. This is the real adaptation trail, not a marketing summary." aside="history">
    <LearningHistorySection mode="summary" initialLearning={data.learning} initialLaneLearning={data.laneLearning} />
  </Panel>

  <Panel title="Council Traces" subtitle="Raw CLI prompts and raw outputs from the latest council calls. If a model errors, that is shown too." aside="transcripts">
    <AiCouncilTraceSection mode="summary" initialTraces={data.aiCouncilTraces} />
  </Panel>
</div>

<div class="deck-label">Portfolio and sleeves</div>

<div class="rail-wide">
  <Panel
    title="Capital Allocation"
    subtitle="Firm-level policy: live weight only goes to sleeves that clear the gate; everything else stays staged or in cash."
    aside="portfolio policy"
  >
    <CapitalAllocatorSection mode="summary" />
  </Panel>
</div>

<div class="rail-wide rail-grid-2">
  <Panel
    title="Copy Sleeve"
    subtitle="Delayed public-manager replication from SEC 13F filings. If the filing feed or backtest inputs are unavailable, the panel says so instead of inventing numbers."
    aside="SEC 13F"
  >
    <CopySleeveSection mode="summary" />
  </Panel>

  <Panel
    title="Macro Preservation"
    subtitle="Cash-first inflation hedge sleeve. It only leaves cash when CPI and the tape justify oil or precious metals exposure."
    aside="CPI + real assets"
  >
    <MacroPreservationSection mode="summary" />
  </Panel>
</div>
</div>

<Panel title="Diagnostics" subtitle="Compact footer. Only active warnings and disconnects are listed." aside="ops footer">
  <DashboardDiagnosticsSection
    {connectionState}
    {feedMessageCount}
    {lastFeedTimestamp}
    serviceHealth={overview.serviceHealth}
    resourceStatus={$dashboardResourceStatus}
  />
</Panel>
</div>
