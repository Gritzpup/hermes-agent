<script lang="ts">
  export let points: number[] = [];
  export let color = 'var(--cyan)';
  export let fill = 'rgba(88, 208, 255, 0.12)';

  const width = 180;
  const height = 62;
  const padding = 5;

  $: min = points.length > 0 ? Math.min(...points) : 0;
  $: max = points.length > 0 ? Math.max(...points) : 1;
  $: range = max - min || 1;
  $: line = points
    .map((point, index) => {
      const x = padding + (index / Math.max(points.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - ((point - min) / range) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(' ');
  $: area = `${padding},${height - padding} ${line} ${width - padding},${height - padding}`;
</script>

<svg class="sparkline" viewBox={`0 0 ${width} ${height}`} aria-hidden="true" preserveAspectRatio="none">
  <polygon points={area} fill={fill} />
  <polyline points={line} fill="none" stroke={color} stroke-width="3" stroke-linecap="square" stroke-linejoin="miter" />
</svg>
