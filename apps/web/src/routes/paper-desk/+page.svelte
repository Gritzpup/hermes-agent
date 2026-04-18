<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageData } from './$types';
  import type { LaneRollup, OverviewSnapshot, PaperDeskSnapshot } from '@hermes/contracts';
  import AgentCard from '$lib/components/AgentCard.svelte';
  import ArenaChart from '$lib/components/ArenaChart.svelte';
  import Panel from '$lib/components/Panel.svelte';
  import StatusPill from '$lib/components/StatusPill.svelte';
  import PilotProgressSection from '$lib/components/PilotProgressSection.svelte';
  import LearningHistorySection from '$lib/components/LearningHistorySection.svelte';
  import AiCouncilTraceSection from '$lib/components/AiCouncilTraceSection.svelte';
  import SelfLearningScorecard from '$lib/components/SelfLearningScorecard.svelte';
  import VenueMatrixSection from '$lib/components/VenueMatrixSection.svelte';
  import TapeChart from '$lib/components/TapeChart.svelte';
  import { createSyntheticLiveRouteAccount } from '$lib/broker-status';
  import { currency, percent, signed } from '$lib/format';
  import {
    councilSources,
    formatCouncilSource,
    formatCouncilVoteLabel,
    getCouncilSourceCounts,
    getCouncilSourceSummary
  } from '$lib/council';
  import { primeProfitAudio, syncProfitAudio } from '$lib/services/profit-audio';

  export let data: PageData;

  let paperDesk: PaperDeskSnapshot = data.paperDesk;
  let overview: OverviewSnapshot = data.overview;
  let connectionState = 'paper feed connected';

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
  $: councilFallbackCount = paperDesk.aiCouncil.filter((decision) => getCouncilSourceSummary(decision).fallback).length;
  $: councilSourceCounts = getCouncilSourceCounts(paperDesk.aiCouncil);
  $: councilSourceRows = councilSources.map((source) => ({
    source,
    label: formatCouncilSource(source),
    count: councilSourceCounts[source]
  }));
  $: brokerRouterHealth = overview.serviceHealth?.find((entry) => entry.name === 'broker-router')?.status;
  $: liveRouteAccounts = [
    createSyntheticLiveRouteAccount('alpaca-paper', brokerRouterHealth, overview.asOf),
    overview.brokerAccounts.find((entry) => entry.broker === 'coinbase-live'),
    createSyntheticLiveRouteAccount('oanda-rest', brokerRouterHealth, overview.asOf)
  ].filter((account): account is NonNullable<typeof account> => Boolean(account));

  onMount(() => {
    primeProfitAudio(paperDesk);
    const source = new EventSource('/api/feed');

    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { overview?: OverviewSnapshot; paperDesk?: PaperDeskSnapshot };
      if (payload.overview) overview = payload.overview;
      if (payload.paperDesk) {
        syncProfitAudio(payload.paperDesk);
        paperDesk = payload.paperDesk;
        if (!paperDesk.marketTape.find((tape) => tape.symbol === selectedSymbol)) {
          selectedSymbol = pickDefaultTapeSymbol(paperDesk);
        }
      }
    };

    source.onerror = () => {
      connectionState = 'feed reconnecting';
    };

    source.onopen = () => {
      connectionState = 'paper feed connected';
    };

    return () => source.close();
  });
</script>

<div class="panel hero-surface">
  <div class="hero-surface__copy">
    <div class="eyebrow">Paper Desk</div>
    <h2>Adaptive paper desk with visible tape and visible tuning.</h2>
    <p>
      This page is the deep-dive lane for the paper engine. You can watch the desk curve,
      inspect a symbol’s candle tape, and see which parameter shifts the engine is making
      as recent broker-backed paper exits improve or degrade against the current market-data feed across venues.
    </p>
  </div>
  <div class="hero-surface__meta">
    <div class="hero-meta-block">
      <span class="hero-meta-label">Feed</span>
      <strong>{connectionState}</strong>
    </div>
    <div class="hero-meta-block">
      <span class="hero-meta-label">Chart window</span>
      <strong>{paperDesk.chartWindow}</strong>
    </div>
    <div class="hero-meta-block">
      <span class="hero-meta-label">As of</span>
      <strong>{new Date(paperDesk.asOf).toLocaleTimeString()}</strong>
    </div>
  </div>
</div>

{#if profitableTraders.length > 0}
  <div class="panel profit-alert profit-alert--positive">
    <div class="profit-alert__head">
      <div class="profit-alert__title">
        <span class="profit-alert__signal" aria-hidden="true"></span>
        <div>
          <div class="eyebrow">Trader Profit Alert</div>
          <strong>{profitableTraders.length} trader{profitableTraders.length === 1 ? '' : 's'} currently green on the live paper desk.</strong>
        </div>
      </div>
      <div class="profit-alert__summary status-positive">
        {signed(profitableTraderPnl)} trader PnL · firm {signed(paperDesk.totalDayPnl)}
      </div>
    </div>

    <div class="profit-alert__ticker">
      {#each profitLeaders as trader}
        <span>
          <strong>{trader.name}</strong>
          {signed(trader.dayPnl)} · {trader.winRate.toFixed(1)}% win
        </span>
      {/each}
    </div>
  </div>
{/if}

<section class="grid-hero">
  <div class="panel metric-card">
    <div class="metric-label">Paper Equity</div>
    <div class="metric-value">{currency(paperDesk.totalEquity)}</div>
    <div class:status-positive={paperDesk.totalDayPnl >= 0} class:status-negative={paperDesk.totalDayPnl < 0}>
      {signed(paperDesk.totalDayPnl)}
    </div>
  </div>
  <div class="panel metric-card">
    <div class="metric-label">Session Return</div>
    <div class="metric-value">{percent(paperDesk.totalReturnPct)}</div>
    <div class:status-positive={paperDesk.realizedPnl >= 0} class:status-negative={paperDesk.realizedPnl < 0}>
      Realized {signed(paperDesk.realizedPnl)} · Fees -{currency(paperDesk.realizedFeesUsd)}
    </div>
    <div class="subtle">Gross {signed(paperDesk.realizedGrossPnl)}</div>
  </div>
  <div class="panel metric-card">
    <div class="metric-label">Firm Win Rate</div>
    <div class="metric-value">{paperDesk.winRate.toFixed(1)}%</div>
    <div class="subtle">Broker exits {paperDesk.totalTrades} · winning traders {winningTraders}</div>
  </div>
  <div class="panel metric-card">
    <div class="metric-label">Profit Factor</div>
    <div class="metric-value">{paperDesk.analytics.profitFactor.toFixed(2)}</div>
    <div class="subtle">Open risk {currency(paperDesk.analytics.totalOpenRisk)} · active agents {paperDesk.activeAgents}</div>
  </div>
</section>

<Panel title="Pilot Progress" subtitle="What is actually active right now: broker-backed lanes, watch-only lanes, live tape, and current AI council load." aside="reality check">
  <PilotProgressSection paperDesk={paperDesk} mode="detail" />
</Panel>

<Panel title="Venue Matrix" subtitle="Exact broker mode, account state, visible tape, and sleeve coverage per venue. VIXY is explicitly surfaced on the Alpaca row." aside="routing truth">
  <VenueMatrixSection
    brokerAccounts={overview.brokerAccounts}
    liveRouteAccounts={liveRouteAccounts}
    paperDesk={paperDesk}
    serviceHealth={overview.serviceHealth}
    mode="detail"
  />
</Panel>

<section class="operator-grid">
  <Panel title="Desk Curve" subtitle="The cyan line is the adaptive paper desk. The amber line is the passive benchmark.">
    <ArenaChart
      series={[
        { label: 'Paper Desk', color: 'var(--accent)', points: paperDesk.deskCurve },
        { label: 'Benchmark', color: 'var(--warning)', points: paperDesk.benchmarkCurve }
      ]}
    />
    <div class="chart-footnote">
      <span>{currency(paperDesk.totalEquity)} from a {currency(paperDesk.startingEquity)} paper start</span>
      <span class:status-positive={paperDesk.totalDayPnl >= 0} class:status-negative={paperDesk.totalDayPnl < 0}>
        {signed(paperDesk.totalDayPnl)} total PnL · {percent(paperDesk.totalReturnPct)}
      </span>
    </div>
  </Panel>

  <Panel title="Verification" subtitle="Each sleeve stays visible with its actual venue and routing state. Watch-only lanes stay visible, but they do not affect the firm win rate.">
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
  </Panel>

  <Panel
    title="Lane Rollups"
    subtitle="30-day P&L and win rate by strategy lane. All 4 lanes shown even if zero trades."
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

<Panel title="Trader Win Rates" subtitle="Each trader’s win rate, trade count, and realized PnL from the broker-backed paper ledger.">
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
            <td>{trader.status}</td>
            <td>{trader.winRate.toFixed(1)}%</td>
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

<section class="operator-grid">
  <Panel title="Symbol Tape" subtitle="Choose a symbol to inspect its market tape, fills, and open risk levels.">
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
          <small>{tape.changePct.toFixed(2)}%</small>
        </button>
      {/each}
    </div>

    {#if selectedTape}
      <TapeChart tape={selectedTape} band={selectedBand} />

      <div class="technical-readout">
        <div class="readout-card">
          <span class="eyebrow">Session</span>
          <strong>{selectedTape.session ?? 'unknown'}</strong>
          <small>{selectedTape.status} tape</small>
        </div>
        <div class="readout-card">
          <span class="eyebrow">Spread</span>
          <strong>{selectedTape.spreadBps.toFixed(2)} bps</strong>
          <small>Liquidity {selectedTape.liquidityScore}</small>
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

  <Panel title="Tuning State" subtitle="Parameter shifts are bounded and transparent. They are meant for paper improvement, not hidden auto-pilot.">
    <div class="band-list">
      {#each paperDesk.tuning as row}
        <article class="band-card">
          <div class="band-card__head">
            <div>
              <h4>{row.agentName}</h4>
              <p class="subtle">{row.symbol} · {row.style}</p>
            </div>
            <span class={`bias-chip bias-chip--${row.improvementBias}`}>{row.improvementBias}</span>
          </div>
          <div class="band-card__levels">
            <span>Target {row.targetBps.toFixed(2)} bps</span>
            <span>Stop {row.stopBps.toFixed(2)} bps</span>
            <span>Hold {row.maxHoldTicks}</span>
            <span>Size {row.sizeFractionPct.toFixed(2)}%</span>
          </div>
          <p>{row.lastAdjustment}</p>
          {#if row.mistakeSummary}
            <p class="subtle">Mistake loop: {row.mistakeSummary}{#if row.mistakeScore !== undefined} · score {row.mistakeScore.toFixed(1)}{/if}</p>
          {/if}
        </article>
      {/each}
    </div>
  </Panel>
</section>

<Panel title="Self-Learning Scorecard" subtitle="Dominant mistake clusters, severity trends, and allocator reaction. This is the fast feedback loop made visible." aside="mistake-aware">
  <SelfLearningScorecard rows={paperDesk.tuning} />
</Panel>

<Panel title="Learning History" subtitle="Persisted review-loop logs with 7d and 30d trend windows. This is the real adaptation trail, not a marketing summary." aside="history">
  <LearningHistorySection mode="detail" initialLearning={data.learning} initialLaneLearning={data.laneLearning} />
</Panel>

<Panel title="AI Council Transcripts" subtitle="Raw prompts and raw outputs from the latest council calls. If a model errors, that is shown too." aside="transcripts">
  <AiCouncilTraceSection mode="detail" initialTraces={data.aiCouncilTraces} />
</Panel>

<Panel title="Agent Performance" subtitle="Each card shows strategy-sleeve equity derived from broker-backed fills and current marks. Venue labels now reflect the actual configured broker for each sleeve.">
  <div class="agent-grid">
    {#each paperDesk.agents as agent}
      <AgentCard {agent} />
    {/each}
  </div>
</Panel>

<section class="dual-grid">
  <Panel title="AI Council" subtitle="Claude, Codex, and Gemini review the setup in parallel. Consensus approvals move forward; hard vetoes stay sidelined.">
    {#if councilFallbackCount > 0}
      <div class="advisory-banner">
        <span>Fallback active</span>
        <span>{councilFallbackCount} of {paperDesk.aiCouncil.length} decisions fell back to API or rules instead of the configured AI/CLI transports.</span>
      </div>
    {/if}
    <div class="council-source-mix">
      <div class="council-source-head">
        <span class="eyebrow">Council source mix</span>
        <span class="subtle">{councilSourceCounts.totalVotes} votes across {councilSourceCounts.totalDecisions} verified decisions</span>
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
                queued for AI review
              {:else if decision.status === 'evaluating'}
                evaluating with AI
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

  <Panel title="Execution Tape" subtitle="Recent paper fills and queue events from the desk.">
    <div class="ticker-list">
      {#if paperDesk.fills.length === 0}
        <article class="ticker-item">
          <h4>No recent paper fills</h4>
          <p>The execution tape will populate once the desk performs its first broker-backed exit or manual flatten event.</p>
        </article>
      {:else}
        {#each paperDesk.fills as fill}
          <article class="ticker-item">
            <h4>{fill.agentName} · {fill.symbol} · {fill.side}</h4>
            <p>{fill.note}</p>
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
</section>
