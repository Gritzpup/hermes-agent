"""Unit tests for the active-target store + browser_activate_tab tool."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from tools import browser_active_target as bat


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    # Tests don't have a real gurbridge to connect to — disable the
    # background socket.io subscriber so we don't spam reconnect logs.
    monkeypatch.setenv("HERMES_DISABLE_GURBRIDGE_SUBSCRIBER", "1")
    bat.clear_all()
    yield
    bat.clear_all()


def test_set_get_clear_roundtrip():
    assert bat.get_active("t1") is None
    bat.set_active("t1", pane_id="P1", target_id="T1")
    got = bat.get_active("t1")
    assert got is not None
    assert got.pane_id == "P1"
    assert got.target_id == "T1"
    bat.clear_active("t1")
    assert bat.get_active("t1") is None


def test_default_task_when_none():
    bat.set_active("default", pane_id="P", target_id="T")
    assert bat.get_active(None).pane_id == "P"


def test_isolation_between_tasks():
    bat.set_active("a", pane_id="PA", target_id="TA")
    bat.set_active("b", pane_id="PB", target_id="TB")
    assert bat.get_active("a").pane_id == "PA"
    assert bat.get_active("b").pane_id == "PB"
    bat.clear_active("a")
    assert bat.get_active("a") is None
    assert bat.get_active("b").pane_id == "PB"


def test_gurbridge_base_url_env_override(monkeypatch):
    monkeypatch.setenv("GURBRIDGE_BASE_URL", "http://example.test:9999")
    assert bat.gurbridge_base_url() == "http://example.test:9999"


def test_gurbridge_base_url_default(monkeypatch):
    monkeypatch.delenv("GURBRIDGE_BASE_URL", raising=False)
    assert bat.gurbridge_base_url() == "http://127.0.0.1:3001"


def test_find_pane_by_target():
    fake_panes = {"browsers": [
        {"id": "P1", "name": "n", "_cdpTargetId": "T1"},
        {"id": "P2", "name": "n"},  # playwright pane, no targetId
        {"id": "P3", "name": "n", "_cdpTargetId": "T3"},
    ]}
    with patch.object(bat, "gb_get", return_value=fake_panes):
        assert bat.find_pane_by_target("T3")["id"] == "P3"
        assert bat.find_pane_by_target("missing") is None


def test_console_routes_to_gurbridge_when_active():
    from tools import browser_tool

    bat.set_active("t1", pane_id="P1", target_id="T1")
    fake = {"console_messages": [{"type": "log", "text": "hi"}], "js_errors": []}
    with patch.object(browser_tool, "gb_post", return_value=fake) as mock_post:
        out = browser_tool.browser_console(task_id="t1")
    mock_post.assert_called_once()
    assert "/hermes/browser/P1/console" in mock_post.call_args[0][0]
    import json
    parsed = json.loads(out)
    assert parsed["via"] == "gurbridge"
    assert parsed["pane_id"] == "P1"
    assert parsed["console_messages"][0]["text"] == "hi"


def test_console_clears_active_on_404():
    from tools import browser_tool

    bat.set_active("t1", pane_id="P1", target_id="T1")
    with patch.object(browser_tool, "gb_post", side_effect=bat.GurbridgeNotFound("404")), \
         patch.object(browser_tool, "_run_browser_command", return_value={"success": True, "data": {"messages": []}}), \
         patch.object(browser_tool, "_is_camofox_mode", return_value=False), \
         patch.object(browser_tool, "_last_session_key", return_value="t1"):
        browser_tool.browser_console(task_id="t1")
    # The 404 should have evicted the active target so the next call falls through cleanly.
    assert bat.get_active("t1") is None


def test_scroll_routes_to_gurbridge_when_active():
    from tools import browser_tool

    bat.set_active("t1", pane_id="P1", target_id="T1")
    with patch.object(browser_tool, "gb_post", return_value={}) as mock_post:
        out = browser_tool.browser_scroll("down", task_id="t1")
    args, _ = mock_post.call_args
    body = mock_post.call_args[0][1]
    assert "/hermes/browser/P1/scroll" in args[0]
    assert body["deltaY"] == 500
    import json
    assert json.loads(out)["via"] == "gurbridge"


def test_click_routes_to_gurbridge_with_at_prefix():
    from tools import browser_tool

    bat.set_active("t1", pane_id="P1", target_id="T1")
    with patch.object(browser_tool, "gb_post", return_value={}) as mock_post:
        browser_tool.browser_click("e5", task_id="t1")  # no @
    body = mock_post.call_args[0][1]
    assert body["ref"] == "@e5"


def test_snapshot_routes_to_gurbridge_when_active():
    from tools import browser_tool

    bat.set_active("t1", pane_id="P1", target_id="T1")
    fake = {"text": "page text", "elements": [{}, {}, {}], "url": "u", "title": "t"}
    with patch.object(browser_tool, "gb_get", return_value=fake):
        out = browser_tool.browser_snapshot(task_id="t1")
    import json
    parsed = json.loads(out)
    assert parsed["via"] == "gurbridge"
    assert parsed["element_count"] == 3
    assert parsed["snapshot"] == "page text"


def test_subscriber_evicts_dead_pane():
    """Simulate a pane:list:changed event after the pane is gone — eviction lands."""
    bat.set_active("t1", pane_id="GONE", target_id="T1")
    sub = bat._GurbridgeSubscriber.__new__(bat._GurbridgeSubscriber)
    sub._sio = None  # we don't need a real client for this unit test
    sub._connected = True

    fake_panes = {"browsers": [{"id": "STILL_HERE"}]}  # GONE not present
    with patch.object(bat, "gb_get", return_value=fake_panes):
        sub._evict_dead()
    assert bat.get_active("t1") is None


def test_subscriber_keeps_live_pane():
    bat.set_active("t1", pane_id="P1", target_id="T1")
    sub = bat._GurbridgeSubscriber.__new__(bat._GurbridgeSubscriber)
    sub._sio = None
    sub._connected = True

    fake_panes = {"browsers": [{"id": "P1"}]}
    with patch.object(bat, "gb_get", return_value=fake_panes):
        sub._evict_dead()
    assert bat.get_active("t1") is not None


def test_subscriber_skips_eviction_when_panes_unreachable():
    bat.set_active("t1", pane_id="P1", target_id="T1")
    sub = bat._GurbridgeSubscriber.__new__(bat._GurbridgeSubscriber)
    sub._sio = None
    sub._connected = True

    with patch.object(bat, "gb_get", side_effect=bat.GurbridgeUnavailable("net")):
        sub._evict_dead()
    # Network blip must NOT evict — otherwise a transient gurbridge restart
    # would silently disable activation for every running task.
    assert bat.get_active("t1") is not None


def test_config_yaml_fallback_when_no_env(monkeypatch):
    monkeypatch.delenv("GURBRIDGE_BASE_URL", raising=False)
    with patch("hermes_cli.config.cfg_get", return_value="http://config.example:5555"):
        assert bat.gurbridge_base_url() == "http://config.example:5555"


def test_activate_clears_on_navigate():
    """browser_navigate must clear the active target — verified via direct call."""
    from tools import browser_tool

    bat.set_active("t1", pane_id="P1", target_id="T1")
    assert bat.get_active("t1") is not None

    # Patch out the heavy parts of navigate: SSRF, command exec, etc.
    # We only care that the very first line clears active target.
    with patch.object(browser_tool, "_run_browser_command", return_value={"success": False, "error": "stub"}), \
         patch.object(browser_tool, "_get_session_info", return_value={"_first_nav": False}), \
         patch.object(browser_tool, "_navigation_session_key", return_value="t1"), \
         patch.object(browser_tool, "_is_local_sidecar_key", return_value=False), \
         patch.object(browser_tool, "_is_camofox_mode", return_value=False), \
         patch.object(browser_tool, "_is_local_backend", return_value=True):
        browser_tool.browser_navigate("https://example.com", task_id="t1")

    assert bat.get_active("t1") is None
