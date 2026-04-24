// @ts-nocheck
/**
 * Langfuse observability integration.
 *
 * Langfuse provides LLM cost tracking, prompt versioning, and trace analytics.
 *
 * Enable by setting LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY env vars.
 * LANGFUSE_HOST defaults to http://localhost:3000.
 */

let langfuse: any = null;
let consoleHandler: any = null;
let isEnabled = false;

interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  host: string;
}

function getConfig(): LangfuseConfig | null {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) return null;
  return {
    publicKey,
    secretKey,
    host: process.env.LANGFUSE_HOST ?? 'http://localhost:3000',
  };
}

export async function initLangfuse(): Promise<void> {
  const config = getConfig();
  if (!config) {
    console.log('[langfuse] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY not set — tracing disabled');
    return;
  }
  try {
    const { Langfuse } = await import('langfuse');
    langfuse = new Langfuse({
      publicKey: config.publicKey,
      secretKey: config.secretKey,
      baseUrl: config.host,
    });
    await langfuse.authCheck();
    isEnabled = true;
    console.log(`[langfuse] Connected to ${config.host}`);
  } catch (err) {
    console.warn('[langfuse] Failed to init, tracing disabled:', err instanceof Error ? err.message : String(err));
  }
}

/**
 * Create a named trace span for an LLM call or any operation.
 */
export function createTrace(options: {
  name: string;
  metadata?: Record<string, unknown>;
  userId?: string;
}): { end: (output?: string, error?: string) => void; update: (attrs: Record<string, unknown>) => void } {
  if (!isEnabled || !langfuse) {
    return {
      end: () => {},
      update: () => {},
    };
  }

  const trace = langfuse.trace({
    name: options.name,
    metadata: options.metadata,
    userId: options.userId,
  });

  return {
    end: (output?: string, error?: string) => {
      if (error) {
        trace.update({ status: 'error', metadata: { ...options.metadata, error } });
      } else {
        trace.update({ status: 'success', metadata: { ...options.metadata, output } });
      }
    },
    update: (attrs: Record<string, unknown>) => {
      try {
        trace.update(attrs);
      } catch {}
    },
  };
}

export interface LlmCallParams {
  model: string;
  prompt: string;
  systemPrompt?: string;
  provider: string;
  tokens?: number;
  costUsd?: number;
  latencyMs?: number;
  agentId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Record an LLM call to Langfuse.
 */
export async function recordLlmCall(params: LlmCallParams): Promise<void> {
  if (!isEnabled || !langfuse) return;
  try {
    await langfuse.generation({
      name: `llm-${params.provider}`,
      model: params.model,
      prompt: params.prompt,
      systemPrompt: params.systemPrompt,
      modelParameters: { provider: params.provider },
      usage: params.tokens ? { promptTokens: Math.floor(params.tokens * 0.7), completionTokens: Math.floor(params.tokens * 0.3) } : undefined,
      generatedText: '',
      metadata: {
        ...params.metadata,
        provider: params.provider,
        agentId: params.agentId,
        sessionId: params.sessionId,
        costUsd: params.costUsd,
        latencyMs: params.latencyMs,
      },
    });
  } catch (err) {
    console.warn('[langfuse] recordLlmCall error:', err instanceof Error ? err.message : String(err));
  }
}

export function isLangfuseEnabled(): boolean {
  return isEnabled;
}
