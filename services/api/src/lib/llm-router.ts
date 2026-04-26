export type TaskClass = "menial" | "financial-narrow" | "financial-reasoning" | "strategic" | "code";

// All local Ollama at 192.168.1.8:11434 — no external calls, no API keys needed.
const OLLAMA_BASE = "http://192.168.1.8:11434/v1";

/**
 * Model assignment rationale (based on Ollama model inventory):
 *
 *  phi3.5:latest        (~94 TPS) — menial, financial-narrow
 *    Fastest tool-calling model. Great for rapid triage, simple structured output.
 *
 *  hermes3:8b          (specialized finance) — financial-reasoning
 *    Finance-fine-tuned. Good for analytical P&L reasoning.
 *
 *  huihui_ai/qwen2.5-coder-abliterate:7b-instruct — code
 *    Code-specialized. Abliterated = no refusal, stronger at code generation.
 *
 *  qwen3.5:9b-q4_k_m   (Q4 quant) — strategic
 *    Best reasoning model locally. Q4 keeps it fast while preserving quality.
 *
 * Bonsai standalone (port 8081, llama-server) is NOT used — it only supports
 * /completion (raw text), not /v1/chat/completions. Use Ollama for everything.
 */
export function pickModel(task: TaskClass): { baseUrl: string; model: string; timeoutMs: number } {
  switch (task) {
    case "menial":
      // Fastest local model — simple triage, ticker parse, gate checks
      return { baseUrl: OLLAMA_BASE, model: "phi3.5:latest", timeoutMs: 10_000 };

    case "financial-narrow":
      // phi3.5 for structured financial output (position sizing, signal parse)
      return { baseUrl: OLLAMA_BASE, model: "phi3.5:latest", timeoutMs: 15_000 };

    case "financial-reasoning":
      // Finance-specialized model for P&L reasoning and attribution
      return { baseUrl: OLLAMA_BASE, model: "hermes3:8b", timeoutMs: 20_000 };

    case "code":
      // Code-specialized, abliterated — no refusals on code tasks
      return { baseUrl: OLLAMA_BASE, model: "huihui_ai/qwen2.5-coder-abliterate:7b-instruct", timeoutMs: 45_000 };

    case "strategic":
      // Best reasoning model available locally
      return { baseUrl: OLLAMA_BASE, model: "qwen3.5:9b-q4_k_m", timeoutMs: 60_000 };
  }
}
