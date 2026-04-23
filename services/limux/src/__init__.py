"""Limux socket client — JSON-RPC over Unix socket."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

DEFAULT_SOCKET = os.environ.get("LIMUX_SOCKET", "/run/user/1000/limux/limux.sock")
DEFAULT_TIMEOUT = 30.0


class LimuxError(Exception):
    def __init__(self, code: int, message: str, data: Any = None):
        self.code = code
        self.message = message
        self.data = data
        super().__init__(f"[{code}] {message}")


@dataclass
class LimuxClient:
    socket_path: str = DEFAULT_SOCKET
    timeout: float = DEFAULT_TIMEOUT
    _seq: int = field(default=0, init=False)

    def _next_id(self) -> str:
        self._seq = (self._seq + 1) % 100000
        return f"py-{uuid.uuid4().hex[:8]}-{self._seq}"

    async def _call_async(self, method: str, params: Optional[dict] = None) -> Any:
        import asyncio
        import sys

        sock_path = self.socket_path
        if not Path(sock_path).exists():
            raise FileNotFoundError(f"Limux socket not found at {sock_path}")

        request = {
            "id": self._next_id(),
            "method": method,
            "params": params or {},
        }

        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(sock_path),
            timeout=self.timeout,
        )

        try:
            payload = json.dumps(request) + "\n"
            writer.write(payload.encode())
            await writer.drain()

            line = await asyncio.wait_for(reader.readline(), timeout=self.timeout)
            if not line:
                raise ConnectionError("Limux socket closed unexpectedly")

            response = json.loads(line.decode())

            if not response.get("ok", False):
                err = response.get("error", {})
                raise LimuxError(
                    err.get("code", -1),
                    err.get("message", "Unknown error"),
                    err.get("data"),
                )

            return response.get("result", {})
        finally:
            writer.close()
            await writer.wait_closed()

    def call(self, method: str, params: Optional[dict] = None) -> Any:
        """Synchronous wrapper for _call_async."""
        try:
            loop = asyncio.get_running_loop()
            # We're in an async context — create a task
            import concurrent.futures
            with concurrent.futures.ThreadPoolExecutor() as pool:
                future = pool.submit(
                    asyncio.run,
                    self._call_async(method, params)
                )
                return future.result(timeout=self.timeout)
        except RuntimeError:
            # No running loop
            return asyncio.run(self._call_async(method, params))

    # ── System ─────────────────────────────────────────────────────────────────

    def system_ping(self) -> dict:
        return self.call("system.ping")

    def system_identify(self) -> dict:
        return self.call("system.identify")

    def system_capabilities(self) -> dict:
        return self.call("system.capabilities")

    # ── Window ─────────────────────────────────────────────────────────────────

    def window_list(self) -> list[dict]:
        return self.call("window.list")

    def window_current(self) -> dict:
        return self.call("window.current")

    def window_create(self, title: Optional[str] = None) -> dict:
        return self.call("window.create", {"title": title} if title else {})

    def window_focus(self, id: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if id is not None:
            p["id"] = id
        if ref is not None:
            p["ref"] = ref
        return self.call("window.focus", p)

    def window_close(self, id: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if id is not None:
            p["id"] = id
        if ref is not None:
            p["ref"] = ref
        return self.call("window.close", p)

    # ── Workspace ──────────────────────────────────────────────────────────────

    def workspace_list(self) -> list[dict]:
        return self.call("workspace.list")

    def workspace_current(self) -> dict:
        return self.call("workspace.current")

    def workspace_create(
        self,
        name: Optional[str] = None,
        cwd: Optional[str] = None,
        command: Optional[str] = None,
    ) -> dict:
        p = {}
        if name is not None:
            p["name"] = name
        if cwd is not None:
            p["cwd"] = cwd
        if command is not None:
            p["command"] = command
        return self.call("workspace.create", p)

    def workspace_select(self, id: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if id is not None:
            p["id"] = id
        if ref is not None:
            p["ref"] = ref
        return self.call("workspace.select", p)

    def workspace_next(self) -> dict:
        return self.call("workspace.next")

    def workspace_previous(self) -> dict:
        return self.call("workspace.previous")

    def workspace_last(self) -> dict:
        return self.call("workspace.last")

    def workspace_rename(
        self,
        title: str,
        id: Optional[int] = None,
        ref: Optional[str] = None,
    ) -> dict:
        p = {"title": title}
        if id is not None:
            p["id"] = id
        if ref is not None:
            p["ref"] = ref
        return self.call("workspace.rename", p)

    def workspace_reorder(self, positions: list[dict]) -> dict:
        return self.call("workspace.reorder", {"positions": positions})

    def workspace_close(
        self,
        id: Optional[int] = None,
        ref: Optional[str] = None,
        workspace: Optional[str] = None,
    ) -> dict:
        p = {}
        if id is not None:
            p["id"] = id
        if ref is not None:
            p["ref"] = ref
        if workspace is not None:
            p["workspace"] = workspace
        return self.call("workspace.close", p)

    def workspace_action(
        self,
        action: str,
        id: Optional[int] = None,
        ref: Optional[str] = None,
    ) -> dict:
        p = {"action": action}
        if id is not None:
            p["id"] = id
        if ref is not None:
            p["ref"] = ref
        return self.call("workspace.action", p)

    # ── Pane ───────────────────────────────────────────────────────────────────

    def pane_list(
        self,
        workspace: Optional[int] = None,
        window: Optional[int] = None,
    ) -> list[dict]:
        p = {}
        if workspace is not None:
            p["workspace"] = workspace
        if window is not None:
            p["window"] = window
        return self.call("pane.list", p)

    def pane_current(self) -> dict:
        return self.call("pane.current")

    def pane_create(
        self,
        type: str = "terminal",
        direction: str = "horizontal",
        workspace: Optional[int] = None,
        window: Optional[int] = None,
    ) -> dict:
        p = {"type": type, "direction": direction}
        if workspace is not None:
            p["workspace"] = workspace
        if window is not None:
            p["window"] = window
        return self.call("pane.create", p)

    def pane_focus(
        self,
        id: Optional[int] = None,
        ref: Optional[str] = None,
        direction: Optional[str] = None,
    ) -> dict:
        p = {}
        if id is not None:
            p["id"] = id
        if ref is not None:
            p["ref"] = ref
        if direction is not None:
            p["direction"] = direction
        return self.call("pane.focus", p)

    def pane_swap(
        self,
        source: Optional[int] = None,
        target: Optional[int] = None,
    ) -> dict:
        p = {}
        if source is not None:
            p["source"] = source
        if target is not None:
            p["target"] = target
        return self.call("pane.swap", p)

    def pane_resize(
        self,
        id: Optional[int] = None,
        ref: Optional[str] = None,
        direction: Optional[str] = None,
        size: Optional[int] = None,
    ) -> dict:
        p = {}
        if id is not None:
            p["id"] = id
        if ref is not None:
            p["ref"] = ref
        if direction is not None:
            p["direction"] = direction
        if size is not None:
            p["size"] = size
        return self.call("pane.resize", p)

    # ── Surface ────────────────────────────────────────────────────────────────

    def surface_list(self) -> list[dict]:
        return self.call("surface.list")

    def surface_current(self) -> dict:
        return self.call("surface.current")

    def surface_create(
        self,
        type: str = "terminal",
        workspace: Optional[int] = None,
        window: Optional[int] = None,
        pane: Optional[int] = None,
        cwd: Optional[str] = None,
        command: Optional[str] = None,
        url: Optional[str] = None,
    ) -> dict:
        p = {"type": type}
        if workspace is not None:
            p["workspace"] = workspace
        if window is not None:
            p["window"] = window
        if pane is not None:
            p["pane"] = pane
        if cwd is not None:
            p["cwd"] = cwd
        if command is not None:
            p["command"] = command
        if url is not None:
            p["url"] = url
        return self.call("surface.create", p)

    def surface_split(
        self,
        direction: str = "horizontal",
        type: str = "terminal",
        surface: Optional[int] = None,
        cwd: Optional[str] = None,
        command: Optional[str] = None,
        url: Optional[str] = None,
    ) -> dict:
        p = {"direction": direction, "type": type}
        if surface is not None:
            p["surface"] = surface
        if cwd is not None:
            p["cwd"] = cwd
        if command is not None:
            p["command"] = command
        if url is not None:
            p["url"] = url
        return self.call("surface.split", p)

    def surface_focus(
        self,
        id: Optional[int] = None,
        ref: Optional[str] = None,
    ) -> dict:
        p = {}
        if id is not None:
            p["id"] = id
        if ref is not None:
            p["ref"] = ref
        return self.call("surface.focus", p)

    def surface_close(
        self,
        id: Optional[int] = None,
        ref: Optional[str] = None,
    ) -> dict:
        p = {}
        if id is not None:
            p["id"] = id
        if ref is not None:
            p["ref"] = ref
        return self.call("surface.close", p)

    def surface_send_text(
        self,
        text: str,
        surface_id: Optional[str] = None,
    ) -> dict:
        p = {"text": text}
        if surface_id is not None:
            p["surface_id"] = surface_id
        return self.call("surface.send_text", p)

    def surface_read_text(
        self,
        surface_id: Optional[str] = None,
    ) -> dict:
        p = {}
        if surface_id is not None:
            p["surface_id"] = surface_id
        return self.call("surface.read_text", p)

    def surface_screenshot(
        self,
        surface_id: Optional[str] = None,
    ) -> dict:
        """Capture terminal pane screenshot as base64 PNG.

        Returns:
            dict with 'ok' and 'screenshot' (base64 PNG) or 'text' (fallback OCR).
        """
        p = {}
        if surface_id is not None:
            p["surface_id"] = surface_id
        return self.call("surface.screenshot", p)

    def surface_send_key(
        self,
        key: str,
        surface_id: Optional[str] = None,
    ) -> dict:
        p = {"key": key}
        if surface_id is not None:
            p["surface_id"] = surface_id
        return self.call("surface.send_key", p)

    def surface_clear_history(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("surface.clear_history", p)

    def surface_health(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("surface.health", p)

    # ── Browser ───────────────────────────────────────────────────────────────

    def browser_open_split(self, url: str, **kwargs) -> dict:
        p = {"url": url, **kwargs}
        return self.call("browser.open_split", p)

    def browser_navigate(self, url: str, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {"url": url}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.navigate", p)

    def browser_url_get(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.url.get", p)

    def browser_snapshot(
        self,
        surface: Optional[int] = None,
        ref: Optional[str] = None,
        full: bool = False,
    ) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        if full:
            p["full"] = full
        return self.call("browser.snapshot", p)

    def browser_click(
        self,
        ref: str,
        surface: Optional[int] = None,
        button: str = "left",
    ) -> dict:
        p = {"ref": ref, "button": button}
        if surface is not None:
            p["surface"] = surface
        return self.call("browser.click", p)

    def browser_type(
        self,
        ref: str,
        text: str,
        surface: Optional[int] = None,
        press_enter: bool = True,
    ) -> dict:
        p = {"ref": ref, "text": text, "press_enter": press_enter}
        if surface is not None:
            p["surface"] = surface
        return self.call("browser.type", p)

    def browser_fill(
        self,
        ref: str,
        text: str,
        surface: Optional[int] = None,
    ) -> dict:
        p = {"ref": ref, "text": text}
        if surface is not None:
            p["surface"] = surface
        return self.call("browser.fill", p)

    def browser_press(self, key: str, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {"key": key}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.press", p)

    def browser_get_text(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.get.text", p)

    def browser_get_value(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.get.value", p)

    def browser_get_title(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.get.title", p)

    def browser_back(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.back", p)

    def browser_forward(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.forward", p)

    def browser_reload(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.reload", p)

    def browser_focus_webview(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.focus_webview", p)

    def browser_is_webview_focused(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.is_webview_focused", p)

    def browser_screenshot(
        self,
        surface: Optional[int] = None,
        ref: Optional[str] = None,
        path: Optional[str] = None,
    ) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        if path is not None:
            p["path"] = path
        return self.call("browser.screenshot", p)

    def browser_scroll(
        self,
        direction: str,
        surface: Optional[int] = None,
        ref: Optional[str] = None,
    ) -> dict:
        p = {"direction": direction}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.scroll", p)

    def browser_find_text(
        self,
        text: str,
        surface: Optional[int] = None,
        ref: Optional[str] = None,
        **kwargs,
    ) -> dict:
        p = {"text": text, **kwargs}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.find.text", p)

    def browser_console_clear(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.console.clear", p)

    def browser_console_list(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.console.list", p)

    def browser_tab_list(self, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.tab.list", p)

    def browser_tab_new(self, url: str, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {"url": url}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.tab.new", p)

    def browser_tab_close(self, id: Optional[int] = None, surface: Optional[int] = None, ref: Optional[str] = None) -> dict:
        p = {}
        if id is not None:
            p["id"] = id
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.tab.close", p)

    def browser_eval(
        self,
        script: str,
        surface: Optional[int] = None,
        ref: Optional[str] = None,
    ) -> dict:
        p = {"script": script}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.eval", p)

    def browser_wait(
        self,
        ms: int,
        surface: Optional[int] = None,
        ref: Optional[str] = None,
    ) -> dict:
        p = {"ms": ms}
        if surface is not None:
            p["surface"] = surface
        if ref is not None:
            p["ref"] = ref
        return self.call("browser.wait", p)

    # ── Notification ───────────────────────────────────────────────────────────

    def notification_create(
        self,
        message: str,
        title: str = "",
        body: str = "",
        **kwargs,
    ) -> dict:
        p = {"message": message, "title": title, "body": body, **kwargs}
        return self.call("notification.create", p)

    def notification_clear(self, id: Optional[int] = None) -> dict:
        p = {}
        if id is not None:
            p["id"] = id
        return self.call("notification.clear", p)
