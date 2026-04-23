#!/usr/bin/env python3
"""
Browser Tool Module

This module provides browser automation tools using agent-browser CLI.  It
supports multiple backends — **Browser Use** (cloud, default for Nous
subscribers), **Browserbase** (cloud, direct credentials), and **local
Chromium** — with identical agent-facing behaviour.  The backend is
auto-detected from config and available credentials.

The tool uses agent-browser's accessibility tree (ariaSnapshot) for text-based
page representation, making it ideal for LLM agents without vision capabilities.

Features:
- **Local mode** (default): zero-cost headless Chromium via agent-browser.
  Works on Linux servers without a display.  One-time setup:
  ``agent-browser install`` (downloads Chromium) or
  ``agent-browser install --with-deps`` (also installs system libraries for
  Debian/Ubuntu/Docker).
- **Cloud mode**: Browserbase or Browser Use cloud execution when configured.
- Session isolation per task ID
- Text-based page snapshots using accessibility tree
- Element interaction via ref selectors (@e1, @e2, etc.)
- Task-aware content extraction using LLM summarization
- Automatic cleanup of browser sessions

Environment Variables:
- BROWSERBASE_API_KEY: API key for direct Browserbase cloud mode
- BROWSERBASE_PROJECT_ID: Project ID for direct Browserbase cloud mode
- BROWSER_USE_API_KEY: API key for direct Browser Use cloud mode
- BROWSERBASE_PROXIES: Enable/disable residential proxies (default: "true")
- BROWSERBASE_ADVANCED_STEALTH: Enable advanced stealth mode with custom Chromium,
  requires Scale Plan (default: "false")
- BROWSERBASE_KEEP_ALIVE: Enable keepAlive for session reconnection after disconnects,
  requires paid plan (default: "true")
- BROWSERBASE_SESSION_TIMEOUT: Custom session timeout in milliseconds. Set to extend
  beyond project default. Common values: 600000 (10min), 1800000 (30min) (default: none)

Usage:
    from tools.browser_tool import browser_navigate, browser_snapshot, browser_click
    
    # Navigate to a page
    result = browser_navigate("https://example.com", task_id="task_123")
    
    # Get page snapshot
    snapshot = browser_snapshot(task_id="task_123")
    
    # Click an element
    browser_click("@e5", task_id="task_123")
"""

import atexit
import functools
import json
import logging
import os
import re
import signal
import subprocess
import shutil
import sys
import tempfile
import threading
import time
import requests
from typing import Dict, Any, Optional, List
from pathlib import Path
from agent.auxiliary_client import call_llm
from hermes_constants import get_hermes_home

try:
    from tools.website_policy import check_website_access
except Exception:
    check_website_access = lambda url: None  # noqa: E731 — fail-open if policy module unavailable

try:
    from tools.url_safety import is_safe_url as _is_safe_url
except Exception:
    _is_safe_url = lambda url: False  # noqa: E731 — fail-closed: block all if safety module unavailable
from tools.browser_providers.base import CloudBrowserProvider
from tools.browser_providers.browserbase import BrowserbaseProvider
from tools.browser_providers.browser_use import BrowserUseProvider
from tools.browser_providers.firecrawl import FirecrawlProvider
from tools.tool_backend_helpers import normalize_browser_cloud_provider

# Camofox local anti-detection browser backend (optional).
# When CAMOFOX_URL is set, all browser operations route through the
# camofox REST API instead of the agent-browser CLI.
try:
    from tools.browser_camofox import is_camofox_mode as _is_camofox_mode
except ImportError:
    _is_camofox_mode = lambda: False  # noqa: E731

# Gurbridge browser backend — routes through Gurbridge's visible Playwright UI.
try:
    from tools.browser_gurbridge import is_gurbridge_mode as _is_gurbridge_mode
except ImportError:
    _is_gurbridge_mode = lambda: False  # noqa: E731

logger = logging.getLogger(__name__)

# Standard PATH entries for environments with minimal PATH (e.g. systemd services).
# Includes Android/Termux and macOS Homebrew locations needed for agent-browser,
# npx, node, and Android's glibc runner (grun).
_SANE_PATH_DIRS = (
    "/data/data/com.termux/files/usr/bin",
    "/data/data/com.termux/files/usr/sbin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
)
_SANE_PATH = os.pathsep.join(_SANE_PATH_DIRS)


@functools.lru_cache(maxsize=1)
def _discover_homebrew_node_dirs() -> tuple[str, ...]:
    """Find Homebrew versioned Node.js bin directories (e.g. node@20, node@24).

    When Node is installed via ``brew install node@24`` and NOT linked into
    /opt/homebrew/bin, agent-browser isn't discoverable on the default PATH.
    This function finds those directories so they can be prepended.
    """
    dirs: list[str] = []
    homebrew_opt = "/opt/homebrew/opt"
    if not os.path.isdir(homebrew_opt):
        return tuple(dirs)
    try:
        for entry in os.listdir(homebrew_opt):
            if entry.startswith("node") and entry != "node":
                bin_dir = os.path.join(homebrew_opt, entry, "bin")
                if os.path.isdir(bin_dir):
                    dirs.append(bin_dir)
    except OSError:
        pass
    return tuple(dirs)


def _browser_candidate_path_dirs() -> list[str]:
    """Return ordered browser CLI PATH candidates shared by discovery and execution."""
    hermes_home = get_hermes_home()
    hermes_node_bin = str(hermes_home / "node" / "bin")
    return [hermes_node_bin, *list(_discover_homebrew_node_dirs()), *_SANE_PATH_DIRS]


def _merge_browser_path(existing_path: str = "") -> str:
    """Prepend browser-specific PATH fallbacks without reordering existing entries."""
    path_parts = [p for p in (existing_path or "").split(os.pathsep) if p]
    existing_parts = set(path_parts)
    prefix_parts: list[str] = []

    for part in _browser_candidate_path_dirs():
        if not part or part in existing_parts or part in prefix_parts:
            continue
        if os.path.isdir(part):
            prefix_parts.append(part)

    return os.pathsep.join(prefix_parts + path_parts)

# Throttle screenshot cleanup to avoid repeated full directory scans.
_last_screenshot_cleanup_by_dir: dict[str, float] = {}

# ============================================================================
# Configuration
# ============================================================================

# Default timeout for browser commands (seconds)
DEFAULT_COMMAND_TIMEOUT = 30

# Max tokens for snapshot content before summarization
SNAPSHOT_SUMMARIZE_THRESHOLD = 8000

# Commands that legitimately return empty stdout (e.g. close, record).
_EMPTY_OK_COMMANDS: frozenset = frozenset({"close", "record"})

_cached_command_timeout: Optional[int] = None
_command_timeout_resolved = False


def _get_command_timeout() -> int:
    """Return the configured browser command timeout from config.yaml.

    Reads ``config["browser"]["command_timeout"]`` and falls back to
    ``DEFAULT_COMMAND_TIMEOUT`` (30s) if unset or unreadable.  Result is
    cached after the first call and cleared by ``cleanup_all_browsers()``.
    """
    global _cached_command_timeout, _command_timeout_resolved
    if _command_timeout_resolved:
        return _cached_command_timeout  # type: ignore[return-value]

    _command_timeout_resolved = True
    result = DEFAULT_COMMAND_TIMEOUT
    try:
        from hermes_cli.config import read_raw_config
        cfg = read_raw_config()
        val = cfg.get("browser", {}).get("command_timeout")
        if val is not None:
            result = max(int(val), 5)  # Floor at 5s to avoid instant kills
    except Exception as e:
        logger.debug("Could not read command_timeout from config: %s", e)
    _cached_command_timeout = result
    return result


def _get_vision_model() -> Optional[str]:
    """Model for browser_vision (screenshot analysis — multimodal)."""
    return os.getenv("AUXILIARY_VISION_MODEL", "").strip() or None


def _get_extraction_model() -> Optional[str]:
    """Model for page snapshot text summarization — same as web_extract."""
    return os.getenv("AUXILIARY_WEB_EXTRACT_MODEL", "").strip() or None


def _resolve_cdp_override(cdp_url: str) -> str:
    """Normalize a user-supplied CDP endpoint into a concrete connectable URL.

    Accepts:
    - full websocket endpoints: ws://host:port/devtools/browser/...
    - HTTP discovery endpoints: http://host:port or http://host:port/json/version
    - bare websocket host:port values like ws://host:port

    For discovery-style endpoints we fetch /json/version and return the
    webSocketDebuggerUrl so downstream tools always receive a concrete browser
    websocket instead of an ambiguous host:port URL.
    """
    raw = (cdp_url or "").strip()
    if not raw:
        return ""

    lowered = raw.lower()
    if "/devtools/browser/" in lowered:
        return raw

    discovery_url = raw
    if lowered.startswith(("ws://", "wss://")):
        if raw.count(":") == 2 and raw.rstrip("/").rsplit(":", 1)[-1].isdigit() and "/" not in raw.split(":", 2)[-1]:
            discovery_url = ("http://" if lowered.startswith("ws://") else "https://") + raw.split("://", 1)[1]
        else:
            return raw

    if discovery_url.lower().endswith("/json/version"):
        version_url = discovery_url
    else:
        version_url = discovery_url.rstrip("/") + "/json/version"

    try:
        response = requests.get(version_url, timeout=10)
        response.raise_for_status()
        payload = response.json()
    except Exception as exc:
        logger.warning("Failed to resolve CDP endpoint %s via %s: %s", raw, version_url, exc)
        return raw

    ws_url = str(payload.get("webSocketDebuggerUrl") or "").strip()
    if ws_url:
        logger.info("Resolved CDP endpoint %s -> %s", raw, ws_url)
        return ws_url

    logger.warning("CDP discovery at %s did not return webSocketDebuggerUrl; using raw endpoint", version_url)
    return raw


def _get_cdp_override() -> str:
    """Return a normalized CDP URL override, or empty string.

    Precedence is:
    1. ``BROWSER_CDP_URL`` env var (live override from ``/browser connect``)
    2. ``browser.cdp_url`` in config.yaml (persistent config)

    When either is set, we skip both Browserbase and the local headless
    launcher and connect directly to the supplied Chrome DevTools Protocol
    endpoint.
    """
    env_override = os.environ.get("BROWSER_CDP_URL", "").strip()
    if env_override:
        return _resolve_cdp_override(env_override)

    try:
        from hermes_cli.config import read_raw_config

        cfg = read_raw_config()
        browser_cfg = cfg.get("browser", {})
        if isinstance(browser_cfg, dict):
            return _resolve_cdp_override(str(browser_cfg.get("cdp_url", "") or ""))
    except Exception as e:
        logger.debug("Could not read browser.cdp_url from config: %s", e)

    return ""


# ============================================================================
# Cloud Provider Registry
# ============================================================================

_PROVIDER_REGISTRY: Dict[str, type] = {
    "browserbase": BrowserbaseProvider,
    "browser-use": BrowserUseProvider,
    "firecrawl": FirecrawlProvider,
}

_cached_cloud_provider: Optional[CloudBrowserProvider] = None
_cloud_provider_resolved = False
_allow_private_urls_resolved = False
_cached_allow_private_urls: Optional[bool] = None
_cached_agent_browser: Optional[str] = None
_agent_browser_resolved = False


def _get_cloud_provider() -> Optional[CloudBrowserProvider]:
    """Return the configured cloud browser provider, or None for local mode.

    Reads ``config["browser"]["cloud_provider"]`` once and caches the result
    for the process lifetime. An explicit ``local`` provider disables cloud
    fallback. If unset, fall back to Browserbase when direct or managed
    Browserbase credentials are available.
    """
    global _cached_cloud_provider, _cloud_provider_resolved
    if _cloud_provider_resolved:
        return _cached_cloud_provider

    _cloud_provider_resolved = True
    try:
        from hermes_cli.config import read_raw_config
        cfg = read_raw_config()
        browser_cfg = cfg.get("browser", {})
        provider_key = None
        if isinstance(browser_cfg, dict) and "cloud_provider" in browser_cfg:
            provider_key = normalize_browser_cloud_provider(
                browser_cfg.get("cloud_provider")
            )
            if provider_key == "local":
                _cached_cloud_provider = None
                return None
        if provider_key and provider_key in _PROVIDER_REGISTRY:
            _cached_cloud_provider = _PROVIDER_REGISTRY[provider_key]()
    except Exception as e:
        logger.debug("Could not read cloud_provider from config: %s", e)

    if _cached_cloud_provider is None:
        # Prefer Browser Use (managed Nous gateway or direct API key),
        # fall back to Browserbase (direct credentials only).
        fallback_provider = BrowserUseProvider()
        if fallback_provider.is_configured():
            _cached_cloud_provider = fallback_provider
        else:
            fallback_provider = BrowserbaseProvider()
            if fallback_provider.is_configured():
                _cached_cloud_provider = fallback_provider

    return _cached_cloud_provider


from hermes_constants import is_termux as _is_termux_environment


def _browser_install_hint() -> str:
    if _is_termux_environment():
        return "npm install -g agent-browser && agent-browser install"
    return "npm install -g agent-browser && agent-browser install --with-deps"


def _requires_real_termux_browser_install(browser_cmd: str) -> bool:
    return _is_termux_environment() and _is_local_mode() and browser_cmd.strip() == "npx agent-browser"


def _termux_browser_install_error() -> str:
    return (
        "Local browser automation on Termux cannot rely on the bare npx fallback. "
        f"Install agent-browser explicitly first: {_browser_install_hint()}"
    )


def _is_local_mode() -> bool:
    """Return True when the browser tool will use a local browser backend."""
    if _get_cdp_override():
        return False
    return _get_cloud_provider() is None


def _is_local_backend() -> bool:
    """Return True when the browser runs locally (no cloud provider).

    SSRF protection is only meaningful for cloud backends (Browserbase,
    BrowserUse) where the agent could reach internal resources on a remote
    machine.  For local backends — Camofox, or the built-in headless
    Chromium without a cloud provider — the user already has full terminal
    and network access on the same machine, so the check adds no security
    value.
    """
    return _is_camofox_mode() or _get_cloud_provider() is None


def _allow_private_urls() -> bool:
    """Return whether the browser is allowed to navigate to private/internal addresses.

    Reads ``config["browser"]["allow_private_urls"]`` once and caches the result
    for the process lifetime.  Defaults to ``False`` (SSRF protection active).
    """
    global _cached_allow_private_urls, _allow_private_urls_resolved
    if _allow_private_urls_resolved:
        return _cached_allow_private_urls

    _allow_private_urls_resolved = True
    _cached_allow_private_urls = False  # safe default
    try:
        from hermes_cli.config import read_raw_config
        cfg = read_raw_config()
        _cached_allow_private_urls = bool(cfg.get("browser", {}).get("allow_private_urls"))
    except Exception as e:
        logger.debug("Could not read allow_private_urls from config: %s", e)
    return _cached_allow_private_urls


def _socket_safe_tmpdir() -> str:
    """Return a short temp directory path suitable for Unix domain sockets.

    macOS sets ``TMPDIR`` to ``/var/folders/xx/.../T/`` (~51 chars).  When we
    append ``agent-browser-hermes_…`` the resulting socket path exceeds the
    104-byte macOS limit for ``AF_UNIX`` addresses, causing agent-browser to
    fail with "Failed to create socket directory" or silent screenshot failures.

    Linux ``tempfile.gettempdir()`` already returns ``/tmp``, so this is a
    no-op there.  On macOS we bypass ``TMPDIR`` and use ``/tmp`` directly
    (symlink to ``/private/tmp``, sticky-bit protected, always available).
    """
    if sys.platform == "darwin":
        return "/tmp"
    return tempfile.gettempdir()


# Track active sessions per task
# Stores: session_name (always), bb_session_id + cdp_url (cloud mode only)
