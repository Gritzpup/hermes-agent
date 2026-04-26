"""Pytest suite for finrl_x.news_risk"""

import pytest
from unittest.mock import patch, MagicMock
from finrl_x.news_risk import (
    assess_news_risk,
    risk_multiplier_for_symbol,
    _parse_classification,
    RiskAssessment,
)


class TestParseClassification:
    def test_parses_safe(self):
        text = '{"classification": "safe", "reason": "no news"}'
        result = _parse_classification(text)
        assert result.classification == "safe"
        assert result.risk_multiplier == 1.0

    def test_parses_caution(self):
        text = '{"classification": "caution", "reason": "mixed signals"}'
        result = _parse_classification(text)
        assert result.classification == "caution"
        assert result.risk_multiplier == 0.5

    def test_parses_halt(self):
        text = '{"classification": "halt", "reason": "major risk event"}'
        result = _parse_classification(text)
        assert result.classification == "halt"
        assert result.risk_multiplier == 0.0

    def test_keyword_fallback_halt(self):
        text = "Based on my analysis: HALT recommended"
        result = _parse_classification(text)
        assert result.classification == "halt"
        assert result.risk_multiplier == 0.0

    def test_keyword_fallback_caution(self):
        text = "System flags CAUTION due to volatility"
        result = _parse_classification(text)
        assert result.classification == "caution"
        assert result.risk_multiplier == 0.5

    def test_invalid_json_defaults_to_safe(self):
        result = _parse_classification("模型输出异常")
        assert result.classification == "safe"
        assert result.risk_multiplier == 1.0


class TestRiskMultiplier:
    def test_empty_headlines_returns_safe(self):
        mult = risk_multiplier_for_symbol("BTC-USD", [])
        assert mult == 1.0

    def test_none_headlines_returns_safe(self):
        mult = risk_multiplier_for_symbol("BTC-USD", None)
        assert mult == 1.0


class TestAssessNewsRisk:
    @patch("finrl_x.news_risk._classify_via_ollama")
    def test_calls_ollama(self, mock_call):
        mock_call.return_value = RiskAssessment(
            classification="safe",
            risk_multiplier=1.0,
            raw_response='{"classification": "safe"}',
        )
        headlines = ["BTC surges 5%", "No regulatory issues"]
        result = assess_news_risk(headlines, "BTC-USD")
        mock_call.assert_called_once()
        assert result.classification == "safe"

    @patch("finrl_x.news_risk._classify_via_ollama")
    def test_ollama_error_falls_back_to_safe(self, mock_call):
        mock_call.return_value = RiskAssessment(
            classification="safe",
            risk_multiplier=1.0,
            raw_response="",
            error="connection refused",
        )
        headlines = ["Some news"]
        result = assess_news_risk(headlines, "ETH-USD")
        assert result.classification == "safe"
        assert result.risk_multiplier == 1.0

    @patch("finrl_x.news_risk._classify_via_ollama")
    def test_cache_hit_skips_call(self, mock_call):
        mock_call.return_value = RiskAssessment(
            classification="caution",
            risk_multiplier=0.5,
            raw_response='{"classification": "caution"}',
        )
        headlines = ["Headline A", "Headline B"]
        # First call
        r1 = assess_news_risk(headlines, "SOL-USD")
        # Second identical call (should hit cache)
        r2 = assess_news_risk(headlines, "SOL-USD")
        # Only one call should have been made
        assert mock_call.call_count == 1
        assert r1.risk_multiplier == r2.risk_multiplier
