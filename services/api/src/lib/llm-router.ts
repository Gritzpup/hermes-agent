export type TaskClass = "menial" | "financial-narrow" | "financial-reasoning" | "strategic" | "code";

// Bonsai standalone (llama-server on 8081) — fastest, zero-cost
const BONSAI_BASE_URL = process.env.OLLAMA_1B_URL ?? "http://192.168.1.8:8081";
const BONSAI_MODEL = "Bonsai-1.7B-Q1.gguf";

// Ollama defaults (192.168.1.8:11434)
const OLLAMA_BASE = process.env.OLLAMA_BASE_URL ?? "http://192.168.1.8:11434/v1";

export function pickModel(task: TaskClass): { baseUrl: string; model: string; timeoutMs: number } {
  switch (task) {
    // Bonsai 1.7B standalone on port 8081 — ~100 TPS, best for rapid triage
    case "menial":
      return { baseUrl: BONSAI_BASE_URL, model: BONSAI_MODEL, timeoutMs: 10_000 };
    // phi3.5 — 94 TPS, strong at structured financial output
    case "financial-narrow":
      return { baseUrl: OLLAMA_BASE, model: process.env.OLLAMA_FAST_MODEL ?? "phi3.5:latest", timeoutMs: 15_000 };
    // hermes3:8b — finance-specialized, moderate speed
    case "financial-reasoning":
      return { baseUrl: OLLAMA_BASE, model: "hermes3:8b", timeoutMs: 20_000 };
    // qwen3.5 9B — best reasoning model available locally
    case "strategic":
      return { baseUrl: OLLAMA_BASE, model: process.env.OLLAMA2_MODEL ?? "qwen3.5:9b-q4_k_m", timeoutMs: 60_000 };
    // codeqwen — specialized for code
    case "code":
      return { baseUrl: OLLAMA_BASE, model: "codeqwen:latest", timeoutMs: 45_000 };
  }
}
