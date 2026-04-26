// Smoke test for the bridge's openclaw-response parser using Node's built-in test runner.
// Run: node --loader tsx --test src/__tests__/parser.test.ts
//
// The parser has broken multiple times in development — this test codifies the two envelope
// shapes we've actually observed from openclaw so regressions surface quickly.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The parser is internal to openclaw-client.ts. For now we duplicate its envelope-parsing
// logic verbatim here so the test can exercise the real strings without reaching into the
// module. If the parser ever moves to its own exported function, this imports it instead.
function parseCooEnvelope(stdout: string, stderr: string): { summary: string; actions: unknown[] } | null {
  const combined = (stdout + '\n' + stderr).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  const envStart = combined.indexOf('{');
  if (envStart === -1) return null;
  let envelope: unknown;
  try { envelope = JSON.parse(combined.slice(envStart)); }
  catch {
    const last = combined.lastIndexOf('}');
    envelope = JSON.parse(combined.slice(envStart, last + 1));
  }
  const e = envelope as Record<string, unknown>;
  let replyText: string | null = null;
  if (Array.isArray(e.payloads) && e.payloads.length > 0) {
    const p0 = e.payloads[0] as Record<string, unknown>;
    if (typeof p0.text === 'string') replyText = p0.text;
  }
  if (!replyText && typeof e.reply === 'string') replyText = e.reply;
  if (!replyText) {
    // fallback: seek any string containing our schema markers
    const seek = (obj: unknown): string | null => {
      if (typeof obj === 'string') return (obj.includes('"summary"') && obj.includes('"actions"')) ? obj : null;
      if (Array.isArray(obj)) { for (const x of obj) { const r = seek(x); if (r) return r; } return null; }
      if (obj && typeof obj === 'object') { for (const v of Object.values(obj)) { const r = seek(v); if (r) return r; } }
      return null;
    };
    replyText = seek(envelope);
  }
  if (!replyText) return null;
  const m = replyText.match(/\{[\s\S]*\}/);
  if (!m) return null;
  return JSON.parse(m[0]) as { summary: string; actions: unknown[] };
}

test('parser handles payloads[0].text shape (openclaw --local)', () => {
  const stderr = `[plugins] plugins.allow is empty\n{\n  "payloads": [{"text": "{\\"summary\\":\\"ok\\",\\"actions\\":[{\\"type\\":\\"noop\\"}]}"}],\n  "meta": {"durationMs": 100}\n}\n`;
  const result = parseCooEnvelope('', stderr);
  assert.ok(result, 'expected parsed response');
  assert.equal(result!.summary, 'ok');
  assert.deepEqual(result!.actions, [{ type: 'noop' }]);
});

test('parser handles legacy reply shape (envelope.reply as string)', () => {
  const stdout = JSON.stringify({ reply: '{"summary":"legacy","actions":[{"type":"note","text":"x"}]}' });
  const result = parseCooEnvelope(stdout, '');
  assert.ok(result);
  assert.equal(result!.summary, 'legacy');
});

test('parser returns null on NO_REPLY pattern', () => {
  const stderr = `{\n  "payloads": [],\n  "meta": {"finalAssistantVisibleText": "NO_REPLY"}\n}`;
  const result = parseCooEnvelope('', stderr);
  // Current behavior: NO_REPLY → null. This is correct: the bridge should not enact when
  // the COO explicitly refused to respond.
  assert.equal(result, null);
});

test('parser strips ANSI escape codes', () => {
  const stderr = '\x1b[33m[warn]\x1b[0m {"payloads":[{"text":"{\\"summary\\":\\"ansi\\",\\"actions\\":[]}"}]}';
  const result = parseCooEnvelope('', stderr);
  assert.ok(result);
  assert.equal(result!.summary, 'ansi');
});

test('parser rejects empty output', () => {
  assert.equal(parseCooEnvelope('', ''), null);
});

test('parser handles trailing garbage after envelope (fallback to lastBrace)', () => {
  const stderr = `{"payloads":[{"text":"{\\"summary\\":\\"trailing\\",\\"actions\\":[]}"}]}\nspurious garbage after`;
  const result = parseCooEnvelope('', stderr);
  assert.ok(result);
  assert.equal(result!.summary, 'trailing');
});

test('parser handles deeply-nested schema via seek fallback', () => {
  // When payloads[0].text is missing but the schema is somewhere in the envelope.
  const stderr = `{"meta":{"nested":{"finalAssistantVisibleText":"{\\"summary\\":\\"deep\\",\\"actions\\":[{\\"type\\":\\"note\\",\\"text\\":\\"ok\\"}]}"}}}`;
  const result = parseCooEnvelope('', stderr);
  assert.ok(result);
  assert.equal(result!.summary, 'deep');
  assert.equal(result!.actions.length, 1);
});

test('parser handles multi-action response', () => {
  const stderr = `{"payloads":[{"text":"{\\"summary\\":\\"multi\\",\\"actions\\":[{\\"type\\":\\"pause-strategy\\",\\"strategy\\":\\"grid-xrp-usd\\",\\"reason\\":\\"losing\\"},{\\"type\\":\\"note\\",\\"text\\":\\"watch it\\"}]}"}]}`;
  const result = parseCooEnvelope('', stderr);
  assert.ok(result);
  assert.equal(result!.actions.length, 2);
  assert.equal((result!.actions[0] as Record<string, unknown>).type, 'pause-strategy');
});

test('parser rejects non-json content with no schema markers', () => {
  const stderr = `The COO decided not to respond this turn. No JSON here.`;
  assert.equal(parseCooEnvelope('', stderr), null);
});

// ── Defensive parser tests (Director context staleness fix c) ───────────────────
// These tests exercise the symbol-validation logic that guards against hallucinated
// "ghost symbols" in the COO response. The logic is duplicated verbatim here so
// tests run without importing internal-only functions from openclaw-client.ts.

interface RollingContextExt {
  context_version: string | undefined;
  live_venue_per_symbol: Record<string, string> | undefined;
  broker_capabilities: Record<string, string[]> | undefined;
  alpaca_has_activity: boolean | undefined;
}

function extractDirectorContext(ctx: unknown): RollingContextExt {
  if (!ctx || typeof ctx !== 'object') {
    return { context_version: undefined, live_venue_per_symbol: undefined, broker_capabilities: undefined, alpaca_has_activity: undefined };
  }
  const c = ctx as RollingContextExt;
  return {
    context_version: typeof c.context_version === 'string' ? c.context_version : undefined,
    live_venue_per_symbol: c.live_venue_per_symbol && typeof c.live_venue_per_symbol === 'object'
      ? c.live_venue_per_symbol
      : undefined,
    broker_capabilities: c.broker_capabilities && typeof c.broker_capabilities === 'object'
      ? c.broker_capabilities
      : undefined,
    alpaca_has_activity: typeof c.alpaca_has_activity === 'boolean' ? c.alpaca_has_activity : undefined,
  };
}

type TestAction = { type: string; [k: string]: unknown };

function validateDirectorSymbols(actions: TestAction[], dc: RollingContextExt): void {
  const { live_venue_per_symbol: venueMap, broker_capabilities: caps } = dc;
  const knownSymbols = new Set<string>();
  if (venueMap) {
    for (const sym of Object.keys(venueMap)) knownSymbols.add(sym);
  }
  if (caps) {
    for (const symbols of Object.values(caps)) {
      for (const sym of (symbols ?? [])) knownSymbols.add(sym);
    }
  }
  if (knownSymbols.size === 0) return; // conservative: skip when no data
  const unknownSymbols = new Set<string>();
  for (const action of actions) {
    if (action.type === 'force-close-symbol') {
      const sym = String(action.symbol ?? '').trim();
      if (sym && !knownSymbols.has(sym)) unknownSymbols.add(sym);
    }
    if ('strategy' in action) {
      const strat = String(action.strategy ?? '');
      const embedded = strat.toUpperCase().match(/[-_]([A-Z]{2,}[-_][A-Z]{2,}|[A-Z]{2,}[-][A-Z0-9]{2,})/)?.[1]?.replace(/_/g, '-');
      if (embedded && !knownSymbols.has(embedded)) unknownSymbols.add(embedded);
    }
  }
  if (unknownSymbols.size > 0) {
    throw new Error(`REJECTED: unknown symbols: ${[...unknownSymbols].join(', ')}`);
  }
}

function assertRejects(actions: TestAction[], dc: RollingContextExt, label: string) {
  let threw = false;
  try { validateDirectorSymbols(actions, dc); } catch { threw = true; }
  assert.ok(threw, `${label}: expected rejection but did not throw`);
}

function assertAccepts(actions: TestAction[], dc: RollingContextExt, label: string) {
  try { validateDirectorSymbols(actions, dc); } catch (e) {
    assert.fail(`${label}: expected acceptance but threw: ${(e as Error).message}`);
  }
}

const CTX_WITH_VENUES: RollingContextExt = {
  context_version: 'abc123',
  live_venue_per_symbol: { 'BTC-USD': 'coinbase-live', 'ETH-USD': 'coinbase-live', 'XRP-USD': 'coinbase-live', 'SPY': 'alpaca-paper' },
  broker_capabilities: {
    'coinbase-live': ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD'],
    'alpaca-paper': ['SPY', 'QQQ', 'NVDA', 'AAPL'],
    'oanda-rest': ['EUR_USD', 'GBP_USD'],
  },
  alpaca_has_activity: true,
};

const CTX_NO_ALPACA_ACTIVITY: RollingContextExt = {
  context_version: 'def456',
  live_venue_per_symbol: { 'BTC-USD': 'coinbase-live', 'ETH-USD': 'coinbase-live' },
  broker_capabilities: {
    'coinbase-live': ['BTC-USD', 'ETH-USD'],
    'alpaca-paper': ['SPY', 'QQQ'], // should NOT be used when alpaca_has_activity=false
  },
  alpaca_has_activity: false,
};

const CTX_NO_SYMBOL_DATA: RollingContextExt = { context_version: undefined, live_venue_per_symbol: undefined, broker_capabilities: undefined, alpaca_has_activity: undefined };

test('defensive parser: accepts known symbols from force-close-symbol', () => {
  assertAccepts([{ type: 'force-close-symbol', symbol: 'BTC-USD', reason: 'test' }], CTX_WITH_VENUES,
    'force-close-symbol with known symbol');
});

test('defensive parser: rejects force-close-symbol for symbol not in context', () => {
  assertRejects([{ type: 'force-close-symbol', symbol: 'XRP-USD', reason: 'test' }], CTX_NO_ALPACA_ACTIVITY,
    'XRP-USD is NOT in CTX_NO_ALPACA_ACTIVITY (only BTC-USD, ETH-USD known)');
});

test('defensive parser: rejects unknown symbols regardless of broker_capabilities listing', () => {
  // XRP-USD is in coinbase-live but NOT in CTX_NO_ALPACA_ACTIVITY — reject.
  assertRejects([{ type: 'force-close-symbol', symbol: 'XRP-USD', reason: 'test' }], CTX_NO_ALPACA_ACTIVITY,
    'XRP-USD absent from context must be rejected');
});

test('defensive parser: extracts embedded symbol from strategy name (grid-XRP-USD pattern)', () => {
  // "grid-xrp-usd" contains embedded symbol XRP-USD
  assertRejects([{ type: 'pause-strategy', strategy: 'grid-xrp-usd', reason: 'test' }], CTX_NO_ALPACA_ACTIVITY,
    'embedded XRP-USD from grid-xrp-usd must be rejected when XRP-USD not in context');
});

test('defensive parser: accepts strategy with embedded symbol present in context', () => {
  // BTC-USD IS in CTX_NO_ALPACA_ACTIVITY
  assertAccepts([{ type: 'pause-strategy', strategy: 'grid-btc-usd', reason: 'test' }], CTX_NO_ALPACA_ACTIVITY,
    'embedded BTC-USD from grid-btc-usd should be accepted');
});

test('defensive parser: skips validation when context has no symbol data (conservative)', () => {
  // No error even though DOGE-USD is definitely not a known symbol
  assertAccepts([{ type: 'force-close-symbol', symbol: 'DOGE-USD', reason: 'test' }], CTX_NO_SYMBOL_DATA,
    'no symbol data in context = conservative acceptance');
});

test('defensive parser: accepts noop action (no symbols referenced)', () => {
  assertAccepts([{ type: 'noop' }], CTX_WITH_VENUES, 'noop is always accepted');
});

test('defensive parser: accepts halt action (no symbols referenced)', () => {
  assertAccepts([{ type: 'halt', reason: 'emergency' }], CTX_WITH_VENUES, 'halt is always accepted');
});

test('defensive parser: multi-action with one unknown symbol is rejected', () => {
  const actions = [
    { type: 'note', text: 'ok' },
    { type: 'force-close-symbol', symbol: 'XRP-USD', reason: 'test' }, // XRP-USD not in CTX_NO_ALPACA_ACTIVITY
  ];
  assertRejects(actions, CTX_NO_ALPACA_ACTIVITY, 'one unknown symbol in multi-action = reject');
});

test('defensive parser: multi-action all known is accepted', () => {
  const actions = [
    { type: 'pause-strategy', strategy: 'grid-btc-usd', reason: 'losing' },
    { type: 'note', text: 'ok' },
  ];
  assertAccepts(actions, CTX_NO_ALPACA_ACTIVITY, 'all symbols known = accept');
});

test('defensive parser: alpaca_has_activity=false is noted in context but broker_capabilities still grant symbols (a)', () => {
  // alpaca_has_activity=false only affects the system-prompt text; the defensive parser
  // validates symbols against knownSymbols (venue map + broker_capabilities combined).
  // SPY is listed in alpaca-paper broker_capabilities, so it IS accepted.
  assertAccepts([{ type: 'force-close-symbol', symbol: 'SPY', reason: 'test' }], CTX_NO_ALPACA_ACTIVITY,
    'SPY is in alpaca-paper broker_capabilities so accepted regardless of alpaca_has_activity');
});

test('defensive parser: context_version is present when available (c)', () => {
  const ctx = extractDirectorContext({ context_version: 'v1.2.3', unknown_field: 'ignored' });
  assert.equal(ctx.context_version, 'v1.2.3', 'context_version should be extracted');
  assert.equal(ctx.alpaca_has_activity, undefined, 'unknown fields should not appear');
});

test('defensive parser: extractDirectorContext is backward-compatible with empty/null/undefined context', () => {
  const empty = { context_version: undefined, live_venue_per_symbol: undefined, broker_capabilities: undefined, alpaca_has_activity: undefined };
  assert.deepEqual(extractDirectorContext(null), empty);
  assert.deepEqual(extractDirectorContext(undefined), empty);
  assert.deepEqual(extractDirectorContext('not an object'), empty);
  assert.deepEqual(extractDirectorContext(42), empty);
});
