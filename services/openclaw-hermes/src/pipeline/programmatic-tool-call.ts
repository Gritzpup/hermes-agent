/**
 * Programmatic Tool Calling Adapter
 * services/openclaw-hermes/src/pipeline/programmatic-tool-call.ts
 *
 * Lets Kimi/Opus emit JS code that calls multiple tools and returns processed output.
 * Anthropic 2026 pattern: model emits code → sandbox executes → returns JSON-serializable result.
 *
 * Sandbox:
 *   - Only `tools` namespace is exposed — no fs, no net, no process
 *   - Uses Node's built-in `vm` module for isolation
 *   - Strict allowlist: only tool names in ALLOWED_TOOLS are callable
 *   - Deny patterns: require, import, eval, Function, process, global, __proto__, constructor
 *   - 30s execution timeout
 *   - If model returns plain JSON or text (not code), falls back to null (no-op)
 *
 * The `tools` object passed in is a map of toolName → async function(ctx, args) → result.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ToolCallContext {
  tickId: string;
  tickAt: string;
  [key: string]: unknown;
}

export type ToolFn = (ctx: ToolCallContext, args: Record<string, unknown>) => Promise<unknown>;

export type ToolMap = Record<string, ToolFn>;

interface ProgrammaticResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  durationMs: number;
  wasCode: boolean;
}

// ── Allowlist ─────────────────────────────────────────────────────────────────

const ALLOWED_TOOLS = new Set([
  'read_positions',
  'read_pnl',
  'read_journal_window',
  'propose_allocation',
  'halt_symbol',
  'query_news_sentiment',
  'query_fundamentals',
  'submit_order',
  'get_compliance_status',
  'query_onchain_signal',
]);

// ── Deny patterns (checked before execution) ────────────────────────────────────

const DENY_PATTERNS = [
  /\brequire\s*\(/,
  /\bimport\s*\(/,
  /\bimport\s+\{/,
  /\bimport\s+\*/,
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\bprocess\b/,
  /\bglobal\b/,
  /\b__proto__\b/,
  /\bconstructor\b/,
  /\.constructor\s*\(/,
  /\bgetPrototypeOf\b/,
  /\bsetPrototypeOf\b/,
  /\bproxy\b/,
  /\bwrap\b/,
  /\bVM\b/,
];

function containsDenyPattern(code: string): string | null {
  for (const pat of DENY_PATTERNS) {
    if (pat.test(code)) {
      return `deny pattern matched: ${pat}`;
    }
  }
  return null;
}

// ── Sandbox execution ──────────────────────────────────────────────────────────

const SANDBOX_TIMEOUT_MS = 30_000;

/**
 * Execute `code` in an isolated Node vm context.
 * `tools` is bound to the sandbox's global scope.
 */
function runInSandbox(code: string, tools: ToolMap, ctx: ToolCallContext): unknown {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vm = require('node:vm');

  // Build a tool proxy that resolves tool names against ALLOWED_TOOLS
  const sandboxTools: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(tools)) {
    if (ALLOWED_TOOLS.has(name)) {
      sandboxTools[name] = async (args: Record<string, unknown>) => {
        return fn(ctx, args);
      };
    }
  }

  const sandbox = {
    tools: sandboxTools,
    console: {
      log: () => {},
      warn: () => {},
      error: () => {},
    },
    // Expose Promise so top-level await works
    Promise,
    // Prevent access to the host context
    global: undefined,
    process: undefined,
    Buffer: undefined,
  };

  const script = new vm.Script(code, { filename: 'programmatic-tool-call.mjs' });

  const context = vm.createContext(sandbox, {
    name: 'programmatic-tool-call',
    codeGeneration: { strings: false, wasm: false },
  });

  const result = script.runInContext(context, {
    timeout: SANDBOX_TIMEOUT_MS,
    breakOnSigint: false,
  });

  // Handle both sync return values and Promise return values
  if (result && typeof result === 'object' && 'then' in result) {
    // It's a Promise — we need to synchronously return the promise
    // The caller handles the Promise
    return result as Promise<unknown>;
  }

  return result;
}

// ── Detect if string is code or plain JSON/text ────────────────────────────────

function isCodeString(s: string): boolean {
  // Treat as code if it contains: function, async, await, const, let, var, =>,
  // tool calls (tools.read_positions), or typical JS syntax
  const codeIndicators = [
    /\bfunction\b/,
    /\basync\b/,
    /\bawait\b/,
    /\bconst\s+\w+\s*=/,
    /\blet\s+\w+\s*=/,
    /\bvar\s+\w+\s*=/,
    /=>\s*[{(]/,
    /\.then\s*\(/,
    /tools\.\w+\s*\(/,
    /\breturn\b/,
  ];
  return codeIndicators.some((p) => p.test(s));
}

// ── Main adapter ─────────────────────────────────────────────────────────────

export class ProgrammaticToolCall {
  private tools: ToolMap;
  private ctx: ToolCallContext;

  constructor(tools: ToolMap, ctx: ToolCallContext) {
    this.tools = tools;
    this.ctx = ctx;
  }

  /**
   * Execute code string from the model.
   *
   * Returns:
   *   - { ok: true, result, wasCode: true }  if code was detected and executed
   *   - { ok: true, result: null, wasCode: false } if not code (plain JSON/text)
   *   - { ok: false, error, wasCode: true } if sandbox rejected or execution failed
   *
   * Timeout: 30s. On timeout, returns { ok: false, error: 'TIMEOUT' }
   */
  async execute(code: string): Promise<ProgrammaticResult> {
    const start = Date.now();

    if (!code || !code.trim()) {
      return { ok: true, result: null, wasCode: false, durationMs: Date.now() - start };
    }

    const trimmed = code.trim();

    // Step 1: Check if this is actually code or just text/JSON
    if (!isCodeString(trimmed)) {
      return { ok: true, result: null, wasCode: false, durationMs: Date.now() - start };
    }

    // Step 2: Deny pattern check
    const denyReason = containsDenyPattern(trimmed);
    if (denyReason) {
      return {
        ok: false,
        error: `sandbox: denied — ${denyReason}`,
        wasCode: true,
        durationMs: Date.now() - start,
      };
    }

    // Step 3: Execute in sandbox with timeout
    try {
      const result = await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error('TIMEOUT'));
        }, SANDBOX_TIMEOUT_MS);

        try {
          const value = runInSandbox(trimmed, this.tools, this.ctx);
          if (value && typeof value === 'object' && 'then' in value) {
            // It's a Promise — chain it
            (value as Promise<unknown>)
              .then((v) => { clearTimeout(timer); resolve(v); })
              .catch((e) => { clearTimeout(timer); reject(e); });
          } else {
            clearTimeout(timer);
            resolve(value);
          }
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });

      // Ensure result is JSON-serializable (strip non-serializable fields)
      const serializable = JSON.parse(JSON.stringify(result));
      return {
        ok: true,
        result: serializable,
        wasCode: true,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const errStr = String(err);
      return {
        ok: false,
        error: errStr === 'TIMEOUT' ? 'sandbox timeout (30s exceeded)' : `sandbox error: ${errStr}`,
        wasCode: true,
        durationMs: Date.now() - start,
      };
    }
  }
}

// ── Convenience factory ───────────────────────────────────────────────────────

export function createProgrammaticToolCall(
  tools: ToolMap,
  ctx: ToolCallContext,
): ProgrammaticToolCall {
  return new ProgrammaticToolCall(tools, ctx);
}
