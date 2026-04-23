"""Extra browser actions — hover, highlight, drag, select, upload, wait, viewport."""

import json
import logging
import os
from typing import Optional

from tools.browser_state import active_sessions, session_last_activity, cleanup_lock
from tools.browser_utils import (
    _is_gurbridge_mode,
    _is_camofox_mode,
    logger,
)
from tools.browser_session import _get_session_info

def browser_hover(
    ref: Optional[str] = None,
    x: Optional[int] = None,
    y: Optional[int] = None,
    task_id: Optional[str] = None,
) -> str:
    """Hover over an element or coordinates in the browser."""
    if _is_gurbridge_mode():
        from tools.browser_gurbridge import gurbridge_hover
        return gurbridge_hover(x=x, y=y, ref=ref, task_id=task_id)
    return json.dumps({"success": False, "error": "browser_hover not implemented for non-Gurbridge mode"})


def browser_highlight(
    ref: str,
    label: Optional[str] = None,
    task_id: Optional[str] = None,
) -> str:
    """Visually highlight an element in the browser to show what the agent is looking at."""
    if _is_gurbridge_mode():
        from tools.browser_gurbridge import gurbridge_highlight
        return gurbridge_highlight(ref=ref, label=label, task_id=task_id)
    return json.dumps({"success": False, "error": "browser_highlight not implemented for non-Gurbridge mode"})


def browser_drag(
    start_x: int,
    start_y: int,
    end_x: int,
    end_y: int,
    task_id: Optional[str] = None,
) -> str:
    """Drag from start to end coordinates in the browser."""
    if _is_gurbridge_mode():
        from tools.browser_gurbridge import gurbridge_drag
        return gurbridge_drag(start_x=start_x, start_y=start_y, end_x=end_x, end_y=end_y, task_id=task_id)
    return json.dumps({"success": False, "error": "browser_drag not implemented for non-Gurbridge mode"})


def browser_select(
    ref: str,
    value: str,
    task_id: Optional[str] = None,
) -> str:
    """Select an option from a dropdown by ref."""
    if _is_gurbridge_mode():
        from tools.browser_gurbridge import gurbridge_select
        return gurbridge_select(ref=ref, value=value, task_id=task_id)
    return json.dumps({"success": False, "error": "browser_select not implemented for non-Gurbridge mode"})


def browser_upload(
    ref: str,
    file_path: str,
    task_id: Optional[str] = None,
) -> str:
    """Upload a file to a file input by ref."""
    if _is_gurbridge_mode():
        from tools.browser_gurbridge import gurbridge_upload
        return gurbridge_upload(ref=ref, file_path=file_path, task_id=task_id)
    return json.dumps({"success": False, "error": "browser_upload not implemented for non-Gurbridge mode"})


def browser_wait(
    condition_type: str,
    condition_value: str,
    timeout: int = 5000,
    task_id: Optional[str] = None,
) -> str:
    """Wait for a condition in the browser."""
    if _is_gurbridge_mode():
        from tools.browser_gurbridge import gurbridge_wait
        return gurbridge_wait(condition_type=condition_type, condition_value=condition_value, timeout=timeout, task_id=task_id)
    return json.dumps({"success": False, "error": "browser_wait not implemented for non-Gurbridge mode"})


def browser_get_html(task_id: Optional[str] = None) -> str:
    """Get the full HTML of the current page."""
    if _is_gurbridge_mode():
        from tools.browser_gurbridge import gurbridge_get_html
        return gurbridge_get_html(task_id=task_id)
    return json.dumps({"success": False, "error": "browser_get_html not implemented for non-Gurbridge mode"})


def browser_get_text(
    ref: str,
    task_id: Optional[str] = None,
) -> str:
    """Get the text content of an element by ref."""
    if _is_gurbridge_mode():
        from tools.browser_gurbridge import gurbridge_get_text
        return gurbridge_get_text(ref=ref, task_id=task_id)
    return json.dumps({"success": False, "error": "browser_get_text not implemented for non-Gurbridge mode"})


def browser_set_viewport(
    width: int,
    height: int,
    task_id: Optional[str] = None,
) -> str:
    """Set the browser viewport size."""
    if _is_gurbridge_mode():
        from tools.browser_gurbridge import gurbridge_set_viewport
        return gurbridge_set_viewport(width=width, height=height, task_id=task_id)
    return json.dumps({"success": False, "error": "browser_set_viewport not implemented for non-Gurbridge mode"})


def browser_screenshot_full(task_id: Optional[str] = None) -> str:
    """Take a full-page screenshot."""
    if _is_gurbridge_mode():
        from tools.browser_gurbridge import gurbridge_screenshot_full
        return gurbridge_screenshot_full(task_id=task_id)
    return json.dumps({"success": False, "error": "browser_screenshot_full not implemented for non-Gurbridge mode"})


def browser_actions(
    actions: list,
    task_id: Optional[str] = None,
) -> str:
    """Execute a batch sequence of browser actions."""
    if _is_gurbridge_mode():
        from tools.browser_gurbridge import gurbridge_actions
        return gurbridge_actions(actions=actions, task_id=task_id)
    return json.dumps({"success": False, "error": "browser_actions not implemented for non-Gurbridge mode"})

