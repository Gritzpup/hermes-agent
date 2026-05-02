"""
Active-target store + gurbridge HTTP client.

Maintains a per-task pointer to a CDP-adopted chromium tab that gurbridge is
already managing.  When set, two parallel transports use it:

  * Path A — direct CDP (low latency).  Used by input tools (scroll, click,
    press, type) so smooth scrolling stays smooth.  Implemented in
    ``browser_cdp_tool``.

  * Path B — gurbridge REST (gurbridge owns the heavy state).  Used by the
    state-reading tools (console, snapshot, screenshot, vision) because
    gurbridge already routes those through CDP for adopted panes and keeps
    its UI / visor / network log in sync as a side effect.

The single source of truth lives here so both paths stay coherent.  When
either path discovers the target is gone (404 from gurbridge, "no such
target" from CDP), it calls :func:`clear_active` and the legacy playwright
path takes over on the next tool call.
"""
from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Active-target store
# ---------------------------------------------------------------------------


@dataclass
class ActiveTarget:
    """One gurbridge pane being driven for a given task.

    Both CDP-adopted and Playwright-managed panes are supported.
    Playwright-managed panes have target_id="" (gurbridge REST handles
    both branches internally; Path B short-circuits use pane_id only).
    """

    pane_id: str          # gurbridge BrowserSession id (required)
    target_id: str        # chromium CDP targetId, "" for playwright-managed


_active: Dict[str, ActiveTarget] = {}   # task_id -> ActiveTarget
_lock = threading.RLock()


def set_active(task_id: str, pane_id: str, target_id: str) -> None:
    with _lock:
        _active[task_id or "default"] = ActiveTarget(pane_id=pane_id, target_id=target_id)
    logger.info("[active-target] set task=%s pane=%s target=%s", task_id, pane_id, target_id)
    _ensure_subscriber_started()


def get_active(task_id: Optional[str]) -> Optional[ActiveTarget]:
    with _lock:
        return _active.get(task_id or "default")


def clear_active(task_id: Optional[str]) -> None:
    with _lock:
        removed = _active.pop(task_id or "default", None)
    if removed is not None:
        logger.info("[active-target] cleared task=%s (was pane=%s)", task_id, removed.pane_id)
    _maybe_stop_subscriber()


def clear_all() -> None:
    """Test helper — wipe every task's pointer."""
    with _lock:
        _active.clear()
    _maybe_stop_subscriber()


# ---------------------------------------------------------------------------
# Gurbridge HTTP client (sync, requests-based)
# ---------------------------------------------------------------------------


def gurbridge_base_url() -> str:
    """Resolve the gurbridge REST base URL.

    Precedence:
      1. ``GURBRIDGE_BASE_URL`` env var (live override — wins over everything)
      2. ``browser.gurbridge_base_url`` in ``config.yaml``
      3. Default: ``http://127.0.0.1:4567``

    Port 4567 matches gurbridge's ``server/index.ts`` default
    (``const PORT = process.env.PORT || 4567``). Same port serves the UI
    AND the /api/* REST routes — gurbridge does NOT split UI and API
    onto different ports.

    The path ``/api`` is appended by callers — this returns just the host root.
    """
    env = (os.environ.get("GURBRIDGE_BASE_URL") or "").strip()
    if env:
        return env.rstrip("/")
    # Config lookup is best-effort. hermes_cli.config.cfg_get may fail in odd
    # contexts (test harness without config loaded, partially-imported state)
    # — fall back to default rather than blowing up at tool-import time.
    try:
        from hermes_cli.config import cfg_get  # type: ignore[import-not-found]
        cfg_val = (cfg_get("browser.gurbridge_base_url", "") or "").strip()
        if cfg_val:
            return cfg_val.rstrip("/")
    except Exception as exc:  # pragma: no cover — defensive
        logger.debug("gurbridge_base_url: cfg_get failed (%s) — using default", exc)
    return "http://127.0.0.1:4567"


def _api(path: str) -> str:
    base = gurbridge_base_url()
    if not path.startswith("/"):
        path = "/" + path
    return f"{base}/api{path}"


class GurbridgeUnavailable(Exception):
    """Raised when gurbridge is unreachable (network error, 5xx)."""


class GurbridgeNotFound(Exception):
    """Raised when gurbridge returns 404 — caller should clear active target."""


def _requests():
    import requests  # local import — keep tool import cheap
    return requests


def gb_get(path: str, *, timeout: float = 5.0) -> Dict[str, Any]:
    r = _requests().get(_api(path), timeout=timeout)
    if r.status_code == 404:
        raise GurbridgeNotFound(f"GET {path} -> 404")
    if not r.ok:
        raise GurbridgeUnavailable(f"GET {path} -> {r.status_code} {r.reason}")
    return r.json() if r.content else {}


def gb_post(path: str, body: Optional[Dict[str, Any]] = None, *, timeout: float = 15.0) -> Dict[str, Any]:
    r = _requests().post(_api(path), json=body or {}, timeout=timeout)
    if r.status_code == 404:
        raise GurbridgeNotFound(f"POST {path} -> 404")
    if not r.ok:
        raise GurbridgeUnavailable(f"POST {path} -> {r.status_code} {r.reason}")
    if not r.content:
        return {}
    ctype = r.headers.get("content-type", "")
    if "application/json" in ctype:
        return r.json()
    return {"_raw": r.content}


def gb_get_bytes(path: str, *, timeout: float = 15.0) -> bytes:
    r = _requests().get(_api(path), timeout=timeout)
    if r.status_code == 404:
        raise GurbridgeNotFound(f"GET {path} -> 404")
    if not r.ok:
        raise GurbridgeUnavailable(f"GET {path} -> {r.status_code} {r.reason}")
    return r.content


def list_panes() -> list[Dict[str, Any]]:
    """Return ``{id, name, url, _cdpTargetId?}`` for every gurbridge browser pane."""
    data = gb_get("/panes")
    return list(data.get("browsers", []))


def find_pane_by_target(target_id: str) -> Optional[Dict[str, Any]]:
    for p in list_panes():
        if p.get("_cdpTargetId") == target_id:
            return p
    return None


def find_pane_by_id(pane_id: str) -> Optional[Dict[str, Any]]:
    for p in list_panes():
        if p.get("id") == pane_id:
            return p
    return None


def is_gurbridge_reachable(timeout: float = 1.5) -> bool:
    """Cheap liveness probe.  Used by the activate tool's check function."""
    try:
        _requests().get(_api("/panes"), timeout=timeout)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Routing helper used by every Path B short-circuit in browser_tool
# ---------------------------------------------------------------------------


def maybe_route(task_id: Optional[str]):
    """Return the active ``ActiveTarget`` for this task, or ``None``."""
    return get_active(task_id)


# ---------------------------------------------------------------------------
# Socket.IO subscriber — instant eviction on pane close
# ---------------------------------------------------------------------------
#
# Without this, a pane closed in the gurbridge UI is only noticed when the
# next tool call hits a 404 and self-clears.  The lazy path is correct but
# costs the user one tool-call round-trip after the pane disappears.  This
# subscriber listens for ``pane:list:changed`` (gurbridge fires it on every
# pane add/remove, including CDP-adopted-tab close) and evicts any active
# target whose pane_id is no longer present in /api/panes.
#
# One global listener is enough — no per-pane wiring needed.  The
# subscriber is a singleton lazily started on the first ``set_active`` and
# torn down when the last active target is cleared, so a Hermes session
# that never calls browser_activate_tab pays zero cost.

_subscriber_lock = threading.RLock()
_subscriber: Optional["_GurbridgeSubscriber"] = None


class _GurbridgeSubscriber:
    """Wraps a synchronous socketio.Client connected to gurbridge.

    Has its own internal background thread (managed by socketio.Client) so
    callers stay sync.  Reconnects automatically on transient drops.
    """

    def __init__(self) -> None:
        try:
            import socketio  # type: ignore[import-not-found]
        except ImportError:
            self._sio = None
            return
        self._sio = socketio.Client(
            reconnection=True,
            reconnection_attempts=0,    # forever
            reconnection_delay=1.0,
            reconnection_delay_max=10.0,
            logger=False,
            engineio_logger=False,
        )
        self._sio.on("connect", self._on_connect)
        self._sio.on("disconnect", self._on_disconnect)
        self._sio.on("pane:list:changed", self._on_pane_list_changed)
        self._connected = False

    # -- lifecycle -------------------------------------------------------

    def start(self) -> None:
        if self._sio is None:
            logger.debug("[subscriber] python-socketio not available — skipping")
            return
        try:
            self._sio.connect(
                gurbridge_base_url(),
                transports=["websocket", "polling"],
                wait=False,                 # don't block — we'll catch up via reconnect
                wait_timeout=2.0,
            )
        except Exception as exc:
            logger.warning("[subscriber] initial connect failed (%s) — will keep retrying", exc)

    def stop(self) -> None:
        if self._sio is None:
            return
        try:
            self._sio.disconnect()
        except Exception:
            pass

    # -- handlers --------------------------------------------------------

    def _on_connect(self) -> None:
        self._connected = True
        logger.info("[subscriber] connected to gurbridge")
        # Re-validate on connect — we may have missed events while offline.
        self._evict_dead()

    def _on_disconnect(self) -> None:
        self._connected = False
        logger.info("[subscriber] disconnected from gurbridge")

    def _on_pane_list_changed(self, *_args, **_kwargs) -> None:
        self._evict_dead()

    def _evict_dead(self) -> None:
        """Walk active targets, drop any whose pane is gone from /api/panes."""
        with _lock:
            current = list(_active.items())  # snapshot under store lock
        if not current:
            return
        try:
            panes = list_panes()
        except Exception as exc:
            logger.debug("[subscriber] pane fetch failed (%s) — skipping eviction pass", exc)
            return
        live_ids = {p.get("id") for p in panes}
        for task_id, at in current:
            if at.pane_id not in live_ids:
                logger.info("[subscriber] evicting task=%s — pane %s no longer present",
                            task_id, at.pane_id)
                clear_active(task_id)


def _ensure_subscriber_started() -> None:
    """Start the singleton subscriber if it isn't already running.

    Disable in test runs by setting ``HERMES_DISABLE_GURBRIDGE_SUBSCRIBER=1``
    — connecting against a non-existent gurbridge in unit tests just logs
    noisy warnings without changing behaviour, so we skip cleanly.
    """
    if os.environ.get("HERMES_DISABLE_GURBRIDGE_SUBSCRIBER") == "1":
        return
    global _subscriber
    with _subscriber_lock:
        if _subscriber is not None:
            return
        sub = _GurbridgeSubscriber()
        sub.start()
        _subscriber = sub


def _maybe_stop_subscriber() -> None:
    """Tear the subscriber down when no task has an active target."""
    global _subscriber
    with _lock:
        any_active = bool(_active)
    if any_active:
        return
    with _subscriber_lock:
        if _subscriber is None:
            return
        sub, _subscriber = _subscriber, None
    sub.stop()


