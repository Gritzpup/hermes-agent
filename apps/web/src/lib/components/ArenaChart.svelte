<script lang="ts">
  type ChartSeries = {
    label: string;
    color: string;
    points: number[];
  };

  export let series: ChartSeries[] = [];

  const width = 800;
  const height = 280;
  const padding = 18;

  $: flat = series.flatMap((item) => item.points);
  $: min = flat.length > 0 ? Math.min(...flat) : 0;
  $: max = flat.length > 0 ? Math.max(...flat) : 1;
  $: range = max - min || 1;
  const rightLabelPad = 50;
  $: lines = series.map((item) => {
    const last = item.points[item.points.length - 1] ?? 0;
    const first = item.points[0] ?? 0;
    const returnPct = first !== 0 ? ((last - first) / Math.abs(first)) * 100 : 0;
    const lastY = height - padding - ((last - min) / range) * (height - padding * 2);
    return {
      ...item,
      returnPct,
      lastY,
      polyline: item.points
        .map((point, index) => {
          const x = padding + (index / Math.max(item.points.length - 1, 1)) * (width - padding * 2 - rightLabelPad);
          const y = height - padding - ((point - min) / range) * (height - padding * 2);
          return `${x},${y}`;
        })
        .join(' ')
    };
  });
</script>

<div class="chart-legend">
  {#each lines as item}
    <span style={`color: ${item.color}`}>{item.label}</span>
  {/each}
</div>

<svg class="arena-chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet" style="width: 100%; height: auto; min-height: 200px;">
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
      stroke-width={item.label === 'Strategy basket' ? '3' : '2'}
      stroke-linecap="square"
      stroke-linejoin="miter"
      opacity={item.label === 'Passive basket' ? '0.4' : '0.9'}
    />
  {/each}

  <!-- Right-side return labels -->
  {#each lines as item}
    {#if item.points.length > 0}
      <text
        x={width - rightLabelPad + 6}
        y={item.lastY + 4}
        fill={item.color}
        font-size="11"
        font-family="var(--mono, monospace)"
        font-weight="600"
      >{item.returnPct >= 0 ? '+' : ''}{item.returnPct.toFixed(1)}%</text>
    {/if}
  {/each}
</svg>
