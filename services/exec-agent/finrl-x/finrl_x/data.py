"""
Data loader for FinRL-X.

Loads:
  1. Journal entries from paper-ledger journal.jsonl
  2. L2 book snapshots (stubbed with OBI proxy if unavailable)

Produces a DataFrame with columns: timestamp, price, book_imb, position, cash.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

JOURNAL_PATH = os.environ.get(
    "HERMES_JOURNAL_PATH",
    str(
        Path(__file__).parent.parent.parent
        / "services/api/.runtime/paper-ledger/journal.jsonl"
    ),
)


def load_journal(n_rows: Optional[int] = None) -> pd.DataFrame:
    """
    Load journal.jsonl into a DataFrame.
    Each line: {ts, symbol, side, price, qty, realized_pnl, ...}
    """
    if not Path(JOURNAL_PATH).exists():
        return _synthetic_data(n_rows or 200)

    rows = []
    with open(JOURNAL_PATH) as f:
        for i, line in enumerate(f):
            if n_rows and i >= n_rows:
                break
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    if not rows:
        return _synthetic_data(n_rows or 200)

    df = pd.DataFrame(rows)
    if "ts" in df.columns:
        df["timestamp"] = pd.to_datetime(df["ts"], errors="coerce")
    elif "timestamp" in df.columns:
        df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    else:
        df["timestamp"] = pd.date_range("2024-01-01", periods=len(df), freq="T")

    df["price"] = pd.to_numeric(df.get("price", 100.0), errors="coerce").fillna(100.0)
    df["realized_pnl"] = pd.to_numeric(df.get("realized_pnl", 0.0), errors="coerce").fillna(0.0)
    return df[["timestamp", "price", "realized_pnl"]]


def compute_obi_proxy(price_series: pd.Series, window: int = 10) -> pd.Series:
    """
    Order-book imbalance proxy from price:
    Uses mid-price reversion rate as OBI signal.
    Returns values in [-1, 1].
    """
    returns = price_series.pct_change().fillna(0)
    roll = returns.rolling(window, min_periods=1).mean()
    obi = roll.clip(-1, 1)
    return obi


def load_episode_data(n_rows: Optional[int] = None) -> tuple[np.ndarray, np.ndarray]:
    """
    Returns (price_series, book_imb_series) as float32 arrays.
    Falls back to synthetic if journal unavailable.
    """
    df = load_journal(n_rows=n_rows)
    if len(df) < 2:
        df = _synthetic_data(n_rows or 200)

    price_arr = df["price"].values.astype(np.float32)
    obi_arr = compute_obi_proxy(df["price"]).values.astype(np.float32)
    return price_arr, obi_arr


def _synthetic_data(n: int = 200) -> pd.DataFrame:
    """Generate n synthetic price steps for smoke-test."""
    rng = np.random.default_rng(42)
    t = np.linspace(0, 4 * np.pi, n)
    prices = 100.0 + 5.0 * np.sin(t) + 0.3 * rng.standard_normal(n)
    return pd.DataFrame(
        {
            "timestamp": pd.date_range("2024-01-01", periods=n, freq="T"),
            "price": prices,
            "realized_pnl": 0.0,
        }
    )
