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
    return 'subtle';
  }

  onMount(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(interval);
  });
</script>

<div class="insider-radar">
  <div class="radar-header">
    <span class="eyebrow">Real-time Filings & Signals</span>
    {#if snapshot}
      <span class="subtle">updated {new Date(snapshot.timestamp).toLocaleTimeString()}</span>
    {/if}
  </div>

  {#if loading && !snapshot}
    <p class="subtle">Loading insider signals...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if snapshot}
    <div class="radar-grid">
      <!-- High Conviction Signals -->
      <div class="signals-panel">
        <div class="deck-label">High Conviction Clusters</div>
        {#each snapshot.signals as signal}
          <article class="signal-card">
            <div class="signal-card__head">
              <h4>{signal.symbol}</h4>
              <StatusPill 
                label={signal.direction.toUpperCase()} 
                status={signal.direction === 'bullish' ? 'healthy' : signal.direction === 'bearish' ? 'critical' : 'warning'} 
              />
            </div>
            <p class="signal-summary">{signal.summary}</p>
            <div class="signal-metrics">
              <div class="metric">
                <span class="subtle">Conviction</span>
                <strong class={scoreColor(signal.convictionScore)}>{(signal.convictionScore * 100).toFixed(0)}%</strong>
              </div>
              <div class="metric">
                <span class="subtle">Net Vol</span>
                <strong>{currency(signal.totalValue)}</strong>
              </div>
              <div class="metric">
                <span class="subtle">Clustered</span>
                <strong>{signal.isCluster ? 'YES' : 'NO'}</strong>
              </div>
            </div>
          </article>
        {:else}
          <p class="subtle">No high-conviction signals in the current window.</p>
        {/each}
      </div>

      <!-- Recent Filings Ticker -->
      <div class="ticker-panel">
        <div class="deck-label">Recent Filings</div>
        <div class="ticker-list">
          {#each snapshot.trades.slice(0, 20) as trade}
            <div class="ticker-item">
              <div class="ticker-item__meta">
                <strong>{trade.symbol}</strong>
                <span class="subtle">{trade.source}</span>
                <span class={`pill pill--${trade.transactionType.includes('Purchase') ? 'buy' : 'sell'}`}>
                  {trade.transactionType.includes('Purchase') ? 'BUY' : 'SELL'}
                </span>
              </div>
              <div class="ticker-item__desc">
                {trade.filerName} 
                {#if trade.officerTitle}
                  <span class="subtle">({trade.officerTitle})</span>
                {/if}
                transacted {currency(trade.totalValue)}
              </div>
              <div class="ticker-item__time subtle">
                Reported {new Date(trade.reportingDate).toLocaleDateString()}
              </div>
            </div>
          {:else}
            <p class="subtle">No recent filings detected.</p>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .insider-radar {
    display: grid;
    gap: 12px;
  }

  .radar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .radar-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 14px;
  }

  .signal-card {
    background: rgba(14, 22, 34, 0.6);
    border-left: 3px solid rgba(125, 163, 214, 0.2);
    border-radius: 0;
    padding: 10px 12px;
    margin-bottom: 6px;
  }

  .signal-card__head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 6px;
  }

  .signal-card__head h4 {
    margin: 0;
    font-family: var(--mono, monospace);
    font-size: 0.88rem;
  }

  .signal-summary {
    font-size: 0.8rem;
    line-height: 1.4;
    margin-bottom: 8px;
    color: var(--foreground, #e5eefb);
  }

  .signal-metrics {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
    padding-top: 8px;
    border-top: 1px solid rgba(125, 163, 214, 0.1);
  }

  .metric {
    display: grid;
    gap: 2px;
    font-size: 0.75rem;
  }

  .metric strong {
    font-family: var(--mono, monospace);
  }

  .ticker-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 400px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: rgba(125, 163, 214, 0.15) transparent;
  }

  .ticker-item {
    background: rgba(14, 22, 34, 0.5);
    border: 1px solid rgba(125, 163, 214, 0.08);
    padding: 8px 10px;
  }

  .ticker-item__meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 3px;
    font-size: 0.78rem;
  }

  .ticker-item__desc {
    font-size: 0.78rem;
    color: var(--foreground, #e5eefb);
  }

  .ticker-item__time {
    font-size: 0.68rem;
    margin-top: 3px;
  }

  .pill {
    padding: 1px 5px;
    font-family: var(--mono, monospace);
    font-size: 0.62rem;
    font-weight: 700;
    letter-spacing: 0.05em;
  }

  .pill--buy { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
  .pill--sell { background: rgba(239, 68, 68, 0.15); color: #f87171; }

  @media (max-width: 900px) {
    .radar-grid { grid-template-columns: 1fr; }
  }

  .error { color: #ef4444; font-size: 0.82rem; }
</style>
