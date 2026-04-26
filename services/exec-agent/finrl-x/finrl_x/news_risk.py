"""
FinGPT v3 LLM news-risk overlay (finance-tuned classifier).

Takes recent news headlines for a symbol, calls a remote Ollama instance with
martain7r/finance-llama-8b:q4_k_m (finance-domain fine-tune, fits in 8GB VRAM)
to classify the risk level into {safe, caution, halt}, and returns a
risk_multiplier in [0, 1] that scales the policy's exploration temperature.

risk_multiplier:
  safe   -> 1.0  (full exploration)
  caution-> 0.5  (reduced exploration — stay close to rule-based)
  halt   -> 0.0  (no grid expansion, prefer exits)
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass
from typing import Optional

import requests

OLLAMA_BASE = os.environ.get(
    "OLLAMA_BASE", "http://127.0.0.1:11434"
)
OLLAMA_MODEL = os.environ.get(
    "OLLAMA_MODEL", "martain7r/finance-llama-8b:q4_k_m"
)
OLLAMA_TIMEOUT_S = float(os.environ.get("OLLAMA_TIMEOUT_S", "10"))


@dataclass
class RiskAssessment:
    classification: str       # "safe" | "caution" | "halt"
    risk_multiplier: float    # 0.0 – 1.0
    raw_response: str
    error: Optional[str] = None


SYSTEM_PROMPT = (
    "You are a financial risk analyst. Given a list of news headlines for a "
    "trading symbol, classify the short-term market risk level as exactly one of:\n"
    '  safe     — no significant adverse news; normal trading conditions\n'
    '  caution  — elevated uncertainty or mixed signals; reduce grid expansion\n'
    '  halt     — major adverse news, regulatory risk, or extreme volatility; '
    "prefer exits over entries\n\n"
    "Respond with a single JSON object: {\"classification\": \"safe|caution|halt\", "
    "\"reason\": \"short explanation\"}"
)


def _classify_via_ollama(headlines: list[str], symbol: str) -> RiskAssessment:
    """
    Call Ollama /api/generate and parse the classification.
    Falls back to 'safe' on any error.
    """
    user_prompt = f"Symbol: {symbol}\nHeadlines:\n" + "\n".join(
        f"  - {h}" for h in headlines
    )

    payload = {
        "model": OLLAMA_MODEL,
        "prompt": user_prompt,
        "system": SYSTEM_PROMPT,
        "stream": False,
        "options": {"temperature": 0.1, "num_predict": 128},
    }

    try:
        resp = requests.post(
            f"{OLLAMA_BASE}/api/generate",
            json=payload,
            timeout=OLLAMA_TIMEOUT_S,
        )
        resp.raise_for_status()
        raw = resp.json()
        text = raw.get("response", "").strip()
        return _parse_classification(text)
    except Exception as exc:
        return RiskAssessment(
            classification="safe",
            risk_multiplier=1.0,
            raw_response="",
            error=str(exc),
        )


def _parse_classification(text: str) -> RiskAssessment:
    """Extract JSON {classification, reason} from LLM response."""
    import json as _json

    text = text.strip()
    # Try direct JSON parse
    try:
        obj = _json.loads(text)
        cls = obj.get("classification", "safe").lower()
        multiplier = _MULTIPLIER_MAP.get(cls, 1.0)
        return RiskAssessment(cls, multiplier, text)
    except _json.JSONDecodeError:
        pass

    # Fallback: keyword scan
    lower = text.lower()
    if "halt" in lower:
        return RiskAssessment("halt", 0.0, text)
    elif "caution" in lower:
        return RiskAssessment("caution", 0.5, text)
    return RiskAssessment("safe", 1.0, text)


_MULTIPLIER_MAP = {"safe": 1.0, "caution": 0.5, "halt": 0.0}


# ── Public API ────────────────────────────────────────────────────────────────

def assess_news_risk(
    headlines: list[str],
    symbol: str,
    *,
    cache_ttl_s: float = 60.0,
) -> RiskAssessment:
    """
    Top-level news-risk assessment with a simple in-process cache.

    Returns a RiskAssessment with risk_multiplier ∈ [0, 1].
    """
    # Simple TTL cache keyed on (symbol, frozenset of headlines)
    cache_key = (symbol, frozenset(headlines))
    now = time.monotonic()

    if hasattr(assess_news_risk, "_cache"):
        cached = assess_news_risk._cache.get(cache_key)
        if cached and (now - cached[1]) < cache_ttl_s:
            return cached[0]
    else:
        assess_news_risk._cache = {}

    result = _classify_via_ollama(headlines, symbol)
    assess_news_risk._cache[cache_key] = (result, now)
    return result


def risk_multiplier_for_symbol(
    symbol: str,
    headlines: list[str] | None = None,
) -> float:
    """
    Convenience wrapper: returns the float risk_multiplier.
    Pass an empty list if no news is available (returns safe=1.0).
    """
    if not headlines:
        return 1.0
    return assess_news_risk(headlines, symbol).risk_multiplier
