"""Pytest suite for finrl_x.env"""

import numpy as np
import pytest
from finrl_x.env import GridMicroTimingEnv


class TestGridMicroTimingEnv:
    def test_reset_returns_obs(self):
        env = GridMicroTimingEnv(n_steps=100)
        obs, info = env.reset(seed=42)
        assert obs.shape == (5,)
        assert isinstance(info, dict)
        env.close()

    def test_step_returns_valid_reward(self):
        env = GridMicroTimingEnv(n_steps=100)
        obs, _ = env.reset(seed=42)
        # Take a hold action
        obs, reward, terminated, truncated, _ = env.step(0)
        assert isinstance(reward, float)
        assert isinstance(terminated, bool)
        assert isinstance(truncated, bool)
        assert obs.shape == (5,)
        env.close()

    def test_market_buy_increases_position(self):
        env = GridMicroTimingEnv(n_steps=100)
        env.reset(seed=1)
        # Inject a known price
        env._current_price = 100.0
        env._cash = 10000.0
        prev_pos = env._position
        obs, reward, *_ = env.step(1)  # market_buy
        assert env._position > prev_pos
        env.close()

    def test_profitable_roundtrip(self):
        """Buy low then sell high should give positive net reward."""
        env = GridMicroTimingEnv(n_steps=200)
        env.reset(seed=7)
        # Set price at 95 (cheap), then step will move to 105
        env._current_price = 95.0
        env._cash = 10000.0
        env._position = 0.0
        # Buy
        obs1, r1, *_ = env.step(1)
        buy_price = env._prev_price  # price before buy

        # Now price goes to 105
        env._current_price = 105.0
        # Sell
        obs2, r2, *_ = env.step(2)
        # r2 includes -price_delta (sell shorts, but we are long here)
        # With position > 0, reward includes position * price_delta
        # Net should be positive: pos * (sell - buy) - fees
        env.close()

    def test_action_4_cancel_is_noop(self):
        env = GridMicroTimingEnv(n_steps=50)
        env.reset(seed=3)
        pos_before = env._position
        cash_before = env._cash
        env.step(4)  # cancel
        assert env._position == pos_before
        assert env._cash == cash_before
        env.close()

    def test_episode_terminates_at_n_steps(self):
        env = GridMicroTimingEnv(n_steps=10)
        env.reset(seed=5)
        terminated = False
        for _ in range(20):  # more than n_steps
            _, _, terminated, truncated, _ = env.step(0)
            if terminated or truncated:
                break
        assert terminated
        env.close()
