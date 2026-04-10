<script lang="ts">
  import { onMount } from 'svelte';
  import type { TerminalSnapshot } from '@hermes/contracts';
  import StatusPill from '$lib/components/StatusPill.svelte';

  const POLL_MS = 5_000;

  let snapshot: TerminalSnapshot | null = null;
  let loading = true;
  let error: string | null = null;

  async function refresh(): Promise<void> {
    try {
      const response = await fetch('/api/terminals');
      if (!response.ok) {
        throw new Error(`Terminal feed unavailable (${response.status})`);
      }

      snapshot = await response.json() as TerminalSnapshot;
      error = null;
    } catch (err) {
      error = err instanceof Error ? err.message : 'Terminal feed unavailable';
    } finally {
      loading = false;
    }
  }

  function classifyLine(line: string): string {
    const lower = line.toLowerCase();
    // Vote labels
    if (/^\[votes\]/.test(line)) return 'tl--label';
    if (/^\[(claude|codex|gemini)\]/.test(line)) return lower.includes('approve') ? 'tl--approve' : lower.includes('reject') ? 'tl--reject' : 'tl--vote';
    // Council pane
    if (/^\[(thesis|prompt)\]/.test(line)) return 'tl--thesis';
    if (/^\[(risk|risk note)\]/.test(line)) return 'tl--risk';
    if (/^\[(ai-council|council|queue|latest|reason)\]/.test(line)) return 'tl--council';
    if (/^\[(readiness|signals|allocator)\]/.test(line)) return 'tl--signal';
    if (/^\[(candidate|response)\]/.test(line)) return 'tl--meta';
    if (/^\[(latency)\]/.test(line)) return 'tl--dim';
    // Learning / journal
    if (/learning|journal|self-learning|lane\s+decision/i.test(lower)) return 'tl--learning';
    // Sync / universe / data
    if (/sync|universe|reseed|snapshot|market-data|oanda|coinbase|alpaca/i.test(lower)) return 'tl--data';
    // Status lines
    if (/error|failed|rejected|unavailable|crash/i.test(lower)) return 'tl--error';
    if (/approve|promoted|profit|positive|healthy|connected/i.test(lower)) return 'tl--approve';
    if (/watching|waiting|idle|stale|delayed|cooldown/i.test(lower)) return 'tl--dim';
    // Broker / routing
    if (/broker|route|routing|execution|fill/i.test(lower)) return 'tl--broker';
    // Numbers and metrics
    if (/win\s*rate|pnl|equity|drawdown|pf\s|profit\s*factor/i.test(lower)) return 'tl--metric';
    return '';
  }

  onMount(() => {
    void refresh();
    const interval = setInterval(() => {
      void refresh();
    }, POLL_MS);

    return () => clearInterval(interval);
  });
</script>

<div class="terminals-shell">
  <div class="terminals-shell__meta">
    <span class="eyebrow">live terminal panes</span>
    <span>
      {#if snapshot}
        updated {new Date(snapshot.asOf).toLocaleTimeString()}
      {:else if loading}
        connecting…
      {:else}
        waiting for telemetry
      {/if}
    </span>
    {#if error}
      <span class="terminals-shell__error">{error}</span>
    {/if}
  </div>

  {#if !snapshot && loading}
    <p class="subtle">Loading terminal panes...</p>
  {/if}

  {#if snapshot}
    {@const councilPanes = snapshot.terminals.filter((terminal) => /council|claude|codex|gemini|pi/i.test(terminal.id))}
    <div class="subtle">
      {snapshot.terminals.length} panes total · {councilPanes.length} Pi / AI council panes
    </div>
  {/if}

  <div class="terminal-grid">
    {#each snapshot?.terminals ?? [] as terminal}
      <article class="terminal-card terminal-card--{terminal.status}">
        <div class="terminal-card__head">
          <div>
            <div class="eyebrow">{terminal.id}</div>
            <strong>{terminal.label}</strong>
          </div>
          <StatusPill label={terminal.status} status={terminal.status} />
        </div>

        <p class="terminal-card__summary">{terminal.summary}</p>

        <pre class="terminal-card__body">{#each terminal.lines as line}<span class="tl {classifyLine(line)}">{line}</span>{'\n'}{/each}</pre>
      </article>
    {/each}
  </div>

  {#if snapshot && snapshot.terminals.length === 0}
    <p class="subtle">No terminal panes are available yet.</p>
  {/if}
</div>

<style>
  .terminals-shell {
    display: grid;
    gap: 1rem;
  }

  .terminals-shell__meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
    justify-content: space-between;
    color: var(--muted-foreground, #92a0b8);
    font-size: 0.9rem;
  }

  .terminals-shell__error {
    color: var(--danger-foreground, #fca5a5);
  }

  .terminal-grid {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .terminal-card {
    display: grid;
    grid-template-columns: 200px 1fr;
    grid-template-rows: auto auto;
    gap: 0 1rem;
    border-radius: 0.75rem;
    padding: 0.85rem 1rem;
    background: color-mix(in srgb, var(--surface, #0f172a) 88%, black 12%);
    border: 1px solid color-mix(in srgb, var(--border, #233149) 80%, transparent);
    border-left: 3px solid var(--border, #233149);
  }

  .terminal-card--healthy { border-left-color: #22c55e; }
  .terminal-card--warning { border-left-color: #f59e0b; }
  .terminal-card--critical { border-left-color: #ef4444; }

  .terminal-card__head {
    grid-column: 1;
    grid-row: 1 / -1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    align-self: center;
  }

  .terminal-card__summary {
    margin: 0;
    grid-column: 2;
    grid-row: 1;
    color: var(--foreground, #e5eefb);
    font-weight: 500;
    font-size: 0.88rem;
  }

  .terminal-card__body {
    margin: 0;
    grid-column: 2;
    grid-row: 2;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
    font-size: 0.78rem;
    line-height: 1.4;
    color: color-mix(in srgb, var(--foreground, #e5eefb) 85%, var(--muted-foreground, #92a0b8));
    background: color-mix(in srgb, var(--background, #020617) 80%, transparent);
    border-radius: 0.5rem;
    padding: 0.65rem 0.8rem;
    margin-top: 0.3rem;
    border: 1px solid color-mix(in srgb, var(--border, #233149) 50%, transparent);
  }

  @media (max-width: 640px) {
    .terminal-card {
      grid-template-columns: 1fr;
    }
    .terminal-card__head {
      grid-row: 1;
      flex-direction: row;
      align-items: center;
      justify-content: space-between;
    }
  }

  .tl--council { color: #60a5fa; }
  .tl--thesis { color: #a78bfa; }
  .tl--risk { color: #f59e0b; }
  .tl--vote { color: #94a3b8; }
  .tl--approve { color: #4ade80; }
  .tl--reject { color: #f87171; }
  .tl--error { color: #ef4444; }
  .tl--signal { color: #22d3ee; }
  .tl--meta { color: #c084fc; }
  .tl--label { color: #64748b; font-weight: 600; }
  .tl--dim { color: #64748b; }
  .tl--learning { color: #fb923c; }
  .tl--data { color: #38bdf8; }
  .tl--broker { color: #a3e635; }
  .tl--metric { color: #fbbf24; }
</style>
