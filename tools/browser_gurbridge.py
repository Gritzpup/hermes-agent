"""Gurbridge browser backend — routes browser tools through Gurbridge's Playwright UI.

When ``BROWSER_ENV=gurbridge`` (or ``HERMES_IN_GURBRIDGE=1``), all browser
operations route through Gurbridge's REST API instead of spawning local
agent-browser / Chromium processes.  The browser is visible in the Gurbridge
workspace grid with live screenshot streaming and cursor overlay.
"""

from __future__ import annotations

import base64
import json
import logging
import os
import threading
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

import requests

from tools.registry import tool_error

logger = logging.getLogger(__name__)

_DEFAULT_TIMEOUT = 30  # seconds per HTTP request
_SNAPSHOT_MAX_CHARS = 80_000

# task_id → browser_id mapping
_sessions: Dict[str, str] = {}
_sessions_lock = threading.Lock()


def _gurbridge_url() -> str:
    return os.getenv("GURBRIDGE_URL", "http://localhost:3456").rstrip("/")


def is_gurbridge_mode() -> bool:
    """True when running inside Gurbridge and no CDP override is active."""
    if os.getenv("BROWSER_CDP_URL", "").strip():
        return False
    return os.getenv("BROWSER_ENV", "") == "gurbridge" or os.getenv("HERMES_IN_GURBRIDGE", "") == "1"


def _http_get(path: str, params: Optional[dict] = None, timeout: float = _DEFAULT_TIMEOUT):
    return requests.get(f"{_gurbridge_url()}{path}", params=params, timeout=timeout)


def _http_post(path: str, json: Optional[dict] = None, timeout: float = _DEFAULT_TIMEOUT):
    return requests.post(f"{_gurbridge_url()}{path}", json=json, timeout=timeout)


def _http_delete(path: str, timeout: float = _DEFAULT_TIMEOUT):
    return requests.delete(f"{_gurbridge_url()}{path}", timeout=timeout)


def _get_browser_id(task_id: Optional[str]) -> Optional[str]:
    with _sessions_lock:
        return _sessions.get(task_id or "default")


def _set_browser_id(task_id: Optional[str], browser_id: str) -> None:
    with _sessions_lock:
        _sessions[task_id or "default"] = browser_id


def _drop_browser_id(task_id: Optional[str]) -> Optional[str]:
    with _sessions_lock:
        return _sessions.pop(task_id or "default", None)


def _ensure_browser(task_id: Optional[str]) -> str:
    """Create or reuse a Gurbridge browser for this task."""
    browser_id = _get_browser_id(task_id)
    if browser_id:
        # Verify it still exists
        try:
            resp = _http_get(f"/api/hermes/browser/{browser_id}")
            if resp.status_code == 200:
                return browser_id
        except Exception:
            pass
        _drop_browser_id(task_id)

    # Create new browser
    name = f"Hermes-{task_id[:8] if task_id else 'default'}"
    try:
        resp = _http_post("/api/hermes/browser", json={"name": name})
        resp.raise_for_status()
        data = resp.json()
        browser_id = data["id"]
        _set_browser_id(task_id, browser_id)
        logger.info("Created Gurbridge browser %s for task %s", browser_id, task_id)
        return browser_id
    except Exception as e:
        raise RuntimeError(f"Failed to create Gurbridge browser: {e}")


def _check_available() -> bool:
    try:
        resp = _http_get("/api/panes", timeout=5)
        return resp.status_code == 200
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Public API — mirrors browser_tool.py functions
# ---------------------------------------------------------------------------

def gurbridge_navigate(url: str, task_id: Optional[str] = None) -> str:
    """Navigate to a URL via Gurbridge browser."""
    try:
        browser_id = _ensure_browser(task_id)
        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/navigate",
            json={"url": url},
            timeout=60,
        )
        resp.raise_for_status()
        data = resp.json()
        return json.dumps({
            "success": True,
            "url": data.get("url", url),
            "message": f"Navigated to {url}",
        })
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_snapshot(
    full: bool = False,
    task_id: Optional[str] = None,
    user_task: Optional[str] = None,
) -> str:
    """Get accessibility tree snapshot from Gurbridge browser."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)

        resp = _http_get(f"/api/hermes/browser/{browser_id}/snapshot", timeout=60)
        resp.raise_for_status()
        data = resp.json()

        snapshot = data.get("text", "")
        url = data.get("url", "")
        title = data.get("title", "")

        # Truncate if too long
        if len(snapshot) > _SNAPSHOT_MAX_CHARS:
            snapshot = snapshot[:_SNAPSHOT_MAX_CHARS] + (
                f"\n\n[Snapshot truncated — {len(snapshot)} chars total. "
                f"Use browser_vision or specific element clicks to explore further.]"
            )

        return json.dumps({
            "success": True,
            "snapshot": snapshot,
            "url": url,
            "title": title,
        })
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_click(ref: str, task_id: Optional[str] = None) -> str:
    """Click an element by ref via Gurbridge browser."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)

        clean_ref = ref if ref.startswith("@") else f"@{ref}"
        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/click-ref",
            json={"ref": clean_ref},
        )
        resp.raise_for_status()
        return json.dumps({
            "success": True,
            "clicked": clean_ref,
        })
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_type(ref: str, text: str, task_id: Optional[str] = None) -> str:
    """Type text into an element by ref via Gurbridge browser."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)

        clean_ref = ref if ref.startswith("@") else f"@{ref}"
        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/type-ref",
            json={"ref": clean_ref, "text": text},
        )
        resp.raise_for_status()
        return json.dumps({
            "success": True,
            "typed": text,
            "element": clean_ref,
        })
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_scroll(direction: str, task_id: Optional[str] = None) -> str:
    """Scroll the page via Gurbridge browser."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)

        direction = direction.lower().strip()
        delta_map = {
            "up": (0, -500),
            "down": (0, 500),
            "left": (-500, 0),
            "right": (500, 0),
        }
        delta_x, delta_y = delta_map.get(direction, (0, 500))

        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/scroll",
            json={"deltaX": delta_x, "deltaY": delta_y},
        )
        resp.raise_for_status()
        return json.dumps({
            "success": True,
            "scrolled": direction,
            "deltaX": delta_x,
            "deltaY": delta_y,
        })
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_back(task_id: Optional[str] = None) -> str:
    """Navigate back via Gurbridge browser."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)

        resp = _http_post(f"/api/hermes/browser/{browser_id}/back")
        resp.raise_for_status()
        data = resp.json()
        return json.dumps({
            "success": True,
            "url": data.get("url", ""),
        })
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_press(key: str, task_id: Optional[str] = None) -> str:
    """Press a keyboard key via Gurbridge browser."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)

        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/press",
            json={"key": key},
        )
        resp.raise_for_status()
        return json.dumps({
            "success": True,
            "pressed": key,
        })
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_eval(expression: str, task_id: Optional[str] = None) -> str:
    """Evaluate JavaScript in the page context via Gurbridge browser."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)

        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/evaluate",
            json={"expression": expression},
        )
        resp.raise_for_status()
        data = resp.json()
        result = data.get("result")
        if isinstance(result, dict) and result.get("__error"):
            return json.dumps({
                "success": False,
                "error": result["__error"],
            })
        return json.dumps({
            "success": True,
            "result": result,
        })
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_console(clear: bool = False, task_id: Optional[str] = None) -> str:
    """Get console output — limited support in Gurbridge (no console log capture)."""
    return json.dumps({
        "success": True,
        "console_messages": [],
        "js_errors": [],
        "total_messages": 0,
        "total_errors": 0,
        "note": "Console log capture is not available with the Gurbridge backend. "
                "Use browser_eval to run JS, or browser_snapshot/browser_vision to inspect page state.",
    })


def gurbridge_get_images(task_id: Optional[str] = None) -> str:
    """Get images on the current page via Gurbridge browser."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)

        resp = _http_get(f"/api/hermes/browser/{browser_id}/images")
        resp.raise_for_status()
        data = resp.json()
        images = data.get("images", [])
        return json.dumps({
            "success": True,
            "images": images,
            "count": len(images),
        })
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_vision(
    question: str,
    annotate: bool = False,
    task_id: Optional[str] = None,
) -> str:
    """Take a screenshot and analyze it with vision AI via Gurbridge browser."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)

        # Save screenshot to persistent location
        from hermes_constants import get_hermes_dir
        screenshots_dir = get_hermes_dir("cache/screenshots", "browser_screenshots")
        screenshot_path = screenshots_dir / f"browser_screenshot_{uuid.uuid4().hex}.png"
        screenshots_dir.mkdir(parents=True, exist_ok=True)

        # Download screenshot from Gurbridge
        resp = _http_get(f"/api/hermes/browser/{browser_id}/screenshot", timeout=60)
        resp.raise_for_status()
        screenshot_path.write_bytes(resp.content)

        # Convert to base64 data URL
        screenshot_bytes = screenshot_path.read_bytes()
        screenshot_b64 = base64.b64encode(screenshot_bytes).decode("ascii")
        data_url = f"data:image/png;base64,{screenshot_b64}"

        vision_prompt = (
            f"You are analyzing a screenshot of a web browser.\n\n"
            f"User's question: {question}\n\n"
            f"Provide a detailed and helpful answer based on what you see in the screenshot. "
            f"If there are interactive elements, describe them. If there are verification challenges "
            f"or CAPTCHAs, describe what type they are and what action might be needed. "
            f"Focus on answering the user's specific question."
        )

        # Use centralized LLM router
        from agent.auxiliary_client import call_llm
        vision_model = os.getenv("AUXILIARY_VISION_MODEL", "").strip() or None
        vision_timeout = 120.0
        vision_temperature = 0.1
        try:
            from hermes_cli.config import load_config
            _cfg = load_config()
            _vision_cfg = _cfg.get("auxiliary", {}).get("vision", {})
            _vt = _vision_cfg.get("timeout")
            if _vt is not None:
                vision_timeout = float(_vt)
            _vtemp = _vision_cfg.get("temperature")
            if _vtemp is not None:
                vision_temperature = float(_vtemp)
        except Exception:
            pass

        call_kwargs = {
            "task": "vision",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": vision_prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
            "max_tokens": 2000,
            "temperature": vision_temperature,
            "timeout": vision_timeout,
        }
        if vision_model:
            call_kwargs["model"] = vision_model

        try:
            response = call_llm(**call_kwargs)
        except Exception as _api_err:
            from tools.vision_tools import (
                _is_image_size_error,
                _resize_image_for_vision,
                _RESIZE_TARGET_BYTES,
            )
            if _is_image_size_error(str(_api_err)):
                resized_path = screenshot_path.parent / f"{screenshot_path.stem}_resized{screenshot_path.suffix}"
                _resize_image_for_vision(screenshot_path, resized_path, _RESIZE_TARGET_BYTES)
                resized_bytes = resized_path.read_bytes()
                resized_b64 = base64.b64encode(resized_bytes).decode("ascii")
                data_url = f"data:image/png;base64,{resized_b64}"
                call_kwargs["messages"][0]["content"][1]["image_url"]["url"] = data_url
                response = call_llm(**call_kwargs)
                resized_path.unlink(missing_ok=True)
            else:
                raise

        answer = ""
        if isinstance(response, str):
            answer = response
        elif isinstance(response, dict):
            answer = response.get("content", "") or response.get("text", "")
        elif hasattr(response, "choices") and response.choices:
            answer = response.choices[0].message.content or ""

        return json.dumps({
            "success": True,
            "answer": answer,
            "screenshot_path": str(screenshot_path),
            "data_url": data_url[:100] + "...",
        }, ensure_ascii=False)
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_close(task_id: Optional[str] = None) -> str:
    """Close the Gurbridge browser session."""
    browser_id = _drop_browser_id(task_id)
    if not browser_id:
        return json.dumps({"success": True, "closed": True})
    try:
        _http_delete(f"/api/hermes/browser/{browser_id}")
        return json.dumps({"success": True, "closed": True})
    except Exception as e:
        return json.dumps({"success": True, "closed": True, "warning": str(e)})


def gurbridge_soft_cleanup(task_id: Optional[str] = None) -> bool:
    """Drop local tracking without destroying the Gurbridge browser.

    Gurbridge browsers are managed by the IDE and survive task boundaries,
    so we just forget the local mapping.  The IDE can reuse or close them.
    """
    _drop_browser_id(task_id)
    logger.debug("Gurbridge soft cleanup for task %s", task_id)
    return True
