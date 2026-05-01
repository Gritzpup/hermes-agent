"""
``browser_activate_tab`` — point Hermes at a chromium tab that gurbridge has
adopted via raw CDP.

Once activated, the state-reading browser tools (console, snapshot,
screenshot, vision) route through gurbridge's REST API for that pane —
which already routes through CDP for adopted tabs and keeps the gurbridge
UI / visor / network log in sync.  Input tools (scroll, click, press,
type) route through direct CDP for low latency (Phase 2).

Activation is keyed by ``task_id`` and cleared automatically by
``browser_navigate`` so a fresh navigation falls back to the legacy
playwright session.

Either ``pane_id`` (preferred) or ``target_id`` may be passed; the tool
resolves the missing field by querying gurbridge's ``/api/panes`` (which
now includes ``_cdpTargetId``).
"""
from __future__ import annotations

import json
import logging
from typing import Any, Dict, Optional

from tools.registry import registry, tool_error
from tools.browser_active_target import (
    GurbridgeNotFound,
    GurbridgeUnavailable,
    find_pane_by_id,
    find_pane_by_target,
    gb_post,
    is_gurbridge_reachable,
    set_active,
)

logger = logging.getLogger(__name__)


def browser_activate_tab(
    pane_id: Optional[str] = None,
    target_id: Optional[str] = None,
    task_id: Optional[str] = None,
) -> str:
    if not pane_id and not target_id:
        return tool_error("Must pass either 'pane_id' or 'target_id' (or both).")

    # --- Resolve missing field via /api/panes -------------------------------
    try:
        if pane_id and not target_id:
            pane = find_pane_by_id(pane_id)
            if pane is None:
                return tool_error(f"No gurbridge pane with id={pane_id!r}.")
            target_id = pane.get("_cdpTargetId")
            if not target_id:
                return tool_error(
                    f"Pane {pane_id} is a Playwright-managed pane, not a "
                    f"CDP-adopted external tab. Activation is only supported "
                    f"for adopted tabs (those originate from chromium and have "
                    f"a _cdpTargetId)."
                )
        elif target_id and not pane_id:
            pane = find_pane_by_target(target_id)
            if pane is None:
                return tool_error(
                    f"No gurbridge pane is currently adopting target_id={target_id!r}. "
                    f"Either gurbridge isn't running, the tab was just opened "
                    f"(reconcile runs every few seconds), or the target_id is stale."
                )
            pane_id = pane.get("id")
        else:
            # Both passed — verify they agree.
            pane = find_pane_by_id(pane_id)
            if pane is None or pane.get("_cdpTargetId") != target_id:
                return tool_error(
                    f"pane_id={pane_id!r} and target_id={target_id!r} do not "
                    f"refer to the same gurbridge pane."
                )
    except GurbridgeUnavailable as exc:
        return tool_error(
            f"Gurbridge is unreachable: {exc}. Activation requires gurbridge "
            f"running on GURBRIDGE_BASE_URL (default http://127.0.0.1:3001)."
        )

    # --- Tell gurbridge UI to make THIS pane the visible one (across-pane
    # focus, not within-pane tab focus). Without this, Hermes binds its
    # tools to pane X but the user is watching pane Y — symptom is
    # "vision/UI shows the wrong tab".
    try:
        gb_post(f"/hermes/browser/{pane_id}/activate-pane")
    except GurbridgeNotFound:
        return tool_error(
            f"Pane {pane_id} disappeared between resolution and activation. Retry."
        )
    except GurbridgeUnavailable as exc:
        # Non-fatal: the activation still works for tool routing; only the
        # UI focus side-effect failed.
        logger.warning("[activate-tab] UI switch failed (non-fatal): %s", exc)

    set_active(task_id or "default", pane_id=pane_id, target_id=target_id)

    payload: Dict[str, Any] = {
        "success": True,
        "pane_id": pane_id,
        "target_id": target_id,
        "task_id": task_id or "default",
        "note": (
            "State-reading browser tools (console, snapshot, screenshot, "
            "vision) now route through gurbridge for this pane. Calling "
            "browser_navigate clears activation."
        ),
    }
    return json.dumps(payload, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Schema + registration
# ---------------------------------------------------------------------------


BROWSER_ACTIVATE_TAB_SCHEMA: Dict[str, Any] = {
    "name": "browser_activate_tab",
    "description": (
        "Bind subsequent browser tool calls to a specific chromium tab that "
        "gurbridge has adopted via raw CDP. Use when the user has multiple "
        "tabs open in their gurbridge UI and you want to drive one of them "
        "(read its DOM, take a screenshot, run console JS, scroll it, etc.) "
        "instead of Hermes's own playwright-managed session.\n\n"
        "Pass either 'pane_id' (gurbridge UI's pane id, preferred) OR "
        "'target_id' (chromium CDP targetId from `Target.getTargets`). The "
        "tool resolves the other field automatically.\n\n"
        "Side effects:\n"
        "- Subsequent browser_console / browser_snapshot / browser_screenshot "
        "/ browser_vision calls hit gurbridge for this pane.\n"
        "- The gurbridge UI focuses this pane visually.\n"
        "- A subsequent browser_navigate clears activation; the legacy "
        "playwright path takes over for the next call."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "pane_id": {
                "type": "string",
                "description": (
                    "Gurbridge BrowserPane id (UUID). Preferred. Get from "
                    "the gurbridge UI or by calling its /api/panes endpoint."
                ),
            },
            "target_id": {
                "type": "string",
                "description": (
                    "Chromium CDP targetId. Useful when you found the tab via "
                    "browser_cdp(method='Target.getTargets')."
                ),
            },
        },
        "required": [],
    },
}


def _browser_activate_tab_check() -> bool:
    """Only offer the tool when gurbridge is reachable."""
    return is_gurbridge_reachable()


registry.register(
    name="browser_activate_tab",
    toolset="browser-gurbridge-routing",
    schema=BROWSER_ACTIVATE_TAB_SCHEMA,
    handler=lambda args, **kw: browser_activate_tab(
        pane_id=args.get("pane_id"),
        target_id=args.get("target_id"),
        task_id=kw.get("task_id"),
    ),
    check_fn=_browser_activate_tab_check,
)
