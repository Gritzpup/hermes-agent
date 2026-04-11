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
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .radar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 0.5rem;
  }

  .radar-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.5rem;
  }

  .signal-card {
    background: color-mix(in srgb, var(--surface, #0f172a) 95%, white 5%);
    border: 1px solid var(--border, #233149);
    border-radius: 0.75rem;
    padding: 1rem;
    margin-bottom: 0.75rem;
    position: relative;
    overflow: hidden;
  }

  .signal-card__head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 0.5rem;
  }

  .signal-summary {
    font-size: 0.88rem;
    line-height: 1.4;
    margin-bottom: 1rem;
    color: var(--foreground, #e5eefb);
  }

  .signal-metrics {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid color-mix(in srgb, var(--border, #233149) 40%, transparent);
  }

  .metric {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
  }

  .ticker-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-height: 600px;
    overflow-y: auto;
    padding-right: 0.5rem;
  }

  .ticker-item {
    background: color-mix(in srgb, var(--surface, #0f172a) 90%, black 10%);
    border: 1px solid color-mix(in srgb, var(--border, #233149) 50%, transparent);
    border-radius: 0.5rem;
    padding: 0.75rem;
  }

  .ticker-item__meta {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.35rem;
    font-size: 0.8rem;
  }

  .ticker-item__desc {
    font-size: 0.82rem;
    color: var(--foreground, #e5eefb);
  }

  .ticker-item__time {
    font-size: 0.7rem;
    margin-top: 0.35rem;
  }

  .pill {
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.65rem;
    font-weight: 700;
  }

  .pill--buy { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
  .pill--sell { background: rgba(239, 68, 68, 0.2); color: #f87171; }

  @media (max-width: 1024px) {
    .radar-grid { grid-template-columns: 1fr; }
  }

  .error { color: #ef4444; font-size: 0.9rem; }
</style>
