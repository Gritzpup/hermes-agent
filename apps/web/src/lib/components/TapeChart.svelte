<script lang="ts">
  import type { PaperExecutionBand, PaperTapeSnapshot } from '@hermes/contracts';

  export let tape: PaperTapeSnapshot;
  export let band: PaperExecutionBand | null = null;

  const width = 800;
  const height = 320;
  const padding = 12;
  const pricePadding = 84;

  $: candles = tape?.candles ?? [];
  $: markerSequence = [...(tape?.markers ?? [])].reverse();

  $: rawLevels = [
    ...candles.flatMap((c) => [c.low, c.high]),
    band?.entryPrice,
    band?.stopPrice,
    band?.targetPrice,
    tape?.lastPrice
  ].filter((v): v is number => v !== null && v !== undefined);

  $: minPrice = rawLevels.length > 0 ? Math.min(...rawLevels) : 0;
  $: maxPrice = rawLevels.length > 0 ? Math.max(...rawLevels) : 1;
  $: priceBuffer = (maxPrice - minPrice) * 0.05 || 0.01;
  $: chartMin = minPrice - priceBuffer;
  $: chartMax = maxPrice + priceBuffer;
  $: chartRange = chartMax - chartMin || 1;

  // Spacing logic: Full-width stretching with max-width per candle
  $: chartWidth = width - padding - pricePadding;
  $: effectiveSlotWidth = chartWidth / Math.max(candles.length, 1);
  $: candleWidth = Math.min(effectiveSlotWidth * 0.7, 14);
  
  $: xForIndex = (index: number) =>
    padding + (index * effectiveSlotWidth) + (effectiveSlotWidth / 2);

  $: yForPrice = (price: number) =>
    height - padding - ((price - chartMin) / chartRange) * (height - padding * 2);

  const markerPath = (x: number, y: number, side: 'buy' | 'sell') =>
    side === 'buy'
      ? `${x},${y - 12} ${x - 6},${y + 2} ${x + 6},${y + 2}`
      : `${x},${y + 12} ${x - 6},${y - 2} ${x + 6},${y - 2}`;

  function formatPrice(p: number) {
    if (p == null || !Number.isFinite(p)) return '—';
    if (p > 1000) return p.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  $: gridLines = Array.from({ length: 6 }).map((_, i) => {
    const price = chartMin + (chartRange * i) / 5;
    return { y: yForPrice(price), label: formatPrice(price) };
  });

  $: lastPriceY = yForPrice(tape.lastPrice);
</script>

<div class="tape-chart">
  <div class="tape-chart__meta">
    <div class="tape-chart__title">
      <div class="status-pill status-{tape.status === 'live' ? 'healthy' : tape.status === 'delayed' ? 'warning' : 'critical'}">
        {tape.status}
      </div>
      <h4>{tape.symbol} · {tape.broker}</h4>
    </div>
    <div class="tape-chart__stats">
      <div class="stat-group">
        <span class="eyebrow">Price</span>
        <strong>{formatPrice(tape.lastPrice)}</strong>
      </div>
      <div class="stat-group">
        <span class="eyebrow">Spread</span>
        <strong>{(tape.spreadBps ?? 0).toFixed(2)}</strong>
      </div>
      <div class="stat-group">
        <span class="eyebrow">24h</span>
        <strong class:status-positive={(tape.changePct ?? 0) >= 0} class:status-negative={(tape.changePct ?? 0) < 0}>
          {(tape.changePct ?? 0) >= 0 ? '+' : ''}{(tape.changePct ?? 0).toFixed(2)}%
        </strong>
      </div>
    </div>
  </div>

  <svg class="tape-chart__svg" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient id="bgGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(88, 208, 255, 0.05)" />
        <stop offset="100%" stop-color="transparent" />
      </linearGradient>
    </defs>

    <!-- Background -->
    <rect x={padding} y={padding} width={chartWidth} height={height - padding * 2} fill="url(#bgGradient)" />

    <!-- Grid -->
    {#each gridLines as grid}
      <line x1={padding} x2={width - pricePadding} y1={grid.y} y2={grid.y} stroke="rgba(255,255,255,0.06)" />
      <text x={width - pricePadding + 8} y={grid.y + 4} fill="var(--muted)" font-family="var(--mono)" font-size="10">{grid.label}</text>
    {/each}

    {#each candles as candle, index}
      {@const x = xForIndex(index)}
      {@const highY = yForPrice(candle.high)}
      {@const lowY = yForPrice(candle.low)}
      {@const openY = yForPrice(candle.open)}
      {@const closeY = yForPrice(candle.close)}
      {@const candleUp = candle.close >= candle.open}
      {@const bodyTop = Math.min(openY, closeY)}
      {@const bodyBottom = Math.max(openY, closeY)}
      {@const bodyHeight = Math.max(bodyBottom - bodyTop, 1.5)}

      <!-- Wick -->
      <line x1={x} x2={x} y1={highY} y2={lowY} stroke={candleUp ? '#10b981' : '#f43f5e'} stroke-width="1.2" opacity="0.6"/>
      
      <!-- Body -->
      <rect
        x={x - candleWidth / 2}
        y={bodyTop}
        width={candleWidth}
        height={bodyHeight}
        fill={candleUp ? '#10b981' : '#f43f5e'}
        fill-opacity={candleUp ? '0.2' : '0.8'}
        stroke={candleUp ? '#10b981' : '#f43f5e'}
        stroke-width="1.5"
      />
    {/each}

    <!-- Current Price Line -->
    <line x1={padding} x2={width - pricePadding} y1={lastPriceY} y2={lastPriceY} stroke="rgba(255,255,255,0.2)" stroke-width="1" stroke-dasharray="4,2" />
    <rect x={width - pricePadding} y={lastPriceY - 9} width={pricePadding - 4} height={18} fill="rgba(30, 41, 59, 0.95)" stroke="var(--accent)" stroke-width="1.5" rx="2" />
    <text x={width - pricePadding + 6} y={lastPriceY + 4} fill="white" font-family="var(--mono)" font-size="10" font-weight="700">{formatPrice(tape.lastPrice)}</text>

    <!-- Target/Stop/Entry Bands -->
    {#if band?.entryPrice}
      {@const y = yForPrice(band.entryPrice)}
      <line x1={padding} x2={width - pricePadding} y1={y} y2={y} stroke="#6366f1" stroke-width="2" stroke-dasharray="8,4" />
      <text x={padding + 6} y={y - 8} fill="#818cf8" font-family="var(--mono)" font-size="10" font-weight="700">ENTRY {formatPrice(band.entryPrice)}</text>
    {/if}

    {#if band?.targetPrice}
      {@const y = yForPrice(band.targetPrice)}
      <line x1={padding} x2={width - pricePadding} y1={y} y2={y} stroke="#10b981" stroke-width="1" stroke-dasharray="4,4" opacity="0.6" />
      <text x={padding + 6} y={y - 8} fill="#10b981" font-family="var(--mono)" font-size="10" font-weight="600" opacity="0.9">TARGET {formatPrice(band.targetPrice)}</text>
    {/if}

    {#if band?.stopPrice}
      {@const y = yForPrice(band.stopPrice)}
      <line x1={padding} x2={width - pricePadding} y1={y} y2={y} stroke="#f43f5e" stroke-width="1" stroke-dasharray="4,4" opacity="0.6" />
      <text x={padding + 6} y={y - 8} fill="#f43f5e" font-family="var(--mono)" font-size="10" font-weight="600" opacity="0.9">STOP {formatPrice(band.stopPrice)}</text>
    {/if}

    {#each markerSequence as marker, index}
      {@const cIndex = Math.max(candles.length - markerSequence.length + index, 0)}
      {@const x = xForIndex(cIndex)}
      {@const y = yForPrice(marker.price)}
      <circle cx={x} cy={y} r="5" fill={marker.side === 'buy' ? '#10b981' : '#f43f5e'} stroke="white" stroke-width="1.5" />
      <text x={x} y={marker.side === 'buy' ? y + 15 : y - 10} text-anchor="middle" fill="white" font-size="9" font-weight="bold">{marker.side.toUpperCase()}</text>
    {/each}
  </svg>

  <div class="tape-chart__legend">
    <span class="legend-line" style="background: #6366f1"></span><span class="label">entry</span>
    <span class="legend-line" style="background: #10b981"></span><span class="label">target</span>
    <span class="legend-line" style="background: #f43f5e"></span><span class="label">stop</span>
    <span class="legend-dot" style="background: #10b981"></span><span class="label">buy fill</span>
    <span class="legend-dot" style="background: #f43f5e"></span><span class="label">sell fill</span>
  </div>
</div>
