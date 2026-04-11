<script lang="ts">
  import { onMount } from 'svelte';
  import type {
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
  import MarketSignalsSection from '$lib/components/MarketSignalsSection.svelte';
  import TapeChart from '$lib/components/TapeChart.svelte';
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
          { id: ++alertCounter, type, message: `${label} traders ${verb} · ${newTrades} exit${newTrades > 1 ? 's' : ''}`, pnl: pnlDelta, expiresAt: now + 8000 },
          ...tradeAlerts.filter((a) => now < a.expiresAt).slice(0, 4)
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

  // Reactive derived values for template use
  $: brokerLights = Object.fromEntries(
    Array.from(brokerLightState.entries()).map(([k, v]) => [k, v.state])
  ) as Record<string, string>;
  $: brokerFlashing = Object.fromEntries(
    Array.from(brokerLightState.entries()).map(([k, v]) => [k, Date.now() < v.flashUntil])
  ) as Record<string, boolean>;

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

  let selectedSymbol = pickDefaultTapeSymbol(data.paperDesk);

  $: selectedTape =
    paperDesk.marketTape.find((tape) => tape.symbol === selectedSymbol) ?? paperDesk.marketTape[0];
  $: selectedBand =
    paperDesk.executionBands.find((band) => band.symbol === selectedTape?.symbol) ?? null;
  $: selectedTapeFlags =
    selectedTape?.qualityFlags?.length
      ? selectedTape.qualityFlags.join(', ')
      : selectedTape?.tradable
        ? 'tradable'
        : 'blocked';
  $: traderRows = [...paperDesk.agents].sort(
    (left, right) => right.winRate - left.winRate || right.totalTrades - left.totalTrades || right.realizedPnl - left.realizedPnl
  );
  $: winningTraders = traderRows.filter((agent) => agent.totalTrades > 0 && agent.winRate >= 50).length;
  $: profitableTraders = [...paperDesk.agents]
    .filter((agent) => agent.dayPnl > 0 && (agent.totalTrades > 0 || agent.openPositions > 0))
    .sort((left, right) => right.dayPnl - left.dayPnl || right.realizedPnl - left.realizedPnl);
  $: profitLeaders = profitableTraders.slice(0, 3);
  $: profitableTraderPnl = profitableTraders.reduce((sum, agent) => sum + agent.dayPnl, 0);
  $: brokerAccounts = overview.brokerAccounts ?? [];
  $: alpacaAccount = brokerAccounts.find((a) => a.broker === 'alpaca-paper');
  $: oandaAccount = brokerAccounts.find((a) => a.broker === 'oanda-rest');
  $: coinbaseRealAccount = brokerAccounts.find((a) => a.broker === 'coinbase-live');
  $: coinbasePaperAgents = paperDesk.agents.filter((a) => a.broker === 'coinbase-live');
  $: coinbasePaperPnl_total = coinbasePaperAgents.reduce((s, a) => s + a.realizedPnl, 0);
  $: coinbasePaperEquity = BROKER_STARTING_EQUITY + coinbasePaperPnl_total;
  $: cbPaperTrades = coinbasePaperAgents.reduce((s, a) => s + a.totalTrades, 0);
  $: cbPaperWins = coinbasePaperAgents.reduce((s, a) => s + Math.round(a.totalTrades * a.winRate / 100), 0);
  $: cbPaperPnl = coinbasePaperAgents.reduce((s, a) => s + a.realizedPnl, 0);
  $: cbPaperOpen = coinbasePaperAgents.filter((a) => a.status === 'in-trade').length;
  $: cbPaperWinRate = cbPaperTrades > 0 ? (cbPaperWins / cbPaperTrades) * 100 : 0;
  $: cbLight = brokerLights['coinbase-live'] ?? 'blue';
  $: cbFlashing = brokerFlashing['coinbase-live'] ?? false;
  $: firmEquity = brokerAccounts.reduce((sum, account) => sum + account.equity, 0);
  $: coinbaseEquity = coinbaseRealAccount?.equity ?? 0;
  // Paper equity = Alpaca + OANDA real accounts + Coinbase simulated paper ($100k + PnL)
  $: paperEquity = (alpacaAccount?.equity ?? 0) + (oandaAccount?.equity ?? 0) + coinbasePaperEquity;
  // Paper PnL metrics including all paper agents (Alpaca + OANDA + Coinbase paper)
  $: allPaperAgents = paperDesk.agents;
  $: paperRealizedPnl = paperDesk.realizedPnl;
  $: paperUnrealizedPnl = paperDesk.totalDayPnl - paperDesk.realizedPnl;
  $: paperTotalPnl = paperDesk.totalDayPnl;
  $: paperStartingEquity = BROKER_STARTING_EQUITY * 3; // 3 paper brokers
  $: connectedBrokers = brokerAccounts.filter((account) => account.status === 'connected');

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
  $: statusStripItems = [
    { label: 'Feed', value: connectionState, tone: connectionState.includes('reconnecting') ? 'warning' : 'positive' },
    { label: 'Session', value: sessionElapsed, tone: 'positive' },
    { label: 'Paper NAV', value: currency(paperEquity), tone: paperEquity >= paperStartingEquity ? 'positive' : 'negative' },
    { label: 'Live', value: currency(coinbaseEquity), tone: coinbaseEquity > 0 ? 'positive' : 'warning' },
    { label: 'Brokers', value: `${connectedBrokers.length} connected`, tone: connectedBrokers.length > 0 ? 'positive' : 'negative' },
    { label: 'Session PnL', value: signed(paperDesk.totalDayPnl), tone: paperDesk.totalDayPnl >= 0 ? 'positive' : 'negative' },
    { label: 'Realized PnL', value: signed(paperDesk.realizedPnl), tone: paperDesk.realizedPnl >= 0 ? 'positive' : 'negative' },
    { label: 'Win Rate', value: `${paperDesk.winRate.toFixed(1)}%`, tone: paperDesk.winRate >= 52 ? 'positive' : paperDesk.winRate >= 40 ? 'warning' : 'negative' },
    { label: 'Open Risk', value: signed(paperDesk.analytics.totalOpenRisk), tone: paperDesk.analytics.totalOpenRisk !== 0 ? 'warning' : 'neutral' },
    { label: 'Council', value: councilTransportSummary, tone: councilFallbackCount > 0 ? 'warning' : 'positive' },
    { label: 'Agents', value: `${paperDesk.activeAgents} active`, tone: 'positive' },
    { label: 'Trades', value: `${paperDesk.totalTrades}`, tone: 'positive' },
    { label: 'Feed msgs', value: `${feedMessageCount}`, tone: 'positive' }
  ] as const;

  onMount(() => {
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
        if (!paperDesk.marketTape.find((tape) => tape.symbol === selectedSymbol)) {
          selectedSymbol = pickDefaultTapeSymbol(paperDesk);
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
      clearInterval(elapsedTimer);
    };
  });
</script>

{#each tradeAlerts as alert (alert.id)}
  <div class={`trade-alert trade-alert--${alert.type}`}>
    <span class="trade-alert__icon">
      {#if alert.type === 'profit'}&#9650;{:else if alert.type === 'loss'}&#9660;{:else}&#9644;{/if}
    </span>
    <span class="trade-alert__message">{alert.message}</span>
    <strong class="trade-alert__pnl">{signed(alert.pnl)}</strong>
  </div>
{/each}

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
    delta="Closed trades net (all paper brokers)"
    points={[]}
    tone={paperRealizedPnl >= 0 ? 'positive' : 'negative'}
  />
  <MetricCard
    title="Unrealized PnL"
    value={signed(paperUnrealizedPnl)}
    delta="Open positions"
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
    value={`${paperDesk.winRate.toFixed(1)}%`}
    delta={`Broker exits ${paperDesk.totalTrades} · winning traders ${winningTraders}`}
    points={paperDesk.agents.map((agent) => agent.winRate)}
    tone={paperDesk.winRate >= 52 ? 'positive' : 'warning'}
  />
  <MetricCard
    title="Open Risk"
    value={currency(paperDesk.analytics.totalOpenRisk)}
    delta={`Avg hold ${paperDesk.analytics.avgHoldTicks.toFixed(1)} ticks`}
    points={paperDesk.executionBands.map((band) => band.currentPrice)}
    tone={paperDesk.analytics.totalOpenRisk !== 0 ? 'warning' : 'positive'}
  />
</section>
<div class="hero-label hero-label--live">LIVE</div>
<section class="grid-hero grid-hero--live">
  <MetricCard
    title="Live Firm Equity"
    value={currency(coinbaseEquity)}
    delta="Coinbase wallet (trading inactive)"
    points={[]}
    tone={coinbaseEquity > 0 ? 'positive' : 'warning'}
  />
</section>

<div class="broker-section">
  <div class="broker-row-label">PAPER</div>
  <div class="broker-strip">
    {#each [alpacaAccount, null, oandaAccount] as account, i}
      {#if i === 1}
        <!-- Coinbase Paper (middle) — simulated locally using live Coinbase prices -->
        <div class="broker-chip broker-chip--live">
          <div class="broker-chip__head">
            <span class="eyebrow">coinbase-paper</span>
            <div class="broker-chip__lights">
              <span class={`traffic-light traffic-light--${cbLight}`} class:traffic-light--flash={cbFlashing}></span>
              <span class="broker-chip__mode">paper</span>
            </div>
          </div>
          <div class="broker-chip__equity">
            <strong class:status-positive={coinbasePaperEquity >= BROKER_STARTING_EQUITY} class:status-negative={coinbasePaperEquity < BROKER_STARTING_EQUITY}>{currency(coinbasePaperEquity)}</strong>
            <small class:status-positive={coinbasePaperEquity >= BROKER_STARTING_EQUITY} class:status-negative={coinbasePaperEquity < BROKER_STARTING_EQUITY}>{signed(coinbasePaperEquity - BROKER_STARTING_EQUITY)} since start</small>
          </div>
          <div class="broker-chip__trades">
            <span>{cbPaperTrades} trades</span>
            <span class:status-positive={cbPaperWinRate >= 50} class:status-negative={cbPaperWinRate < 50 && cbPaperTrades > 0}>{cbPaperWinRate.toFixed(0)}% win</span>
            <span class:status-positive={cbPaperPnl > 0} class:status-negative={cbPaperPnl < 0}>{signed(cbPaperPnl)}</span>
            <span class={cbPaperOpen > 0 ? 'broker-chip__active' : 'broker-chip__idle'}>{cbPaperOpen} open</span>
          </div>
        </div>
      {:else if account}
        {@const stats = brokerTradeStats.get(account.broker) ?? { trades: 0, wins: 0, pnl: 0, active: 0 }}
        {@const winRate = stats.trades > 0 ? (stats.wins / stats.trades) * 100 : 0}
        {@const light = brokerLights[account.broker] ?? 'blue'}
        {@const flashing = brokerFlashing[account.broker] ?? false}
        <div class={`broker-chip broker-chip--${account.status === 'connected' ? 'live' : 'off'}`}>
          <div class="broker-chip__head">
            <span class="eyebrow">{account.broker}</span>
            <div class="broker-chip__lights">
              <span class={`traffic-light traffic-light--${light}`} class:traffic-light--flash={flashing}></span>
              <span class="broker-chip__mode">{account.mode}</span>
            </div>
          </div>
          <div class="broker-chip__equity">
            <strong class:status-positive={account.equity >= BROKER_STARTING_EQUITY} class:status-negative={account.equity < BROKER_STARTING_EQUITY}>{currency(account.equity)}</strong>
            <small class:status-positive={account.equity >= BROKER_STARTING_EQUITY} class:status-negative={account.equity < BROKER_STARTING_EQUITY}>{signed(account.equity - BROKER_STARTING_EQUITY)} since start</small>
          </div>
          <div class="broker-chip__trades">
            <span>{stats.trades} trades</span>
            <span class:status-positive={winRate >= 50} class:status-negative={winRate < 50 && stats.trades > 0}>{winRate.toFixed(0)}% win</span>
            <span class:status-positive={stats.pnl > 0} class:status-negative={stats.pnl < 0}>{signed(stats.pnl)}</span>
            <span class={stats.active > 0 ? 'broker-chip__active' : 'broker-chip__idle'}>{stats.active} open</span>
          </div>
          <div class="broker-chip__meta">
            <span>Cash {currency(account.cash)}</span>
            <span>BP {currency(account.buyingPower)}</span>
            <span class={`broker-chip__status broker-chip__status--${account.status}`}>{account.status}</span>
            <span>{new Date(account.updatedAt).toLocaleTimeString()}</span>
          </div>
        </div>
      {/if}
    {/each}
  </div>
  <div class="broker-row-label broker-row-label--live">LIVE</div>
  <div class="broker-strip">
    <div class="broker-chip broker-chip--off broker-chip--inactive">
      <div class="broker-chip__head">
        <span class="eyebrow">alpaca-live</span>
        <div class="broker-chip__lights">
          <span class="traffic-light traffic-light--yellow"></span>
          <span class="broker-chip__mode">not connected</span>
        </div>
      </div>
      <div class="broker-chip__equity">
        <strong class="subtle">&mdash;</strong>
        <small class="subtle">Enable after paper profits</small>
      </div>
    </div>
    <div class={`broker-chip broker-chip--${coinbaseRealAccount?.status === 'connected' ? 'live' : 'off'}`}>
      <div class="broker-chip__head">
        <span class="eyebrow">coinbase-live</span>
        <div class="broker-chip__lights">
          <span class={`traffic-light traffic-light--${coinbaseRealAccount ? 'green' : 'yellow'}`}></span>
          <span class="broker-chip__mode">{coinbaseRealAccount?.mode ?? 'wallet'}</span>
        </div>
      </div>
      <div class="broker-chip__equity">
        <strong>{coinbaseEquity > 0 ? currency(coinbaseEquity) : '\u2014'}</strong>
        <small>{coinbaseRealAccount?.status ?? 'disconnected'}</small>
      </div>
    </div>
    <div class="broker-chip broker-chip--off broker-chip--inactive">
      <div class="broker-chip__head">
        <span class="eyebrow">oanda-live</span>
        <div class="broker-chip__lights">
          <span class="traffic-light traffic-light--yellow"></span>
          <span class="broker-chip__mode">not connected</span>
        </div>
      </div>
      <div class="broker-chip__equity">
        <strong class="subtle">&mdash;</strong>
        <small class="subtle">Enable after paper profits</small>
      </div>
    </div>
  </div>
</div>

<Panel title="Venue Matrix" subtitle="Exact broker mode, account state, visible tape, and sleeve coverage per venue. VIXY is explicitly surfaced on the Alpaca row." aside="routing truth">
  <VenueMatrixSection brokerAccounts={brokerAccounts} paperDesk={paperDesk} serviceHealth={overview.serviceHealth} mode="summary" />
</Panel>

<div class="command-strip">
  {#each statusStripItems as item}
    <div class={`command-chip command-chip--${item.tone}`}>
      <span>{item.label}</span>
      <strong>{item.value}</strong>
    </div>
  {/each}
</div>

<div class="command-center">
<div class="command-center__main">
<div class="deck-label">Execution and telemetry</div>

<Panel title="Market Signals" subtitle="RSI(2), Stochastic(14,3,3), weighted order book imbalance, and Fear/Greed. Updated every tick from MarketIntel." aside="live indicators">
  <MarketSignalsSection signals={compositeSignals} fearGreed={fearGreedData} />
</Panel>

<Panel title="Live Terminals" subtitle="Service panes plus AI council vote panes backed by live snapshots. You can watch the firm working without opening separate shells." aside="live telemetry">
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
    </div>
  </Panel>

  <Panel title="Execution Tape" subtitle="Recent paper fills with price and realized impact, so the operator can verify every move.">
    <div class="ticker-list">
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
    </div>
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
    <div class="symbol-strip">
      {#each paperDesk.marketTape as tape}
        <button
          type="button"
          class:selected={selectedSymbol === tape.symbol}
          class="symbol-chip"
          on:click={() => (selectedSymbol = tape.symbol)}
        >
          <span>{tape.symbol}</span>
          <strong>{tape.lastPrice.toFixed(2)}</strong>
          <small class:status-positive={tape.changePct >= 0} class:status-negative={tape.changePct < 0}>{tape.changePct >= 0 ? '+' : ''}{tape.changePct.toFixed(2)}%</small>
        </button>
      {/each}
    </div>

    {#if selectedTape}
      <TapeChart tape={selectedTape} band={selectedBand} />

      <div class="technical-readout">
        <div class="readout-card">
          <span class="eyebrow">Spread</span>
          <strong>{selectedTape.spreadBps.toFixed(2)} bps</strong>
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

<section class="dual-grid">
  <Panel
    title="Adaptive Tuning Matrix"
    subtitle="Scalping parameters move inside hard bounds based on recent paper exits. This is adaptive tuning, not broker-verified self-learning."
  >
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Style</th>
            <th>PF</th>
            <th>Win</th>
            <th>Target</th>
            <th>Stop</th>
            <th>Hold</th>
            <th>Mistake</th>
            <th>Trend</th>
            <th>Allocator</th>
            <th>Bias</th>
          </tr>
        </thead>
        <tbody>
          {#each paperDesk.tuning as row}
            <tr>
              <td>
                <strong>{row.agentName}</strong>
                <div class="subtle">{row.symbol}</div>
              </td>
              <td>{row.style}</td>
              <td class:status-positive={row.profitFactor >= 1.0} class:status-negative={row.profitFactor < 1.0}>{row.profitFactor.toFixed(2)}</td>
              <td class:status-positive={row.winRate >= 52} class:status-warning={row.winRate >= 40 && row.winRate < 52} class:status-negative={row.winRate < 40}>{row.winRate.toFixed(1)}%</td>
              <td>{row.targetBps.toFixed(2)} bps</td>
              <td>{row.stopBps.toFixed(2)} bps</td>
              <td>{row.maxHoldTicks}</td>
              <td>{row.mistakeScore !== undefined ? row.mistakeScore.toFixed(1) : 'n/a'}</td>
              <td>
                <span class:status-positive={row.mistakeTrend === 'improving'} class:status-negative={row.mistakeTrend === 'worsening'}>
                  {row.mistakeTrend ?? 'stable'}
                </span>
              </td>
              <td>
                <strong>{row.allocationMultiplier !== undefined ? `${row.allocationMultiplier.toFixed(2)}x` : 'n/a'}</strong>
              </td>
              <td>
                <span class={`bias-chip bias-chip--${row.improvementBias}`}>{row.improvementBias}</span>
              </td>
            </tr>
            <tr class="table-detail-row">
              <td colspan="11">
                <div>{row.lastAdjustment}</div>
                {#if row.mistakeSummary}
                  <div class="subtle">Mistake loop: {row.mistakeSummary}</div>
                {/if}
                {#if row.allocationReason}
                  <div class="subtle">Allocator: {row.allocationReason}</div>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Panel>

  <Panel title="Open Risk Bands" subtitle="What each agent is carrying right now, with the active price range and current PnL.">
    <div class="band-list">
      {#each paperDesk.executionBands as band}
        <article class="band-card">
          <div class="band-card__head">
            <div>
              <h4>{band.agentName}</h4>
              <p class="subtle">{band.symbol} · {band.status}</p>
            </div>
            <div class:status-positive={band.unrealizedPnl >= 0} class:status-negative={band.unrealizedPnl < 0}>
              {signed(band.unrealizedPnl)}
            </div>
          </div>
          <div class="band-card__levels">
            <span>Entry {band.entryPrice ? currency(band.entryPrice) : 'flat'}</span>
            <span>Mark {currency(band.currentPrice)}</span>
            <span>Stop {band.stopPrice ? currency(band.stopPrice) : 'n/a'}</span>
            <span>Target {band.targetPrice ? currency(band.targetPrice) : 'n/a'}</span>
          </div>
          <p>{band.lastAction}</p>
        </article>
      {/each}
    </div>
  </Panel>
</section>
<div class="deck-label">Trader scoreboard</div>

<section class="dual-grid">
  <Panel title="Trader Win Rates" subtitle="Per-trader win rates and realized PnL from the current paper ledger. Firm NAV above sums all connected broker accounts.">
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Trader</th>
            <th>Status</th>
            <th>Win Rate</th>
            <th>Trades</th>
            <th>Realized</th>
            <th>Last Action</th>
          </tr>
        </thead>
        <tbody>
          {#each traderRows as trader}
            <tr>
              <td>
                <strong>{trader.name}</strong>
                <div class="subtle">{trader.lastSymbol}</div>
              </td>
              <td class={trader.status === 'in-trade' ? 'status-positive' : trader.status === 'cooldown' ? 'status-warning' : ''}>{trader.status}</td>
              <td class:status-positive={trader.winRate >= 52} class:status-warning={trader.winRate >= 40 && trader.winRate < 52} class:status-negative={trader.winRate < 40}>{trader.winRate.toFixed(1)}%</td>
              <td>{trader.totalTrades}</td>
              <td class:status-positive={trader.realizedPnl >= 0} class:status-negative={trader.realizedPnl < 0}>
                {signed(trader.realizedPnl)}
              </td>
              <td>{trader.lastAction}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Panel>

  <Panel title="Opportunity Queue" subtitle="Only live broker-fed market snapshots are shown here. If a feed degrades into fallback or mock data, it drops out of this queue.">
    <div class="list-card compact-list">
      {#if research.length === 0}
        <article class="list-item">
          <h4>No live broker-fed candidates right now</h4>
          <p>The queue stays empty when the firm does not have clean live tape to evaluate.</p>
        </article>
      {:else}
        {#each research as candidate}
          <article class="list-item">
            <h4>{candidate.symbol} · {candidate.strategy}</h4>
            <p>{candidate.catalyst}</p>
            <p class="subtle">Score {candidate.score} · Edge {candidate.expectedEdgeBps} bps · {candidate.aiVerdict}</p>
          </article>
        {/each}
      {/if}
    </div>

    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Broker</th>
            <th>Source</th>
            <th>Strategy</th>
            <th>Entry</th>
            <th>Mark</th>
            <th>Unrealized</th>
          </tr>
        </thead>
        <tbody>
          {#each positions as position}
            <tr>
              <td>{position.symbol}</td>
              <td>{position.broker}</td>
              <td>{position.source ?? 'unknown'}</td>
              <td>{position.strategy}</td>
              <td>{currency(position.avgEntry)}</td>
              <td>{currency(position.markPrice)}</td>
              <td class:status-positive={position.unrealizedPnl >= 0} class:status-negative={position.unrealizedPnl < 0}>
                {signed(position.unrealizedPnl)}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Panel>
</section>
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
</div>
