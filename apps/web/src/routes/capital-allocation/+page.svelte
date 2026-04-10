<script lang="ts">
  import CapitalAllocatorSection from '$lib/components/CapitalAllocatorSection.svelte';
  import Panel from '$lib/components/Panel.svelte';
</script>

<div class="stack">
  <div class="panel hero-surface">
    <div class="hero-surface__copy">
      <div class="eyebrow">Capital Allocation</div>
      <h2>One allocator across all sleeves, with cash as the default.</h2>
      <p>
        This page is the firm-level capital policy view. Live weight only goes to sleeves that clear
        the KPI ratio, after-cost, parity, and regime gates. Forex, bond, copy, macro, pairs, grid,
        and maker are all visible here, but paper-only sleeves stay at zero until they earn the right
        to receive real capital.
      </p>
    </div>
    <div class="hero-surface__meta">
      <div class="hero-meta-block">
        <span class="hero-meta-label">Live rule</span>
        <strong>KPI + edge + parity + regime</strong>
      </div>
      <div class="hero-meta-block">
        <span class="hero-meta-label">Default</span>
        <strong>cash / T-bills</strong>
      </div>
      <div class="hero-meta-block">
        <span class="hero-meta-label">Scope</span>
        <strong>scalping, pairs, grid, maker, copy, macro, forex, bond</strong>
      </div>
    </div>
  </div>

  <Panel
    title="Allocator snapshot"
    subtitle="The unified allocation policy scores each sleeve, exposes the firm KPI ratio, and only assigns live weight where the live gate is open."
  >
    <CapitalAllocatorSection mode="detail" />
  </Panel>
</div>
