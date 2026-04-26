"""
FinRL-X inference HTTP server.

Usage:
  python -m finrl_x.serve --policy out/policy.onnx --port 7410

Endpoints:
  POST /edge_score
    Body: {symbol, side, price, book_imb, position, cash, news_risk?}
    Response: {edge_score: float}  # ∈ [0, 1]

  GET /health
    Response: {status: "ok", model: str}
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional

import numpy as np

# Import export helpers; handle missing onnxruntime gracefully
try:
    from finrl_x.export import load_onnx_session, predict_edge_score
    _HAS_RUNTIME = True
except ImportError as _e:
    _RUNTIME_ERR = _e
    _HAS_RUNTIME = False

from finrl_x.news_risk import assess_news_risk


# ── Observation builder ───────────────────────────────────────────────────────

_PRICE_NORM = 100.0
_PRICE_SCALE = 10.0
_CASH_SCALE = 10000.0
_STEP_NORM_SCALE = 200.0  # max n_steps default


def build_obs(
    price: float,
    book_imb: float,
    position: float,
    cash: float,
    step: int = 0,
    n_steps: int = 200,
) -> np.ndarray:
    """
    Convert raw trading state into the normalised 5-dim observation vector
    used by GridMicroTimingEnv.
    """
    price_norm = (float(price) - _PRICE_NORM) / _PRICE_SCALE
    time_norm = float(step) / max(float(n_steps - 1), 1)
    cash_norm = float(cash) / _CASH_SCALE
    return np.array(
        [price_norm, float(book_imb), float(position), cash_norm, time_norm],
        dtype=np.float32,
    )


# ── HTTP server ───────────────────────────────────────────────────────────────

def _make_handler(onnx_path: Path, n_steps: int = 200):
    """Build the request handler with closed-over model session."""

    if not _HAS_RUNTIME:
        raise RuntimeError(
            f"onnxruntime not available: {_RUNTIME_ERR}. "
            "Install: pip install onnxruntime"
        )

    sess = load_onnx_session(onnx_path)

    def handle_edge_score(body: dict) -> dict:
        symbol = body.get("symbol", "BTC-USD")
        side = body.get("side", "long")  # long | short | flat
        price = float(body.get("price", 100.0))
        book_imb = float(body.get("book_imb", 0.0))
        position = float(body.get("position", 0.0))
        cash = float(body.get("cash", 10000.0))
        step = int(body.get("step", 0))
        news_risk = body.get("news_risk")  # optional risk_multiplier override

        # Apply news-risk multiplier if provided
        risk_mult = 1.0
        if news_risk is not None:
            risk_mult = float(news_risk)
        elif body.get("apply_news_risk", False):
            # Fetch risk from headlines list if available
            headlines = body.get("headlines", [])
            if headlines:
                assessment = assess_news_risk(headlines, symbol)
                risk_mult = assessment.risk_multiplier

        # Position sign based on side
        signed_position = position if side in ("long", "flat") else -position

        obs = build_obs(price, book_imb, signed_position, cash, step, n_steps)
        edge_score = predict_edge_score(sess, obs)
        # Scale by news risk
        final_score = float(edge_score * risk_mult)

        return {
            "edge_score": final_score,
            "edge_score_raw": float(edge_score),
            "risk_multiplier": risk_mult,
            "symbol": symbol,
            "side": side,
        }

    return handle_edge_score


def run_server(onnx_path: Path, port: int = 7410, n_steps: int = 200):
    """Minimal HTTP/JSON server using the stdlib."""
    import http.server
    import socketserver

    handler_fn = _make_handler(onnx_path, n_steps)

    class _Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            print(f"[finrl-x][serve] {args[0]}")

        def do_GET(self):
            if self.path == "/health":
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "ok",
                    "model": str(onnx_path),
                    "port": port,
                }).encode())
            else:
                self.send_response(404)
                self.end_headers()

        def do_POST(self):
            if self.path != "/edge_score":
                self.send_response(404)
                self.end_headers()
                return

            content_len = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(content_len)
            try:
                body = json.loads(raw.decode())
            except json.JSONDecodeError:
                self.send_response(400)
                self.end_headers()
                self.wfile.write(b'{"error": "invalid JSON"}')
                return

            try:
                result = handler_fn(body)
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())
            except Exception as exc:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(exc)}).encode())

    with socketserver.TCPServer(("0.0.0.0", port), _Handler) as httpd:
        print(f"[finrl-x][serve] Listening on http://0.0.0.0:{port}")
        print(f"[finrl-x][serve] Model: {onnx_path}")
        httpd.serve_forever()


def main():
    parser = argparse.ArgumentParser(description="FinRL-X inference server")
    parser.add_argument(
        "--policy",
        type=str,
        required=True,
        help="Path to ONNX policy file",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=7410,
        help="HTTP port (default 7410)",
    )
    parser.add_argument(
        "--n-steps",
        type=int,
        default=200,
        help="Max episode steps for normalisation (default 200)",
    )
    args = parser.parse_args()

    onnx_path = Path(args.policy)
    if not onnx_path.exists():
        print(f"[finrl-x][serve] ERROR: policy file not found: {onnx_path}")
        sys.exit(1)

    run_server(onnx_path, args.port, args.n_steps)


if __name__ == "__main__":
    main()
