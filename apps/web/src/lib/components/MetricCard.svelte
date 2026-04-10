<script lang="ts">
  import Sparkline from '$lib/components/Sparkline.svelte';

  export let title: string;
  export let value: string;
  export let delta: string;
  export let tone: 'positive' | 'warning' | 'negative' = 'positive';
  export let points: number[] = [];
</script>

<div class={`panel metric-card tone-${tone}`}>
  <div class="metric-label">{title}</div>
  <div class="metric-value">{value}</div>
  <div class={`metric-delta ${tone}`}>{delta}</div>
  <Sparkline {points} color={tone === 'negative' ? 'var(--red)' : tone === 'warning' ? 'var(--amber)' : 'var(--green)'} fill={tone === 'negative' ? 'rgba(240, 125, 125, 0.12)' : tone === 'warning' ? 'rgba(243, 184, 103, 0.12)' : 'rgba(83, 214, 157, 0.12)'} />
</div>
