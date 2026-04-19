export function pickModel(task) {
    const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://192.168.1.8:11434/v1";
    switch (task) {
        case "menial": return { baseUrl, model: process.env.OLLAMA_FAST_MODEL ?? "gemma2:2b", timeoutMs: 10_000 };
        case "financial-narrow": return { baseUrl, model: "hermes3:8b", timeoutMs: 15_000 };
        case "financial-reasoning": return { baseUrl, model: "hermes3:8b", timeoutMs: 20_000 };
        case "strategic": return { baseUrl, model: process.env.OLLAMA2_MODEL ?? "qwen3.5:9b-q4_k_m", timeoutMs: 60_000 };
        case "code": return { baseUrl, model: "huihui_ai/qwen2.5-coder-abliterate:7b-instruct", timeoutMs: 45_000 };
    }
}
