<script lang="ts">
  import MacroPreservationSection from '$lib/components/MacroPreservationSection.svelte';
  import Panel from '$lib/components/Panel.svelte';
</script>

<div class="stack">
  <div class="panel hero-surface">
    <div class="hero-surface__copy">
      <div class="eyebrow">Macro Preservation</div>
      <h2>Cash first. Oil and precious metals only when inflation is real.</h2>
      <p>
        This sleeve is designed to preserve capital rather than force exposure. It tracks public CPI data
        with a release lag, then rotates into a real-asset basket only when inflation is hot enough and the
        tape supports it. If the data is missing, the page says so instead of inventing a result.
      </p>
    </div>
    <div class="hero-surface__meta">
      <div class="hero-meta-block">
        <span class="hero-meta-label">Primary hedge</span>
        <strong>GLD / DBC / USO / SLV</strong>
      </div>
      <div class="hero-meta-block">
        <span class="hero-meta-label">Fallback</span>
        <strong>BIL cash proxy</strong>
      </div>
      <div class="hero-meta-block">
        <span class="hero-meta-label">Benchmark</span>
        <strong>SPY</strong>
      </div>
    </div>
  </div>

  <Panel
    title="Macro sleeve backtest and current posture"
    subtitle="The backtest uses released CPI data, not future information. The posture view shows what the sleeve would do now, not what we wish it would have done."
  >
    <MacroPreservationSection mode="detail" />
  </Panel>
</div>
