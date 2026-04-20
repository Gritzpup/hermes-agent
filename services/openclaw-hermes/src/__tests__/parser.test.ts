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
