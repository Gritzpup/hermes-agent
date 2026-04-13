<script lang="ts">
  import { onMount } from 'svelte';
  import type { TerminalSnapshot } from '@hermes/contracts';
  import StatusPill from '$lib/components/StatusPill.svelte';

  const MAX_LOG = 400;

  let snapshot: TerminalSnapshot | null = null;
  let loading = true;
  let error: string | null = null;
  let activeTab = -1;
  let bodyEl: HTMLPreElement;
  let autoScroll = true;
  let feedSSE: EventSource | null = null;
  let logSSE: EventSource | null = null;
  let lineCount = 0;

  function connectFeed() {
    feedSSE = new EventSource('/api/feed');
    feedSSE.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.overview?.terminals) {
          snapshot = data.overview as TerminalSnapshot;
          error = null;
          loading = false;
        }
      } catch { /* skip */ }
    };
    feedSSE.onerror = () => { error = 'Feed reconnecting...'; };
  }

  /** Append directly to DOM — bypasses Svelte diffing entirely */
  function appendLine(ts: string, source: string, text: string, cls: string) {
    if (!bodyEl) return;
    const line = document.createElement('div');
    line.className = 'tl-line';
    line.innerHTML = `<span class="tl tl--ts">${ts}</span> <span class="tl tl--src">${source.padEnd(20)}</span> <span class="tl ${cls}">${escapeHtml(text)}</span>`;
    bodyEl.appendChild(line);
    lineCount++;
    // Prune old lines from top
    while (lineCount > MAX_LOG && bodyEl.firstChild) {
      bodyEl.removeChild(bodyEl.firstChild);
      lineCount--;
    }
    if (autoScroll) bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function connectLiveLog() {
    logSSE = new EventSource('/api/live-log');
    logSSE.onmessage = (event) => {
      try {
        const entry = JSON.parse(event.data);
        const ts = new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        appendLine(ts, entry.source, entry.text, classifyLine(entry.text));
      } catch { /* skip */ }
    };
    logSSE.onerror = () => { /* auto-reconnect */ };
  }

  function classifyLine(line: string): string {
    const lower = line.toLowerCase();
    if (/^\[votes\]/.test(line)) return 'tl--label';
    if (/^\[(claude|codex|gemini)\]/.test(line)) return lower.includes('approve') ? 'tl--approve' : lower.includes('reject') ? 'tl--reject' : 'tl--vote';
    if (/tick \d+/i.test(line)) return 'tl--dim';
    if (/in.trade|unrealized|position/i.test(lower)) return 'tl--approve';
    if (/cooldown/i.test(lower)) return 'tl--risk';
    if (/spread|price|mark/i.test(lower) && /\d/.test(line)) return 'tl--data';
    if (/thesis|prompt/i.test(lower)) return 'tl--thesis';
    if (/risk|stop|drawdown/i.test(lower)) return 'tl--risk';
    if (/council|queue|decision/i.test(lower)) return 'tl--council';
    if (/signal|readiness|allocator/i.test(lower)) return 'tl--signal';
    if (/error|failed|unavailable|crash/i.test(lower)) return 'tl--error';
    if (/approve|profit|positive|healthy|connected/i.test(lower)) return 'tl--approve';
    if (/watching|waiting|idle|veto|skip/i.test(lower)) return 'tl--dim';
    if (/broker|route|fill/i.test(lower)) return 'tl--broker';
    if (/win.*rate|pnl|equity|pf /i.test(lower)) return 'tl--metric';
    if (/learning|tuning/i.test(lower)) return 'tl--learning';
    return '';
  }

  function tabColor(status: string): string {
    if (status === 'healthy') return '#22c55e';
    if (status === 'critical') return '#ef4444';
    return '#f59e0b';
  }

  function handleScroll() {
    if (!bodyEl) return;
    autoScroll = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 40;
  }

  // Auto-scroll handled directly in appendLine() — no afterUpdate needed for the All tab

  $: terminals = snapshot?.terminals ?? [];
  $: active = activeTab === -1 ? null : (terminals[activeTab] ?? null);
  $: if (activeTab >= 0 && activeTab >= terminals.length && terminals.length > 0) activeTab = 0;

  onMount(() => {
    connectFeed();
    connectLiveLog();
    return () => {
      feedSSE?.close();
      logSSE?.close();
    };
  });
</script>

<div class="term">
  {#if !snapshot && loading}
    <div class="term__empty">Connecting to terminal feed...</div>
  {:else if error && !snapshot}
    <div class="term__empty term__empty--err">{error}</div>
  {:else if terminals.length === 0}
    <div class="term__empty">No terminal panes available.</div>
  {:else}
    <div class="term__tabs" role="tablist">
      <button
        class="term__tab"
        class:term__tab--active={activeTab === -1}
        role="tab"
        aria-selected={activeTab === -1}
        on:click={() => activeTab = -1}
      >
        <span class="term__tab-dot" style="background:#58d0ff"></span>
        <span class="term__tab-label">All</span>
      </button>
      {#each terminals as t, i}
        <button
          class="term__tab"
          class:term__tab--active={i === activeTab}
          role="tab"
          aria-selected={i === activeTab}
          on:click={() => activeTab = i}
        >
          <span class="term__tab-dot" style="background:{tabColor(t.status)}"></span>
          <span class="term__tab-label">{t.label}</span>
        </button>
      {/each}
    </div>

    <pre class="term__body" bind:this={bodyEl} on:scroll={handleScroll} style:display={activeTab === -1 ? '' : 'none'}></pre>
    {#if activeTab !== -1 && active}
      <div class="term__head">
        <div class="term__title">
          <span class="term__id">{active.id}</span>
          <StatusPill label={active.status} status={active.status} />
        </div>
        <p class="term__summary">{active.summary}</p>
        {#if snapshot}
          <span class="term__ts">{new Date(snapshot.asOf).toLocaleTimeString()}</span>
        {/if}
      </div>
      <pre class="term__body">{#each active.lines as line}<span class="tl {classifyLine(line)}">{line}</span>{'\n'}{/each}</pre>
    {/if}
  {/if}
</div>

<style>
  .term {
    display: grid;
    gap: 0;
    border-radius: 0.75rem;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--border, #233149) 80%, transparent);
    background: color-mix(in srgb, var(--surface, #0f172a) 88%, black 12%);
  }

  .term__empty {
    padding: 2rem;
    text-align: center;
    color: var(--muted-foreground, #92a0b8);
    font-size: 0.88rem;
  }
  .term__empty--err { color: #fca5a5; }

  .term__tabs {
    display: flex;
    overflow-x: auto;
    scrollbar-width: none;
    border-bottom: 1px solid color-mix(in srgb, var(--border, #233149) 60%, transparent);
    background: color-mix(in srgb, var(--background, #020617) 60%, var(--surface, #0f172a));
  }
  .term__tabs::-webkit-scrollbar { display: none; }

  .term__tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    border: none;
    background: transparent;
    color: var(--muted-foreground, #92a0b8);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.72rem;
    cursor: pointer;
    white-space: nowrap;
    border-bottom: 2px solid transparent;
    transition: background 0.12s, color 0.12s;
  }
  .term__tab:hover {
    background: rgba(88, 208, 255, 0.04);
    color: var(--foreground, #e5eefb);
  }
  .term__tab--active {
    color: var(--foreground, #e5eefb);
    border-bottom-color: #58d0ff;
    background: rgba(88, 208, 255, 0.06);
  }

  .term__tab-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .term__tab-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .term__head {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 16px;
    align-items: center;
    padding: 10px 14px;
    border-bottom: 1px solid color-mix(in srgb, var(--border, #233149) 40%, transparent);
  }
  .term__title { display: flex; align-items: center; gap: 8px; }
  .term__id {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.72rem;
    color: var(--muted-foreground, #92a0b8);
  }
  .term__summary { margin: 0; font-size: 0.84rem; color: var(--foreground, #e5eefb); flex: 1; }
  .term__ts {
    font-size: 0.72rem;
    color: var(--muted-foreground, #64748b);
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  }

  .term__body {
    margin: 0;
    padding: 10px 12px;
    min-height: 270px;
    max-height: 630px;
    overflow-y: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
    font-size: 0.73rem;
    line-height: 1.35;
    color: color-mix(in srgb, var(--foreground, #e5eefb) 80%, var(--muted-foreground, #92a0b8));
    background: #020a14;
  }

  /* Dynamic DOM lines — must be :global since they bypass Svelte */
  :global(.tl-line) { white-space: pre; }
  :global(.tl--ts) { color: #334155; }
  :global(.tl--src) { color: #475569; font-weight: 600; }
  :global(.tl--council) { color: #60a5fa; }
  :global(.tl--thesis) { color: #a78bfa; }
  :global(.tl--risk) { color: #f59e0b; }
  :global(.tl--vote) { color: #94a3b8; }
  :global(.tl--approve) { color: #4ade80; }
  :global(.tl--reject) { color: #f87171; }
  :global(.tl--error) { color: #ef4444; }
  :global(.tl--signal) { color: #22d3ee; }
  :global(.tl--meta) { color: #c084fc; }
  :global(.tl--label) { color: #64748b; font-weight: 600; }
  :global(.tl--dim) { color: #334155; }
  :global(.tl--learning) { color: #fb923c; }
  :global(.tl--data) { color: #38bdf8; }
  :global(.tl--broker) { color: #a3e635; }
  :global(.tl--metric) { color: #fbbf24; }
</style>
