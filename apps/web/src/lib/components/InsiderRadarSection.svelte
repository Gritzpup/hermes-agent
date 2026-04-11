<script lang="ts">
  import { onMount } from 'svelte';
  import type { InsiderRadarSnapshot, InsiderSignal, InsiderTrade } from '@hermes/contracts';
  import StatusPill from '$lib/components/StatusPill.svelte';

  const POLL_MS = 30_000;

  let snapshot: InsiderRadarSnapshot | null = null;
  let loading = true;
  let error: string | null = null;

  async function refresh(): Promise<void> {
    try {
      const response = await fetch('/api/insider-radar');
      if (!response.ok) {
        throw new Error(`Insider Radar unavailable (${response.status})`);
      }
      snapshot = await response.json() as InsiderRadarSnapshot;
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Insider Radar feed unavailable';
    } finally {
      loading = false;
    }
  }

  function currency(val: number): string {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(val);
  }

  function scoreColor(score: number): string {
    if (score >= 0.7) return 'status-positive';
    if (score >= 0.4) return 'status-warning';
    return 'status-negative';
  }

  onMount(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(interval);
  });
</script>

<div class="ir">
  {#if loading && !snapshot}
    <p class="subtle">Loading insider signals...</p>
  {:else if error}
    <p class="ir-error">{error}</p>
  {:else if snapshot}
    <div class="ir-row">
      {#each snapshot.signals.slice(0, 3) as signal}
        <div class="ir-signal">
          <div class="ir-signal__top">
            <strong>{signal.symbol}</strong>
            <StatusPill
              label={signal.direction.toUpperCase()}
              status={signal.direction === 'bullish' ? 'healthy' : signal.direction === 'bearish' ? 'critical' : 'warning'}
            />
          </div>
          <div class="ir-signal__summary">{signal.summary}</div>
          <div class="ir-signal__stats">
            <span class={scoreColor(signal.convictionScore)}>{(signal.convictionScore * 100).toFixed(0)}%</span>
            <span>{currency(signal.totalValue)}</span>
            <span>{signal.isCluster ? 'cluster' : 'single'}</span>
          </div>
        </div>
      {:else}
        <div class="ir-empty">No high-conviction signals</div>
      {/each}
    </div>

    <div class="ir-filings">
      {#each snapshot.trades.slice(0, 6) as trade}
        <div class="ir-filing">
          <strong>{trade.symbol}</strong>
          <span class={`ir-pill ir-pill--${trade.transactionType.includes('Purchase') ? 'buy' : 'sell'}`}>
            {trade.transactionType.includes('Purchase') ? 'BUY' : 'SELL'}
          </span>
          <span class="subtle">{trade.filerName}</span>
          <span>{currency(trade.totalValue)}</span>
          <span class="subtle">{new Date(trade.reportingDate).toLocaleDateString()}</span>
        </div>
      {:else}
        <div class="ir-empty">No recent filings</div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .ir {
    display: grid;
    gap: 8px;
  }

  .ir-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 6px;
  }

  .ir-signal {
    background: rgba(14, 22, 34, 0.5);
    border-left: 2px solid rgba(125, 163, 214, 0.2);
    padding: 8px 10px;
    display: grid;
    gap: 4px;
  }

  .ir-signal__top {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .ir-signal__top strong {
    font-family: var(--mono, monospace);
    font-size: 0.82rem;
  }

  .ir-signal__summary {
    font-size: 0.72rem;
    line-height: 1.3;
    color: var(--muted, #92a0b8);
    display: -webkit-box;
    line-clamp: 2;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .ir-signal__stats {
    display: flex;
    gap: 8px;
    font-family: var(--mono, monospace);
    font-size: 0.7rem;
    color: var(--muted, #92a0b8);
  }

  .ir-filings {
    display: grid;
    gap: 2px;
  }

  .ir-filing {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    font-size: 0.72rem;
    background: rgba(14, 22, 34, 0.3);
  }

  .ir-filing strong {
    font-family: var(--mono, monospace);
    font-size: 0.72rem;
    min-width: 40px;
  }

  .ir-pill {
    padding: 0px 4px;
    font-family: var(--mono, monospace);
    font-size: 0.58rem;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .ir-pill--buy { background: rgba(34, 197, 94, 0.12); color: #4ade80; }
  .ir-pill--sell { background: rgba(239, 68, 68, 0.12); color: #f87171; }

  .ir-empty {
    font-size: 0.75rem;
    color: var(--muted, #92a0b8);
    padding: 6px;
  }

  .ir-error {
    color: #ef4444;
    font-size: 0.78rem;
  }
</style>
