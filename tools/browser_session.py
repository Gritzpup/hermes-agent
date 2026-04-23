"""Browser session management — creation, lifecycle, cleanup, and orphan reaping."""

import atexit
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from typing import Dict, Any, Optional

import tools.browser_state as browser_state
from tools.browser_utils import (
    _get_cdp_override,
    _get_cloud_provider,
    _socket_safe_tmpdir,
    _merge_browser_path,
    _browser_install_hint,
    _requires_real_termux_browser_install,
    _termux_browser_install_error,
    _get_command_timeout,
    _allow_private_urls,
    _discover_homebrew_node_dirs,
    _is_local_backend,
    _is_local_mode,
    logger,
)

_active_sessions = browser_state.active_sessions
_recording_sessions = browser_state.recording_sessions
_session_last_activity = browser_state.session_last_activity
_cleanup_lock = browser_state.cleanup_lock


# =============================================================================
# Inactivity Timeout Configuration
# =============================================================================

# Session inactivity timeout (seconds) - cleanup if no activity for this long
# Default: 5 minutes. Needs headroom for LLM reasoning between browser commands,
# especially when subagents are doing multi-step browser tasks.
BROWSER_SESSION_INACTIVITY_TIMEOUT = int(os.environ.get("BROWSER_INACTIVITY_TIMEOUT", "300"))

# Track last activity time per session

# Background cleanup thread state
# (subagents run concurrently via ThreadPoolExecutor)


def _emergency_cleanup_all_sessions():
    """
    Emergency cleanup of all active browser sessions.
    Called on process exit or interrupt to prevent orphaned sessions.

    Also runs the orphan reaper to clean up daemons left behind by previously
    crashed hermes processes — this way every clean hermes exit sweeps
    accumulated orphans, not just ones that actively used the browser tool.
    """
    if browser_state.cleanup_done:
        return
    browser_state.cleanup_done = True

    # Clean up this process's own sessions first, so their owner_pid files
    # are removed before the reaper scans.
    if _active_sessions:
        logger.info("Emergency cleanup: closing %s active session(s)...",
                    len(_active_sessions))
        try:
            cleanup_all_browsers()
        except Exception as e:
            logger.error("Emergency cleanup error: %s", e)
        finally:
            with _cleanup_lock:
                _active_sessions.clear()
                _session_last_activity.clear()
                _recording_sessions.clear()

    # Sweep orphans from other crashed hermes processes.  Safe even if we
    # never used the browser — uses owner_pid liveness to avoid reaping
    # daemons owned by other live hermes processes.
    try:
        _reap_orphaned_browser_sessions()
    except Exception as e:
        logger.debug("Orphan reap on exit failed: %s", e)


# Register cleanup via atexit only.  Previous versions installed SIGINT/SIGTERM
# handlers that called sys.exit(), but this conflicts with prompt_toolkit's
# async event loop — a SystemExit raised inside a key-binding callback
# corrupts the coroutine state and makes the process unkillable.  atexit
# handlers run on any normal exit (including sys.exit), so browser sessions
# are still cleaned up without hijacking signals.
atexit.register(_emergency_cleanup_all_sessions)


# =============================================================================
# Inactivity Cleanup Functions
# =============================================================================

def _cleanup_inactive_browser_sessions():
    """
    Clean up browser sessions that have been inactive for longer than the timeout.
    
    This function is called periodically by the background cleanup thread to
    automatically close sessions that haven't been used recently, preventing
    orphaned sessions (local or Browserbase) from accumulating.
    """
    current_time = time.time()
    sessions_to_cleanup = []
    
    with _cleanup_lock:
        for task_id, last_time in list(_session_last_activity.items()):
            if current_time - last_time > BROWSER_SESSION_INACTIVITY_TIMEOUT:
                sessions_to_cleanup.append(task_id)
    
    for task_id in sessions_to_cleanup:
        try:
            elapsed = int(current_time - _session_last_activity.get(task_id, current_time))
            logger.info("Cleaning up inactive session for task: %s (inactive for %ss)", task_id, elapsed)
            cleanup_browser(task_id)
            with _cleanup_lock:
                if task_id in _session_last_activity:
                    del _session_last_activity[task_id]
        except Exception as e:
            logger.warning("Error cleaning up inactive session %s: %s", task_id, e)


def _write_owner_pid(socket_dir: str, session_name: str) -> None:
    """Record the current hermes PID as the owner of a browser socket dir.

    Written atomically to ``<socket_dir>/<session_name>.owner_pid`` so the
    orphan reaper can distinguish daemons owned by a live hermes process
    (don't reap) from daemons whose owner crashed (reap).  Best-effort —
    an OSError here just falls back to the legacy ``tracked_names``
    heuristic in the reaper.
    """
    try:
        path = os.path.join(socket_dir, f"{session_name}.owner_pid")
        with open(path, "w") as f:
            f.write(str(os.getpid()))
    except OSError as exc:
        logger.debug("Could not write owner_pid file for %s: %s",
                     session_name, exc)


def _reap_orphaned_browser_sessions():
    """Scan for orphaned agent-browser daemon processes from previous runs.

    When the Python process that created a browser session exits uncleanly
    (SIGKILL, crash, gateway restart), the in-memory ``_active_sessions``
    tracking is lost but the node + Chromium processes keep running.

    This function scans the tmp directory for ``agent-browser-*`` socket dirs
    left behind by previous runs, reads the daemon PID files, and kills any
    daemons whose owning hermes process is no longer alive.

    Ownership detection priority:
      1. ``<session>.owner_pid`` file (written by current code) — if the
         referenced hermes PID is alive, leave the daemon alone regardless
         of whether it's in *this* process's ``_active_sessions``.  This is
         cross-process safe: two concurrent hermes instances won't reap each
         other's daemons.
      2. Fallback for daemons that predate owner_pid: check
         ``_active_sessions`` in the current process.  If not tracked here,
         treat as orphan (legacy behavior).

    Safe to call from any context — atexit, cleanup thread, or on demand.
    """
    import glob

    tmpdir = _socket_safe_tmpdir()
    pattern = os.path.join(tmpdir, "agent-browser-h_*")
    socket_dirs = glob.glob(pattern)
    # Also pick up CDP sessions
    socket_dirs += glob.glob(os.path.join(tmpdir, "agent-browser-cdp_*"))
    # Also pick up cloud-provider sessions (browser-use/browserbase/firecrawl)
    socket_dirs += glob.glob(os.path.join(tmpdir, "agent-browser-hermes_*"))

    if not socket_dirs:
        return

    # Build set of session_names currently tracked by this process (fallback path)
    with _cleanup_lock:
        tracked_names = {
            info.get("session_name")
            for info in _active_sessions.values()
            if info.get("session_name")
        }

    reaped = 0
    for socket_dir in socket_dirs:
        dir_name = os.path.basename(socket_dir)
        # dir_name is "agent-browser-{session_name}"
        session_name = dir_name.removeprefix("agent-browser-")
        if not session_name:
            continue

        # Ownership check: prefer owner_pid file (cross-process safe).
        owner_pid_file = os.path.join(socket_dir, f"{session_name}.owner_pid")
        owner_alive: Optional[bool] = None  # None = owner_pid missing/unreadable
        if os.path.isfile(owner_pid_file):
            try:
                owner_pid = int(Path(owner_pid_file).read_text().strip())
                try:
                    os.kill(owner_pid, 0)
                    owner_alive = True
                except ProcessLookupError:
                    owner_alive = False
                except PermissionError:
                    # Owner exists but we can't signal it (different uid).
                    # Treat as alive — don't reap someone else's session.
                    owner_alive = True
            except (ValueError, OSError):
                owner_alive = None  # corrupt file — fall through

        if owner_alive is True:
            # Owner is alive — this session belongs to a live hermes process.
            continue

        if owner_alive is None:
            # No owner_pid file (legacy daemon).  Fall back to in-process
            # tracking: if this process knows about the session, leave alone.
            if session_name in tracked_names:
                continue

        # owner_alive is False (dead owner) OR legacy daemon not tracked here.
        pid_file = os.path.join(socket_dir, f"{session_name}.pid")
        if not os.path.isfile(pid_file):
            # No daemon PID file — just a stale dir, remove it
            shutil.rmtree(socket_dir, ignore_errors=True)
            continue

        try:
            daemon_pid = int(Path(pid_file).read_text().strip())
        except (ValueError, OSError):
            shutil.rmtree(socket_dir, ignore_errors=True)
            continue

        # Check if the daemon is still alive
        try:
            os.kill(daemon_pid, 0)  # signal 0 = existence check
        except ProcessLookupError:
            # Already dead, just clean up the dir
            shutil.rmtree(socket_dir, ignore_errors=True)
            continue
        except PermissionError:
            # Alive but owned by someone else — leave it alone
            continue

        # Daemon is alive and its owner is dead (or legacy + untracked).  Reap.
        try:
            os.kill(daemon_pid, signal.SIGTERM)
            logger.info("Reaped orphaned browser daemon PID %d (session %s)",
                        daemon_pid, session_name)
            reaped += 1
        except (ProcessLookupError, PermissionError, OSError):
            pass

        # Clean up the socket directory
        shutil.rmtree(socket_dir, ignore_errors=True)

    if reaped:
        logger.info("Reaped %d orphaned browser session(s) from previous run(s)", reaped)


def _browser_cleanup_thread_worker():
    """
    Background thread that periodically cleans up inactive browser sessions.
    
    Runs every 30 seconds and checks for sessions that haven't been used
    within the BROWSER_SESSION_INACTIVITY_TIMEOUT period.
    On first run, also reaps orphaned sessions from previous process lifetimes.
    """
    # One-time orphan reap on startup
    try:
        _reap_orphaned_browser_sessions()
    except Exception as e:
        logger.warning("Orphan reap error: %s", e)

    while browser_state.cleanup_running:
        try:
            _cleanup_inactive_browser_sessions()
        except Exception as e:
            logger.warning("Cleanup thread error: %s", e)
        
        # Sleep in 1-second intervals so we can stop quickly if needed
        for _ in range(30):
            if not browser_state.cleanup_running:
                break
            time.sleep(1)


def _start_browser_cleanup_thread():
    """Start the background cleanup thread if not already running."""
    
    with _cleanup_lock:
        if browser_state.cleanup_thread is None or not browser_state.cleanup_thread.is_alive():
            browser_state.cleanup_running = True
            browser_state.cleanup_thread = threading.Thread(
                target=_browser_cleanup_thread_worker,
                daemon=True,
                name="browser-cleanup"
            )
            browser_state.cleanup_thread.start()
            logger.info("Started inactivity cleanup thread (timeout: %ss)", BROWSER_SESSION_INACTIVITY_TIMEOUT)


def _stop_browser_cleanup_thread():
    """Stop the background cleanup thread."""
    browser_state.cleanup_running = False
    if browser_state.cleanup_thread is not None:
        browser_state.cleanup_thread.join(timeout=5)


def _update_session_activity(task_id: str):
    """Update the last activity timestamp for a session."""
    with _cleanup_lock:
        _session_last_activity[task_id] = time.time()


# Register cleanup thread stop on exit
atexit.register(_stop_browser_cleanup_thread)


def _create_local_session(task_id: str) -> Dict[str, str]:
    import uuid
    session_name = f"h_{uuid.uuid4().hex[:10]}"
    logger.info("Created local browser session %s for task %s",
                session_name, task_id)
    return {
        "session_name": session_name,
        "bb_session_id": None,
        "cdp_url": None,
        "features": {"local": True},
    }


def _create_cdp_session(task_id: str, cdp_url: str) -> Dict[str, str]:
    """Create a session that connects to a user-supplied CDP endpoint."""
    import uuid
    session_name = f"cdp_{uuid.uuid4().hex[:10]}"
    logger.info("Created CDP browser session %s → %s for task %s",
                session_name, cdp_url, task_id)
    return {
        "session_name": session_name,
        "bb_session_id": None,
        "cdp_url": cdp_url,
        "features": {"cdp_override": True},
    }


def _get_session_info(task_id: Optional[str] = None) -> Dict[str, str]:
    """
    Get or create session info for the given task.
    
    In cloud mode, creates a Browserbase session with proxies enabled.
    In local mode, generates a session name for agent-browser --session.
    Also starts the inactivity cleanup thread and updates activity tracking.
    Thread-safe: multiple subagents can call this concurrently.
    
    Args:
        task_id: Unique identifier for the task
        
    Returns:
        Dict with session_name (always), bb_session_id + cdp_url (cloud only)
    """
    if task_id is None:
        task_id = "default"
    
    # Start the cleanup thread if not running (handles inactivity timeouts)
    _start_browser_cleanup_thread()
    
    # Update activity timestamp for this session
    _update_session_activity(task_id)
    
    with _cleanup_lock:
        # Check if we already have a session for this task
        if task_id in _active_sessions:
            return _active_sessions[task_id]
    
    # Create session outside the lock (network call in cloud mode)
    cdp_override = _get_cdp_override()
    if cdp_override:
        session_info = _create_cdp_session(task_id, cdp_override)
    else:
        provider = _get_cloud_provider()
        if provider is None:
            session_info = _create_local_session(task_id)
        else:
            try:
                session_info = provider.create_session(task_id)
                # Validate cloud provider returned a usable session
                if not session_info or not isinstance(session_info, dict):
                    raise ValueError(f"Cloud provider returned invalid session: {session_info!r}")
                if session_info.get("cdp_url"):
                    # Some cloud providers (including Browser-Use v3) return an HTTP
                    # CDP discovery URL instead of a raw websocket endpoint.
                    session_info = dict(session_info)
                    session_info["cdp_url"] = _resolve_cdp_override(str(session_info["cdp_url"]))
            except Exception as e:
                provider_name = type(provider).__name__
                logger.warning(
                    "Cloud provider %s failed (%s); attempting fallback to local "
                    "Chromium for task %s",
                    provider_name, e, task_id,
                    exc_info=True,
                )
                try:
                    session_info = _create_local_session(task_id)
                except Exception as local_error:
                    raise RuntimeError(
                        f"Cloud provider {provider_name} failed ({e}) and local "
                        f"fallback also failed ({local_error})"
                    ) from e
                # Mark session as degraded for observability
                if isinstance(session_info, dict):
                    session_info = dict(session_info)
                    session_info["fallback_from_cloud"] = True
                    session_info["fallback_reason"] = str(e)
                    session_info["fallback_provider"] = provider_name
    
    with _cleanup_lock:
        # Double-check: another thread may have created a session while we
        # were doing the network call. Use the existing one to avoid leaking
        # orphan cloud sessions.
        if task_id in _active_sessions:
            return _active_sessions[task_id]
        _active_sessions[task_id] = session_info
    
    return session_info



def cleanup_browser(task_id: Optional[str] = None) -> None:
    """
    Clean up browser session for a task.
    
    Called automatically when a task completes or when inactivity timeout is reached.
    Closes both the agent-browser/Browserbase session and Camofox sessions.
    
    Args:
        task_id: Task identifier to clean up
    """
    if task_id is None:
        task_id = "default"
    
    # Also clean up Camofox session if running in Camofox mode.
    # Skip full close when managed persistence is enabled — the browser
    # profile (and its session cookies) must survive across agent tasks.
    # The inactivity reaper still frees idle resources.
    if _is_gurbridge_mode():
        try:
            from tools.browser_gurbridge import gurbridge_soft_cleanup
            if gurbridge_soft_cleanup(task_id):
                return
            from tools.browser_gurbridge import gurbridge_close
            gurbridge_close(task_id)
            return
        except Exception:
            pass

    if _is_camofox_mode():
        try:
            from tools.browser_camofox import camofox_close, camofox_soft_cleanup
            if not camofox_soft_cleanup(task_id):
                camofox_close(task_id)
        except Exception as e:
            logger.debug("Camofox cleanup for task %s: %s", task_id, e)

    logger.debug("cleanup_browser called for task_id: %s", task_id)
    logger.debug("Active sessions: %s", list(_active_sessions.keys()))
    
    # Check if session exists (under lock), but don't remove yet -
    # _run_browser_command needs it to build the close command.
    with _cleanup_lock:
        session_info = _active_sessions.get(task_id)
    
    if session_info:
        bb_session_id = session_info.get("bb_session_id", "unknown")
        logger.debug("Found session for task %s: bb_session_id=%s", task_id, bb_session_id)
        
        # Stop auto-recording before closing (saves the file)
        _maybe_stop_recording(task_id)
        
        # Try to close via agent-browser first (needs session in _active_sessions)
        try:
            _run_browser_command(task_id, "close", [], timeout=10)
            logger.debug("agent-browser close command completed for task %s", task_id)
        except Exception as e:
            logger.warning("agent-browser close failed for task %s: %s", task_id, e)
        
        # Now remove from tracking under lock
        with _cleanup_lock:
            _active_sessions.pop(task_id, None)
            _session_last_activity.pop(task_id, None)
        
        # Cloud mode: close the cloud browser session via provider API
        if bb_session_id:
            provider = _get_cloud_provider()
            if provider is not None:
                try:
                    provider.close_session(bb_session_id)
                except Exception as e:
                    logger.warning("Could not close cloud browser session: %s", e)
        
        # Kill the daemon process and clean up socket directory
        session_name = session_info.get("session_name", "")
        if session_name:
            socket_dir = os.path.join(_socket_safe_tmpdir(), f"agent-browser-{session_name}")
            if os.path.exists(socket_dir):
                # agent-browser writes {session}.pid in the socket dir
                pid_file = os.path.join(socket_dir, f"{session_name}.pid")
                if os.path.isfile(pid_file):
                    try:
                        daemon_pid = int(Path(pid_file).read_text().strip())
                        os.kill(daemon_pid, signal.SIGTERM)
                        logger.debug("Killed daemon pid %s for %s", daemon_pid, session_name)
                    except (ProcessLookupError, ValueError, PermissionError, OSError):
                        logger.debug("Could not kill daemon pid for %s (already dead or inaccessible)", session_name)
                shutil.rmtree(socket_dir, ignore_errors=True)
        
        logger.debug("Removed task %s from active sessions", task_id)
    else:
        logger.debug("No active session found for task_id: %s", task_id)


def cleanup_all_browsers() -> None:
    """
    Clean up all active browser sessions.
    
    Useful for cleanup on shutdown.
    """
    with _cleanup_lock:
        task_ids = list(_active_sessions.keys())
    for task_id in task_ids:
        cleanup_browser(task_id)

    # Reset cached lookups so they are re-evaluated on next use.
    global _cached_agent_browser, _agent_browser_resolved
    global _cached_command_timeout, _command_timeout_resolved
    _cached_agent_browser = None
    _agent_browser_resolved = False
    _discover_homebrew_node_dirs.cache_clear()
    _cached_command_timeout = None
    _command_timeout_resolved = False


# ============================================================================
# Requirements Check
# ============================================================================