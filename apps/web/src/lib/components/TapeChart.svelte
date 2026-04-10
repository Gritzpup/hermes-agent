<script lang="ts">
  import type { PaperExecutionBand, PaperTapeSnapshot } from '@hermes/contracts';

  export let tape: PaperTapeSnapshot;
  export let band: PaperExecutionBand | null = null;

  const width = 640;
  const height = 280;
  const padding = 28;

  $: candles = tape?.candles ?? [];
  $: markerSequence = [...(tape?.markers ?? [])].reverse();
  $: priceLevels = [
    ...candles.flatMap((candle) => [candle.low, candle.high]),
    band?.entryPrice ?? [],
    band?.stopPrice ?? [],
    band?.targetPrice ?? [],
    band?.currentPrice ?? []
  ].flat().filter((value): value is number => typeof value === 'number');
  $: min = priceLevels.length > 0 ? Math.min(...priceLevels) : 0;
  $: max = priceLevels.length > 0 ? Math.max(...priceLevels) : 1;
  $: range = max - min || 1;

  const xForIndex = (index: number, total: number) =>
    padding + ((index + 0.5) / Math.max(total, 1)) * (width - padding * 2);

  const yForPrice = (price: number) =>
    height - padding - ((price - min) / range) * (height - padding * 2);

  const markerPath = (x: number, y: number, side: 'buy' | 'sell') =>
    side === 'buy'
      ? `${x},${y - 10} ${x - 7},${y + 4} ${x + 7},${y + 4}`
      : `${x},${y + 10} ${x - 7},${y - 4} ${x + 7},${y - 4}`;
</script>

<div class="tape-chart">
  <div class="tape-chart__meta">
    <div>
      <div class="eyebrow">{tape.status === 'live' ? 'Live market tape' : tape.status === 'delayed' ? 'Delayed market tape' : 'Stale market tape'}</div>
      <h4>{tape.symbol} · {tape.broker}</h4>
      <p class="subtle">
        {tape.source ?? 'unknown'} source
        {#if tape.updatedAt}
          · updated {new Date(tape.updatedAt).toLocaleTimeString()}
        {/if}
      </p>
    </div>
    <div class="tape-chart__stats">
      <span>{tape.lastPrice.toFixed(2)}</span>
      <span>{tape.changePct.toFixed(2)}%</span>
      <span>{tape.spreadBps.toFixed(2)} bps</span>
      <span>LQ {tape.liquidityScore}</span>
    </div>
  </div>

  <svg class="tape-chart__svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-label={`${tape.symbol} price tape`}>
    <rect x="0" y="0" width={width} height={height} fill="rgba(4, 8, 14, 0.72)" />

    {#each Array.from({ length: 5 }) as _, index}
      <line
        x1={padding}
        x2={width - padding}
        y1={padding + ((height - padding * 2) / 4) * index}
        y2={padding + ((height - padding * 2) / 4) * index}
        stroke="rgba(117, 151, 194, 0.16)"
        stroke-width="1"
      />
    {/each}

    {#each candles as candle, index}
      {@const x = xForIndex(index, candles.length)}
      {@const wickTop = yForPrice(candle.high)}
      {@const wickBottom = yForPrice(candle.low)}
      {@const openY = yForPrice(candle.open)}
      {@const closeY = yForPrice(candle.close)}
      {@const candleUp = candle.close >= candle.open}
      <line
        x1={x}
        x2={x}
        y1={wickTop}
        y2={wickBottom}
        stroke={candleUp ? 'var(--positive)' : 'var(--negative)'}
        stroke-width="2"
      />
      <rect
        x={x - 10}
        y={Math.min(openY, closeY)}
        width="20"
        height={Math.max(Math.abs(closeY - openY), 3)}
        fill={candleUp ? 'rgba(80, 233, 166, 0.22)' : 'rgba(255, 107, 122, 0.22)'}
        stroke={candleUp ? 'var(--positive)' : 'var(--negative)'}
        stroke-width="1.4"
      />
    {/each}

    {#if band?.entryPrice !== null && band?.entryPrice !== undefined}
      <line
        x1={padding}
        x2={width - padding}
        y1={yForPrice(band.entryPrice)}
        y2={yForPrice(band.entryPrice)}
        stroke="var(--accent)"
        stroke-width="1.4"
        stroke-dasharray="8 8"
      />
    {/if}

    {#if band?.stopPrice !== null && band?.stopPrice !== undefined}
      <line
        x1={padding}
        x2={width - padding}
        y1={yForPrice(band.stopPrice)}
        y2={yForPrice(band.stopPrice)}
        stroke="var(--negative)"
        stroke-width="1.4"
        stroke-dasharray="4 6"
      />
    {/if}

    {#if band?.targetPrice !== null && band?.targetPrice !== undefined}
      <line
        x1={padding}
        x2={width - padding}
        y1={yForPrice(band.targetPrice)}
        y2={yForPrice(band.targetPrice)}
        stroke="var(--positive)"
        stroke-width="1.4"
        stroke-dasharray="4 6"
      />
    {/if}

    {#each markerSequence as marker, index}
      {@const x = xForIndex(Math.min(index + Math.max(candles.length - markerSequence.length, 0), Math.max(candles.length - 1, 0)), candles.length)}
      {@const y = yForPrice(marker.price)}
      <polygon
        points={markerPath(x, y, marker.side)}
        fill={marker.side === 'buy' ? 'var(--accent)' : 'var(--negative)'}
      />
    {/each}
  </svg>

  <div class="tape-chart__legend">
    <span class="legend-line legend-line--accent">entry</span>
    <span class="legend-line legend-line--positive">target</span>
    <span class="legend-line legend-line--negative">stop</span>
    <span class="legend-trade legend-trade--buy">buy fill</span>
    <span class="legend-trade legend-trade--sell">sell fill</span>
  </div>
</div>
