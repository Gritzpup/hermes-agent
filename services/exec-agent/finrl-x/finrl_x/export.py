"""
Export a trained stable-baselines3 policy to ONNX format.

Produces a deterministic ONNX graph suitable for onnxruntime inference in
finrl_x.serve.
"""

from __future__ import annotations

from pathlib import Path
from typing import Union

import numpy as np
import torch
from stable_baselines3 import PPO, SAC
from stable_baselines3.common.policies import BasePolicy


def _dummy_obs(shape: tuple[int, ...]) -> torch.Tensor:
    """Return a zero-initialized tensor matching the obs space shape."""
    return torch.zeros(shape, dtype=torch.float32)


class _ActorForward(torch.nn.Module):
    """
    Composes features_extractor + mlp_extractor.policy_net + action_net
    into a single module for ONNX export.
    """

    def __init__(self, policy: BasePolicy):
        super().__init__()
        self.features_extractor = policy.features_extractor
        self.mlp_extractor = policy.mlp_extractor
        self.action_net = policy.action_net

    def forward(self, obs: torch.Tensor) -> torch.Tensor:
        """
        obs: (batch, n_obs) raw normalised observation
        Returns: (batch, n_actions) action logits
        """
        features = self.features_extractor(obs)
        latent_pi = self.mlp_extractor.forward_actor(features)
        logits = self.action_net(latent_pi)
        return logits


def _extract_torch_model(policy: BasePolicy) -> torch.nn.Module:
    """Build a traceable actor module from a SB3 policy."""
    return _ActorForward(policy)


def export_policy_to_onnx(
    model: Union[PPO, SAC],
    out_path: Union[str, Path],
    opset_version: int = 14,
) -> Path:
    """
    Export a SB3 policy to ONNX using the legacy torch.onnx.export API.

    Works for PPO and SAC. The exported model outputs raw logits so the
    serving layer applies softmax/argmax as appropriate.
    """
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    policy = model.policy
    actor = _extract_torch_model(policy)

    # Detect obs shape from the policy
    obs_shape = policy.observation_space.shape
    dummy = _dummy_obs(obs_shape).unsqueeze(0)  # (1, *obs_shape)

    actor.eval()
    with torch.no_grad():
        torch.onnx.export(
            actor,
            dummy,
            str(out_path),
            input_names=["obs"],
            output_names=["action_logits"],
            dynamic_axes={
                "obs": {0: "batch"},
                "action_logits": {0: "batch"},
            },
            opset_version=opset_version,
            do_constant_folding=False,
        )

    # Verify by loading with onnxruntime
    try:
        import onnxruntime as ort

        sess = ort.InferenceSession(str(out_path))
        out = sess.run(None, {"obs": dummy.squeeze(0).numpy().reshape(1, -1)})
        print(f"[export] Verified ONNX output shape: {out[0].shape}")
    except ImportError:
        print("[export] onnxruntime not available — skipping runtime verification")

    print(f"[export] ONNX saved → {out_path}")
    return out_path


def load_onnx_session(onnx_path: Union[str, Path]):
    """Load an ONNX model with onnxruntime, return the InferenceSession."""
    import onnxruntime as ort

    return ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])


def predict_edge_score(
    sess,
    obs: np.ndarray,
) -> float:
    """
    Run ONNX inference on a single observation vector.
    Returns a scalar edge_score in [0, 1] derived from the softmax of logits.
    """
    if obs.ndim == 1:
        obs = obs.reshape(1, -1)
    logits = sess.run(None, {"obs": obs.astype(np.float32)})[0]
    # logits shape: (batch, n_actions)
    probs = np.exp(logits) / np.exp(logits).sum(axis=-1, keepdims=True)
    # edge_score = expected value under policy (weighted sum of action values)
    action_values = np.arange(probs.shape[1], dtype=np.float32)
    edge_score = float(np.dot(probs[0], action_values))
    # Normalise to [0, 1] assuming n_actions=5
    edge_score_norm = edge_score / max(action_values[-1], 1)
    return edge_score_norm
