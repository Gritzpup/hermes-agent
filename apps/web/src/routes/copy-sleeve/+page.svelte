<script lang="ts">
  import CopySleeveSection from '$lib/components/CopySleeveSection.svelte';
  import Panel from '$lib/components/Panel.svelte';
</script>

<div class="stack">
  <div class="panel hero-surface">
    <div class="hero-surface__copy">
      <div class="eyebrow">Copy Sleeve</div>
      <h2>Delayed public-manager replication from SEC 13F filings.</h2>
      <p>
        This sleeve follows public disclosure data, not private trade flow. It is meant to stay auditably real:
        if the filing feed, historical prices, or backtest inputs disappear, the page reports that explicitly
        instead of substituting fake values.
      </p>
    </div>
    <div class="hero-surface__meta">
      <div class="hero-meta-block">
        <span class="hero-meta-label">Manager</span>
        <strong>Berkshire Hathaway</strong>
      </div>
      <div class="hero-meta-block">
        <span class="hero-meta-label">Source</span>
        <strong>SEC 13F atom/XML</strong>
      </div>
      <div class="hero-meta-block">
        <span class="hero-meta-label">Mode</span>
        <strong>paper / research only</strong>
      </div>
    </div>
  </div>

  <Panel
    title="Sleeve snapshot and quarter backtest"
    subtitle="The panel loads live SEC filings and the last completed-quarter simulation on demand. No placeholder balances, no fake PnL."
  >
    <CopySleeveSection mode="detail" />
  </Panel>
</div>
