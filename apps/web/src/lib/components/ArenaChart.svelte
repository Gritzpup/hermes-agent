<script lang="ts">
  type ChartSeries = {
    label: string;
    color: string;
    points: number[];
  };

  export let series: ChartSeries[] = [];

  const width = 720;
  const height = 260;
  const padding = 18;

  $: flat = series.flatMap((item) => item.points);
  $: min = flat.length > 0 ? Math.min(...flat) : 0;
  $: max = flat.length > 0 ? Math.max(...flat) : 1;
  $: range = max - min || 1;
  $: lines = series.map((item) => ({
    ...item,
    polyline: item.points
      .map((point, index) => {
        const x = padding + (index / Math.max(item.points.length - 1, 1)) * (width - padding * 2);
        const y = height - padding - ((point - min) / range) * (height - padding * 2);
        return `${x},${y}`;
      })
      .join(' ')
  }));
</script>

<div class="chart-legend">
  {#each lines as item}
    <span style={`color: ${item.color}`}>{item.label}</span>
  {/each}
</div>

<svg class="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style="height: 260px;">
  <defs>
    <linearGradient id="desk-fill" x1="0%" x2="0%" y1="0%" y2="100%">
      <stop offset="0%" stop-color="rgba(88, 208, 255, 0.26)" />
      <stop offset="100%" stop-color="rgba(88, 208, 255, 0.02)" />
    </linearGradient>
  </defs>

  <rect x="0" y="0" width={width} height={height} fill="rgba(255,255,255,0.02)" />

  {#each Array.from({ length: 5 }) as _, index}
    <line
      x1={padding}
      x2={width - padding}
      y1={padding + ((height - padding * 2) / 4) * index}
      y2={padding + ((height - padding * 2) / 4) * index}
      stroke="rgba(255,255,255,0.06)"
      stroke-width="1"
    />
  {/each}

  {#if lines[0]}
    <polygon
      points={`${padding},${height - padding} ${lines[0].polyline} ${width - padding},${height - padding}`}
      fill="url(#desk-fill)"
    />
  {/if}

  {#each lines as item}
    <polyline
      points={item.polyline}
      fill="none"
      stroke={item.color}
      stroke-width="3"
      stroke-linecap="square"
      stroke-linejoin="miter"
    />
  {/each}
</svg>
