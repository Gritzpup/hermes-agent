"""
FinRL-X Gymnasium environment.

State space (5 dims):
  price        — normalised mid price
  book_imb     — order-book imbalance [-1, 1]
  position     — current position units (can be negative = short)
  cash         — normalised cash balance
  time_step    — normalised episode step

Action space (5 discrete):
  0 = hold
  1 = market_buy
  2 = market_sell
  3 = limit_post
  4 = cancel

Reward = realised PnL - maker_fee_bps - slippage_bps
"""

from __future__ import annotations

import numpy as np
import gymnasium as gym
from gymnasium import spaces


class GridMicroTimingEnv(gym.Env):
    """Micro-timing env for grid strategy entry/exit decisions."""

    metadata = {"render_modes": []}

    MAKER_FEE_BPS = 6     # 6 bps Coinbase maker
    TAKER_FEE_BPS = 60    # 60 bps Coinbase taker
    SLIPPAGE_BPS = 3      # assumed market slippage

    def __init__(
        self,
        price_series: np.ndarray | None = None,
        book_imb_series: np.ndarray | None = None,
        n_steps: int = 200,
    ):
        super().__init__()
        self.n_steps = n_steps
        self._price_series = price_series
        self._book_imb_series = book_imb_series

        # Observation: (price, book_imb, position, cash_norm, time_norm)
        self.observation_space = spaces.Box(
            low=-5.0, high=5.0, shape=(5,), dtype=np.float32
        )
        # Discrete: hold / market_buy / market_sell / limit_post / cancel
        self.action_space = spaces.Discrete(5)

        self._seed = None
        self._rng: np.random.Generator | None = None

    # ── Helpers ────────────────────────────────────────────────────────────────

    def _generate_synthetic(self, idx: int) -> tuple[float, float]:
        """Return (price, book_imb) for synthetic run."""
        t = idx / max(self.n_steps - 1, 1)
        price = 100.0 + 5.0 * np.sin(2 * np.pi * t) + 0.5 * np.random.randn()
        book_imb = np.clip(np.sin(4 * np.pi * t) + 0.2 * np.random.randn(), -1, 1)
        return float(price), float(book_imb)

    def _obs(self) -> np.ndarray:
        assert self._current_price is not None
        price_norm = (self._current_price - 100.0) / 10.0
        time_norm = self._step / max(self.n_steps - 1, 1)
        cash_norm = self._cash / 10000.0
        return np.array(
            [price_norm, self._book_imb, self._position, cash_norm, time_norm],
            dtype=np.float32,
        )

    def _reward(self, action: int) -> float:
        """PnL for the step just taken (comparing prev/cur price)."""
        if self._prev_price is None:
            return 0.0
        price_delta = self._current_price - self._prev_price

        if action == 0:  # hold
            reward = 0.0
        elif action == 1:  # market_buy
            reward = price_delta - self.TAKER_FEE_BPS * 1e-4 * self._current_price
        elif action == 2:  # market_sell
            reward = -price_delta - self.TAKER_FEE_BPS * 1e-4 * self._current_price
        elif action == 3:  # limit_post (passive; earn fee if price moves toward us)
            reward = self.MAKER_FEE_BPS * 1e-4 * self._current_price
        else:  # action == 4 cancel
            reward = 0.0

        # Apply position-driven PnL
        if self._position != 0:
            reward += self._position * price_delta

        return reward

    # ── gymnasium API ─────────────────────────────────────────────────────────

    def reset(self, seed=None, options=None):
        super().reset(seed=seed)
        if seed is not None:
            self._rng = np.random.default_rng(seed)
        elif self._rng is None:
            self._rng = np.random.default_rng(0)

        self._step = 0
        self._position = 0.0
        self._cash = 10000.0
        self._prev_price = None
        self._current_price, self._book_imb = self._generate_synthetic(0)
        return self._obs(), {}

    def step(self, action: int):
        self._prev_price = self._current_price
        self._step += 1

        # Execute action
        if action == 1 and self._cash >= self._current_price:
            self._position += 1
            self._cash -= self._current_price
        elif action == 2 and self._position > 0:
            self._position -= 1
            self._cash += self._current_price
        elif action == 3 and self._cash >= self._current_price:
            # Passive post — add to position at current price (maker fee credit)
            self._position += 0.5
            self._cash -= self._current_price * 0.5

        # Advance price
        if self._price_series is not None and self._step < len(self._price_series):
            self._current_price = float(self._price_series[self._step])
            self._book_imb = (
                float(self._book_imb_series[self._step])
                if self._book_imb_series is not None
                else 0.0
            )
        else:
            self._current_price, self._book_imb = self._generate_synthetic(self._step)

        reward = self._reward(action)
        obs = self._obs()
        terminated = self._step >= self.n_steps
        truncated = False
        return obs, reward, terminated, truncated, {}

    def close(self):
        pass
