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
    """Always True for hermes-gurbridge — all browser ops route to Gurbridge panel."""
    return True


def _http_get(path: str, params: Optional[dict] = None, timeout: float = _DEFAULT_TIMEOUT):
    return requests.get(f"{_gurbridge_url()}{path}", params=params, timeout=timeout)


def _http_post(path: str, json: Optional[dict] = None, timeout: float = _DEFAULT_TIMEOUT):
    return requests.post(f"{_gurbridge_url()}{path}", json=json, timeout=timeout)


def _http_delete(path: str, timeout: float = _DEFAULT_TIMEOUT):
    return requests.delete(f"{_gurbridge_url()}{path}", timeout=timeout)


def _find_existing_browser() -> Optional[str]:
    """Query Gurbridge for any existing browser and return its ID."""
    try:
        resp = _http_get("/api/panes", timeout=5)
        if resp.status_code == 200:
            data = resp.json()
            browsers = data.get("browsers", [])
            if browsers:
                return browsers[0]["id"]
    except Exception:
        pass
    return None


def _get_browser_id(task_id: Optional[str]) -> Optional[str]:
    with _sessions_lock:
        browser_id = _sessions.get(task_id or "default")
    if browser_id:
        return browser_id
    # Fall back to any existing browser in Gurbridge
    existing = _find_existing_browser()
    if existing:
        _set_browser_id(task_id, existing)
    return existing


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


# ANSI color codes for terminal injection
_ANSI_MAGENTA = "\x1b[35m"
_ANSI_BLUE = "\x1b[34m"
_ANSI_GREEN = "\x1b[32m"
_ANSI_YELLOW = "\x1b[33m"
_ANSI_CYAN = "\x1b[36m"
_ANSI_RESET = "\x1b[0m"
_ANSI_BOLD = "\x1b[1m"
_ANSI_DIM = "\x1b[2m"


def _find_best_terminal() -> Optional[str]:
    """Find the best terminal to inject vision logs into.

    Prefers a terminal named 'Vision' or containing 'vision', then falls
    back to the first alive terminal. Returns the terminal id or None.
    """
    try:
        resp = _http_get("/api/hermes/terminals", timeout=5)
        if resp.status_code != 200:
            return None
        terminals = resp.json()
        if not terminals:
            return None

        # Prefer a terminal named for vision
        for t in terminals:
            name = (t.get("name") or "").lower()
            if "vision" in name or "log" in name or "aux" in name:
                return t["id"]

        # Fall back to first alive terminal
        for t in terminals:
            if t.get("alive"):
                return t["id"]

        # Last resort: first terminal regardless
        return terminals[0]["id"]
    except Exception:
        return None


def _inject_to_terminal(text: str) -> bool:
    """Inject display-only text into a Gurbridge terminal."""
    term_id = _find_best_terminal()
    if not term_id:
        return False
    try:
        resp = _http_post(
            f"/api/hermes/terminal/{term_id}/inject",
            json={"data": text},
            timeout=5,
        )
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
    """Get console output from Gurbridge browser."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)

        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/console",
            json={"clear": clear},
        )
        resp.raise_for_status()
        data = resp.json()

        messages = data.get("console_messages", []) or []
        errors = data.get("js_errors", []) or []

        # Format for Hermes consumption
        formatted_messages = []
        for msg in messages:
            formatted_messages.append(f"[{msg.get('type', 'log')}] {msg.get('text', '')}")

        formatted_errors = []
        for err in errors:
            formatted_errors.append(f"[ERROR] {err.get('message', '')}")

        return json.dumps({
            "success": True,
            "console_messages": formatted_messages,
            "js_errors": formatted_errors,
            "total_messages": len(formatted_messages),
            "total_errors": len(formatted_errors),
            "raw_messages": messages,
            "raw_errors": errors,
        })
    except Exception as e:
        return tool_error(str(e), success=False)


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

        # ── Terminal logging header ──
        _inject_to_terminal(
            f"\r\n{_ANSI_BOLD}{_ANSI_MAGENTA}🔮  browser_vision{_ANSI_RESET}  "
            f"{_ANSI_DIM}{_ANSI_CYAN}analyzing screenshot...{_ANSI_RESET}\r\n"
        )

        # Save screenshot to persistent location
        from hermes_constants import get_hermes_dir
        screenshots_dir = get_hermes_dir("cache/screenshots", "browser_screenshots")
        screenshot_path = screenshots_dir / f"browser_screenshot_{uuid.uuid4().hex}.png"
        screenshots_dir.mkdir(parents=True, exist_ok=True)

        # Download screenshot from Gurbridge
        _inject_to_terminal(
            f"{_ANSI_DIM}   📸  capturing screenshot...{_ANSI_RESET}\r\n"
        )
        resp = _http_get(f"/api/hermes/browser/{browser_id}/screenshot", timeout=60)
        resp.raise_for_status()
        screenshot_path.write_bytes(resp.content)
        size_kb = len(resp.content) / 1024
        _inject_to_terminal(
            f"{_ANSI_DIM}   ✅  screenshot saved ({size_kb:.1f} KB) → "
            f"{screenshot_path.name}{_ANSI_RESET}\r\n"
        )

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

        _resolved_model = vision_model or "auto"
        _inject_to_terminal(
            f"{_ANSI_DIM}   🧠  sending to vision model ({_resolved_model})...{_ANSI_RESET}\r\n"
        )

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
            _inject_to_terminal(
                f"{_ANSI_YELLOW}   ⚠️  vision call failed, retrying...{_ANSI_RESET}\r\n"
            )
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

        # Show result in terminal
        _answer_preview = answer.replace("\r\n", "\n").replace("\n", " ")
        if len(_answer_preview) > 120:
            _answer_preview = _answer_preview[:120] + "..."
        _inject_to_terminal(
            f"{_ANSI_GREEN}   ✅  analysis complete{_ANSI_RESET}\r\n"
            f"{_ANSI_DIM}   →  {_answer_preview}{_ANSI_RESET}\r\n"
            f"\r\n"
        )

        return json.dumps({
            "success": True,
            "answer": answer,
            "screenshot_path": str(screenshot_path),
            "data_url": data_url[:100] + "...",
        }, ensure_ascii=False)
    except Exception as e:
        _inject_to_terminal(
            f"{_ANSI_YELLOW}   ❌  browser_vision failed: {e}{_ANSI_RESET}\r\n\r\n"
        )
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


def gurbridge_hover(
    x: Optional[int] = None,
    y: Optional[int] = None,
    ref: Optional[str] = None,
    task_id: Optional[str] = None,
) -> str:
    """Hover over coordinates or an element by ref in the Gurbridge browser."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)
        if ref is not None:
            clean_ref = ref if ref.startswith("@") else f"@{ref}"
            resp = _http_post(
                f"/api/hermes/browser/{browser_id}/hover-ref",
                json={"ref": clean_ref},
            )
        elif x is not None and y is not None:
            resp = _http_post(
                f"/api/hermes/browser/{browser_id}/hover",
                json={"x": x, "y": y},
            )
        else:
            return tool_error("Provide either ref or x+y coordinates.", success=False)
        resp.raise_for_status()
        return json.dumps({"success": True, "hovered": True})
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_highlight(
    ref: str,
    label: Optional[str] = None,
    task_id: Optional[str] = None,
) -> str:
    """Highlight an element by ref in the Gurbridge browser to show what the agent is looking at.

    This creates a visible highlight overlay on the element and smooth-scrolls it into view,
    making the agent's inspection process transparent to the user.
    """
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)
        clean_ref = ref if ref.startswith("@") else f"@{ref}"
        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/highlight",
            json={"ref": clean_ref, "label": label},
        )
        resp.raise_for_status()
        return json.dumps({"success": True, "highlighted": clean_ref, "label": label})
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_drag(
    start_x: int,
    start_y: int,
    end_x: int,
    end_y: int,
    task_id: Optional[str] = None,
) -> str:
    """Drag from start coordinates to end coordinates in the Gurbridge browser."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)
        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/drag",
            json={"startX": start_x, "startY": start_y, "endX": end_x, "endY": end_y},
        )
        resp.raise_for_status()
        return json.dumps({"success": True, "dragged": True})
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_select(
    ref: str,
    value: str,
    task_id: Optional[str] = None,
) -> str:
    """Select an option from a <select> dropdown by ref."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)
        clean_ref = ref if ref.startswith("@") else f"@{ref}"
        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/select",
            json={"ref": clean_ref, "value": value},
        )
        resp.raise_for_status()
        return json.dumps({"success": True, "selected": value})
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_upload(
    ref: str,
    file_path: str,
    task_id: Optional[str] = None,
) -> str:
    """Upload a file to a file input by ref."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)
        clean_ref = ref if ref.startswith("@") else f"@{ref}"
        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/upload",
            json={"ref": clean_ref, "filePath": file_path},
        )
        resp.raise_for_status()
        return json.dumps({"success": True, "uploaded": file_path})
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_wait(
    condition_type: str,
    condition_value: Optional[str] = None,
    timeout: int = 5000,
    task_id: Optional[str] = None,
) -> str:
    """Wait for a condition in the Gurbridge browser.

    condition_type: 'selector', 'text', or 'navigation'
    condition_value: the selector, text, or URL fragment to wait for
    timeout: max wait time in milliseconds (default 5000)
    """
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)
        condition = {"type": condition_type}
        if condition_value is not None:
            condition["value"] = condition_value
        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/wait",
            json={"condition": condition, "timeout": timeout},
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("timedOut"):
            return json.dumps({"success": False, "timed_out": True, "error": f"Condition '{condition_value}' not met within {timeout}ms"})
        return json.dumps({"success": True, "condition_met": True})
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_get_html(task_id: Optional[str] = None) -> str:
    """Get the full HTML of the current page."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)
        resp = _http_get(f"/api/hermes/browser/{browser_id}/html", timeout=30)
        resp.raise_for_status()
        html = resp.text
        if len(html) > 8000:
            html = html[:8000] + f"\n\n[HTML truncated — {len(html)} chars total]"
        return json.dumps({"success": True, "html": html})
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_get_text(
    ref: str,
    task_id: Optional[str] = None,
) -> str:
    """Get the text content of an element by ref."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)
        clean_ref = ref if ref.startswith("@") else f"@{ref}"
        resp = _http_get(f"/api/hermes/browser/{browser_id}/text", params={"ref": clean_ref}, timeout=30)
        resp.raise_for_status()
        data = resp.json()
        return json.dumps({"success": True, "text": data.get("text", "")})
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_set_viewport(
    width: int,
    height: int,
    task_id: Optional[str] = None,
) -> str:
    """Set the browser viewport size."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)
        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/viewport",
            json={"width": width, "height": height},
        )
        resp.raise_for_status()
        return json.dumps({"success": True, "viewport": {"width": width, "height": height}})
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_screenshot_full(task_id: Optional[str] = None) -> str:
    """Take a full-page screenshot and save it locally. Returns the file path."""
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)
        from hermes_constants import get_hermes_dir
        screenshots_dir = get_hermes_dir("cache/screenshots", "browser_screenshots")
        screenshot_path = screenshots_dir / f"browser_full_{uuid.uuid4().hex}.png"
        screenshots_dir.mkdir(parents=True, exist_ok=True)
        resp = _http_get(f"/api/hermes/browser/{browser_id}/screenshot-full", timeout=60)
        resp.raise_for_status()
        screenshot_path.write_bytes(resp.content)
        size_kb = len(resp.content) / 1024
        _inject_to_terminal(
            f"\r\n{_ANSI_BOLD}{_ANSI_MAGENTA}📸  browser_screenshot_full{_ANSI_RESET}  "
            f"{screenshot_path.name} ({size_kb:.1f} KB)\r\n"
        )
        return json.dumps({
            "success": True,
            "screenshot_path": str(screenshot_path),
            "size_kb": round(size_kb, 1),
        })
    except Exception as e:
        return tool_error(str(e), success=False)


def gurbridge_actions(
    actions: list,
    task_id: Optional[str] = None,
) -> str:
    """Execute a sequence of browser actions in one batch call.

    Actions is a list of dicts, each with a 'type' key:
      - {"type": "navigate", "url": "..."}
      - {"type": "click", "x": 100, "y": 200}
      - {"type": "clickRef", "ref": "@e1"}
      - {"type": "type", "text": "..."}
      - {"type": "typeRef", "ref": "@e1", "text": "..."}
      - {"type": "scroll", "deltaX": 0, "deltaY": 300}
      - {"type": "press", "key": "Enter"}
      - {"type": "hover", "x": 100, "y": 200}
      - {"type": "hoverRef", "ref": "@e1"}
      - {"type": "drag", "startX": 100, "startY": 200, "endX": 300, "endY": 400}
      - {"type": "select", "ref": "@e1", "value": "option1"}
      - {"type": "wait", "conditionType": "selector", "conditionValue": "#id", "timeout": 5000}
      - {"type": "evaluate", "expression": "document.title"}
    """
    try:
        browser_id = _get_browser_id(task_id)
        if not browser_id:
            return tool_error("No browser session. Call browser_navigate first.", success=False)
        resp = _http_post(
            f"/api/hermes/browser/{browser_id}/actions",
            json={"actions": actions},
            timeout=120,
        )
        resp.raise_for_status()
        data = resp.json()
        if not data.get("ok"):
            return json.dumps({
                "success": False,
                "error": data.get("error", "Action sequence failed"),
                "results": data.get("results", []),
            })
        return json.dumps({
            "success": True,
            "results": data.get("results", []),
            "all_ok": data.get("ok", False),
        })
    except Exception as e:
        return tool_error(str(e), success=False)
