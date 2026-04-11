<script lang="ts">
  export let signals: Array<{
    symbol: string;
    direction: string;
    confidence: number;
    rsi2?: number;
    stochastic?: { k: number; d: number; crossover: string };
    obiWeighted?: number;
    reasons?: string[];
  }>;
  export let fearGreed: { value: number; label: string; regime: string } | null;

  function dirColor(dir: string): string {
    if (dir === 'strong-buy' || dir === 'buy') return 'status-positive';
    if (dir === 'strong-sell' || dir === 'sell') return 'status-negative';
    return 'status-warning';
  }

  function rsiColor(rsi: number | undefined): string {
    if (rsi === undefined) return '';
    if (rsi < 15) return 'status-positive';
    if (rsi > 85) return 'status-negative';
    return '';
  }

  function obiColor(obi: number | undefined): string {
    if (obi === undefined) return '';
    if (obi > 0.3) return 'status-positive';
    if (obi < -0.3) return 'status-negative';
    return '';
  }

  function fngColor(val: number): string {
    if (val <= 25) return 'status-positive';
    if (val >= 75) return 'status-negative';
    return 'status-warning';
  }
</script>

<div class="ms">
  {#if fearGreed}
    <div class="ms-fng">
      <span class="ms-label">Fear/Greed</span>
      <span class={`ms-val ${fngColor(fearGreed.value)}`}>{fearGreed.value}</span>
      <span class="subtle">{fearGreed.label}</span>
    </div>
  {/if}

  <div class="ms-grid">
    {#each signals as sig}
      <div class="ms-row">
        <strong class="ms-sym">{sig.symbol}</strong>
        <span class={`ms-dir ${dirColor(sig.direction)}`}>{sig.direction.toUpperCase()}</span>
        <span class="ms-conf">{sig.confidence}%</span>
        <span class={`ms-rsi ${rsiColor(sig.rsi2)}`} title="RSI(2)">{sig.rsi2 !== undefined ? `R${sig.rsi2.toFixed(0)}` : ''}</span>
        {#if sig.stochastic}
          <span class="ms-stoch" title="Stochastic K/D">{sig.stochastic.k.toFixed(0)}/{sig.stochastic.d.toFixed(0)}{sig.stochastic.crossover !== 'none' ? (sig.stochastic.crossover === 'bullish' ? '\u2191' : '\u2193') : ''}</span>
        {/if}
        <span class={`ms-obi ${obiColor(sig.obiWeighted)}`} title="Weighted OBI">{sig.obiWeighted !== undefined ? `${(sig.obiWeighted * 100).toFixed(0)}%` : ''}</span>
      </div>
    {:else}
      <div class="ms-empty">No signals</div>
    {/each}
  </div>
</div>

<style>
  .ms { display: grid; gap: 6px; }

  .ms-fng {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px;
    background: rgba(14, 22, 34, 0.4);
    font-size: 0.72rem;
  }

  .ms-label {
    font-family: var(--mono, monospace);
    font-size: 0.68rem;
    color: var(--muted, #92a0b8);
  }

  .ms-val {
    font-family: var(--mono, monospace);
    font-weight: 700;
    font-size: 0.78rem;
  }

  .ms-grid { display: grid; gap: 2px; }

  .ms-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 8px;
    font-size: 0.7rem;
    font-family: var(--mono, monospace);
    background: rgba(14, 22, 34, 0.3);
  }

  .ms-sym { min-width: 60px; font-size: 0.72rem; }

  .ms-dir {
    padding: 0 4px;
    font-size: 0.58rem;
    font-weight: 700;
    letter-spacing: 0.04em;
  }

  .ms-conf { min-width: 28px; text-align: right; color: var(--muted, #92a0b8); }
  .ms-rsi { min-width: 24px; text-align: right; }
  .ms-stoch { min-width: 40px; text-align: right; color: var(--muted, #92a0b8); }
  .ms-obi { min-width: 28px; text-align: right; }

  .ms-empty {
    font-size: 0.72rem;
    color: var(--muted, #92a0b8);
    padding: 6px;
  }

  .status-positive { color: #4ade80; }
  .status-negative { color: #f87171; }
  .status-warning { color: #fbbf24; }
</style>
