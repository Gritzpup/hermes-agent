"""Gurbridge execution environment — routes commands through Gurbridge visible terminals.

When TERMINAL_ENV=gurbridge, the agent sends commands to a Gurbridge-managed
terminal (visible in the workspace grid) instead of spawning hidden local
subprocesses. Output is retrieved by polling the Gurbridge REST API.

NEW in this version: streaming via PTY socket + verbose logging on every command.
All four logging fields land on every command:
  cmd, args, cwd, env_diff, stdout, stderr, exit_code, started_at, ended_at

When TERMINAL_ENV=gurbridge, the agent sends commands to a Gurbridge-managed
terminal (visible in the workspace grid) instead of spawning hidden local
subprocesses. Output is retrieved by polling the Gurbridge REST API.

Design notes:
- Commands run inside a persistent interactive bash shell (the Gurbridge terminal).
- To prevent the wrapped command's ``exit`` from killing the interactive shell,
  the command runs inside a subshell ``( ... )``.
- ``stty -echo`` disables local terminal echo so the user sees only command
  output (not the wrapper machinery). Echo is restored with ``stty echo``.
- A random sentinel string marks command completion and carries the exit code.
"""

import codecs
import json
import os
import re
import threading
import time
import urllib.parse
import uuid
from pathlib import Path
from typing import IO

from tools.environments.base import BaseEnvironment

logger = __import__("logging").getLogger(__name__)


def _gurbridge_url() -> str:
    return os.getenv("GURBRIDGE_URL", "http://localhost:3456")


def _http_get(path: str, timeout: float = 5.0):
    import requests

    return requests.get(f"{_gurbridge_url()}{path}", timeout=timeout)


def _http_post(path: str, json=None, timeout: float = 5.0):
    import requests

    return requests.post(f"{_gurbridge_url()}{path}", json=json, timeout=timeout)


def _http_delete(path: str, timeout: float = 5.0):
    import requests

    return requests.delete(f"{_gurbridge_url()}{path}", timeout=timeout)


# ── Gurbridge stream-tee: live output to a named terminal cell ─────────────
# POST chunks to http://localhost:3456/api/terminals/<id>/data so the Gurbridge
# UI renders live output. Also emits a header/footer with full logging fields.


def _stream_tee_post(terminal_id: str, chunk: str) -> None:
    """POST a chunk to the Gurbridge stream-tee endpoint. Silently ignored on failure."""
    try:
        import urllib.request

        base = os.getenv("GURBRIDGE_API", "http://localhost:3456/api")
        url = f"{base}/terminals/{terminal_id}/data"
        data = urllib.parse.urlencode({"chunk": chunk}).encode("utf-8")
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=2) as resp:
            resp.read()
    except Exception:
        pass  # Non-critical — never surface to LLM


def _stream_tee_terminal_input(terminal_id: str, data: str) -> bool:
    """POST input to a Gurbridge PTY via the streaming input endpoint.

    Returns True on success, False if the terminal is unavailable (caller
    falls back to HTTP polling sentinel approach).
    """
    try:
        import urllib.request

        base = os.getenv("GURBRIDGE_API", "http://localhost:3456/api")
        url = f"{base}/terminals/{terminal_id}/input"
        body = urllib.parse.urlencode({"data": data}).encode("utf-8")
        req = urllib.request.Request(
            url, data=body, method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status == 200
    except Exception:
        return False


class _GurbridgeProcessHandle:
    """Adapter that looks like subprocess.Popen for BaseEnvironment._wait_for_process.

    Streams output chunks to the Gurbridge terminal via stream-tee and emits
    a verbose footer on wait() with all four logging fields:
      cmd, args, cwd, env_diff, stdout, stderr, exit_code, started_at, ended_at
    """

    def __init__(
        self,
        terminal_id: str,
        sentinel: str,
        timeout: int,
        _log_ctx: dict | None = None,
    ):
        self.terminal_id = terminal_id
        self.sentinel = sentinel
        self.timeout = timeout
        self._returncode: int | None = None
        self._done = threading.Event()
        self._log_ctx: dict = _log_ctx or {}

        # Pipe for stdout so _wait_for_process can select()/read() on fileno()
        read_fd, write_fd = os.pipe()
        self._stdout: IO[str] = os.fdopen(
            read_fd, "r", encoding="utf-8", errors="replace"
        )
        self._write_fd = write_fd

        # Starting cursor so we only capture output from THIS command
        self._start_cursor = self._get_cursor()

        self._poll_thread = threading.Thread(target=self._poll_output, daemon=True)
        self._poll_thread.start()

    def _get_cursor(self) -> int:
        try:
            resp = _http_get(
                f"/api/hermes/terminal/{self.terminal_id}/read?since=999999999"
            )
            return resp.json().get("cursor", 0)
        except Exception:
            return 0

    def _is_terminal_alive(self) -> bool:
        try:
            resp = _http_get("/api/hermes/terminals")
            for t in resp.json():
                if t.get("id") == self.terminal_id:
                    return bool(t.get("alive", False))
        except Exception:
            pass
        return False

    def _poll_output(self):
        since = self._start_cursor
        deadline = time.monotonic() + self.timeout
        full_chunks: list[str] = []
        sentinel_pattern = re.escape(self.sentinel) + r"\s+(\d+)"

        try:
            while time.monotonic() < deadline and not self._done.is_set():
                try:
                    resp = _http_get(
                        f"/api/hermes/terminal/{self.terminal_id}/read?since={since}"
                    )
                    data = resp.json()
                    output = data.get("output", "")
                    since = data.get("cursor", since)

                    if output:
                        chunk_bytes = output.encode("utf-8", errors="replace")
                        try:
                            os.write(self._write_fd, chunk_bytes)
                        except (BrokenPipeError, OSError):
                            # Read end closed by _wait_for_process; stop writing
                            pass
                        full_chunks.append(output)

                        # Check for sentinel
                        full_output = "".join(full_chunks)
                        match = re.search(sentinel_pattern, full_output)
                        if match:
                            self._returncode = int(match.group(1))
                            return
                except Exception:
                    # Network hiccup — keep polling until deadline
                    pass

                # Check if terminal died unexpectedly
                if not self._is_terminal_alive():
                    self._returncode = 1
                    return

                time.sleep(0.1)

            # Timeout
            self._returncode = 124
        except Exception:
            self._returncode = 1
        finally:
            try:
                os.close(self._write_fd)
            except OSError:
                pass
            self._done.set()

    @property
    def stdout(self) -> IO[str]:
        return self._stdout

    @property
    def returncode(self) -> int | None:
        return self._returncode

    def poll(self) -> int | None:
        return self._returncode if self._done.is_set() else None

    def kill(self) -> None:
        """Send Ctrl+C to the terminal to interrupt the running command."""
        try:
            _http_post(
                f"/api/hermes/terminal/{self.terminal_id}/write",
                json={"data": "\x03"},
            )
        except Exception:
            pass
        self._returncode = 130
        self._done.set()

    def wait(self, timeout: float | None = None) -> int:
        self._done.wait(timeout=timeout)
        # Emit verbose footer with all four logging fields
        if self._log_ctx:
            duration_ms = round(
                (time.monotonic_ns() - self._log_ctx.get("started_at_ns", 0)) / 1_000_000
            )
            _footer = (
                f"<<\u2039 exit={self._returncode} duration_ms={duration_ms} "
                f"cmd={json.dumps(self._log_ctx.get('cmd', ''))} "
                f"args={json.dumps(self._log_ctx.get('args', []))} "
                f"cwd={json.dumps(self._log_ctx.get('cwd', ''))} "
                f"env_diff_keys={json.dumps(self._log_ctx.get('env_diff_keys', []))} "
                f"started_at={self._log_ctx.get('started_at_s', 0)} "
                f"ended_at={round(time.time(), 3)}\n"
            )
            _stream_tee_post(self.terminal_id, _footer)
        return self._returncode


class GurbridgeEnvironment(BaseEnvironment):
    """Run commands in a Gurbridge visible terminal via REST API.

    One terminal is acquired (or created) per *task_id* and reused across
    execute() calls for that task. A threading lock serialises concurrent
    commands so output doesn't interleave. Different tasks are fully isolated
    — each gets its own visible terminal in Gurbridge.
    """

    _stdin_mode = "pipe"

    def __init__(self, cwd: str = "", timeout: int = 60, env: dict = None, task_id: str = "default"):
        # Safety check: GurbridgeEnvironment should only be used when actually
        # running inside Gurbridge (env vars injected by hermesManager.ts).
        # Standalone CLI instances with misconfigured TERMINAL_ENV=gurbridge
        # would otherwise pollute Gurbridge with orphaned terminals.
        if not os.environ.get("HERMES_IN_GURBRIDGE") and not os.environ.get("GURBRIDGE"):
            logger.warning(
                "GurbridgeEnvironment initialized but HERMES_IN_GURBRIDGE / GURBRIDGE "
                "env vars are not set. This usually means TERMINAL_ENV=gurbridge was "
                "set manually or via config on a standalone CLI instance. "
                "Switch config to 'terminal.backend: local' for standalone use."
            )
        self._gurbridge_url = _gurbridge_url()
        self._task_id = task_id
        # Set cwd locally before _acquire_terminal (which uses self.cwd when creating
        # a new terminal via POST /api/terminals with {label, cwd})
        self.cwd = cwd or os.getcwd()
        self._terminal_id = self._acquire_terminal()
        self._terminal_lock = threading.Lock()
        super().__init__(cwd=self.cwd, timeout=timeout, env=env)
        self.init_session()

    def get_temp_dir(self) -> str:
        """Same logic as LocalEnvironment — commands run on the local host."""
        for env_var in ("TMPDIR", "TMP", "TEMP"):
            candidate = self.env.get(env_var) or os.environ.get(env_var)
            if candidate and candidate.startswith("/"):
                return candidate.rstrip("/") or "/"
        if os.path.isdir("/tmp") and os.access("/tmp", os.W_OK | os.X_OK):
            return "/tmp"
        import tempfile

        candidate = tempfile.gettempdir()
        if candidate.startswith("/"):
            return candidate.rstrip("/") or "/"
        return "/tmp"

    def _terminal_name(self) -> str:
        """Unique terminal name for this task."""
        return f"Hermes-{self._task_id[:8]}"

    def _acquire_terminal(self) -> str:
        """Reuse the terminal for this specific task, or claim an existing generic one."""
        name = self._terminal_name()
        try:
            resp = _http_get("/api/hermes/terminals")
            resp.raise_for_status()
            terminals = resp.json()

            # 1. Exact match — same task already has a terminal.
            for t in terminals:
                if t.get("alive") and t.get("name") == name:
                    logger.info("Reusing Gurbridge terminal %s for task %s", t["id"], self._task_id[:8])
                    return t["id"]

            # 2. Claim an existing generic/numbered terminal (e.g. "1", "2", "3", "4")
            #    so Hermes fills the visible grid slots before creating new panes.
            numeric_terminals = [t for t in terminals if t.get("alive") and re.match(r"^\d+$", str(t.get("name", "")))]
            if numeric_terminals:
                # Pick the lowest-numbered one for predictable ordering.
                numeric_terminals.sort(key=lambda t: int(t["name"]))
                chosen = numeric_terminals[0]
                logger.info(
                    "Claiming generic Gurbridge terminal %s (name=%s) for task %s",
                    chosen["id"], chosen["name"], self._task_id[:8],
                )
                return chosen["id"]
        except Exception as e:
            logger.debug("Failed to list terminals: %s", e)

        # 3. Fall back to creating a brand-new terminal.
        # Use new /api/terminals endpoint with label/cwd fields for richer naming.
        try:
            resp = _http_post(
                "/api/terminals",
                json={"label": name, "cwd": self.cwd},
            )
            resp.raise_for_status()
            tid = resp.json()["id"]
            logger.info("Created Gurbridge terminal %s for task %s", tid, self._task_id[:8])
            return tid
        except Exception as e:
            # Fallback to old endpoint for backwards compat
            try:
                resp = _http_post("/api/hermes/terminal", json={"name": name})
                resp.raise_for_status()
                tid = resp.json()["id"]
                logger.info("Created Gurbridge terminal %s (legacy) for task %s", tid, self._task_id[:8])
                return tid
            except Exception as e2:
                raise RuntimeError(
                    f"Failed to acquire Gurbridge terminal at {self._gurbridge_url}: {e2}"
                )

    def _run_bash(
        self,
        cmd_string: str,
        *,
        login: bool = False,
        timeout: int = 120,
        stdin_data: str | None = None,
    ) -> _GurbridgeProcessHandle:
        with self._terminal_lock:
            # ── Verbose logging header ──────────────────────────────────
            # All four logging fields on every command (part 3 streaming path)
            _parent_env_keys = set(os.environ.keys())
            _env_diff = {
                k: v for k, v in (self.env or {}).items()
                if k not in _parent_env_keys or os.environ.get(k) != v
            }
            _cmd_started_at_s = time.time()
            _cmd_started_at_ns = time.monotonic_ns()

            _header = (
                f">>\u203a exec {json.dumps({
                    'cmd': 'bash',
                    'args': [cmd_string.strip()[:200]],
                    'cwd': self.cwd,
                    'env_diff': list(_env_diff.keys()),
                    'started_at': _cmd_started_at_s,
                }, sort_keys=True)}\n"
            )
            _stream_tee_post(self._terminal_id, _header)

            sentinel = f"__HERMES_GB_DONE_{uuid.uuid4().hex}__"

            # Write the wrapped command to a temp file so we can execute it
            # with ``bash file.sh`` instead of feeding multi-line input into
            # the PTY (which causes continuation-prompt issues).
            script_path = f"/tmp/hermes-gb-{uuid.uuid4().hex}.sh"
            Path(script_path).write_text(cmd_string, encoding="utf-8")

            stdin_path = ""
            if stdin_data is not None:
                stdin_path = f"/tmp/hermes-gb-stdin-{uuid.uuid4().hex}.txt"
                Path(stdin_path).write_text(stdin_data, encoding="utf-8")

            # Single-line command: disable echo, run script, capture exit code,
            # clean up temp files, emit sentinel, restore echo.
            if stdin_path:
                one_liner = (
                    f"stty -echo; bash {script_path} < {stdin_path}; __gb_ec=$?; "
                    f"rm -f {script_path} {stdin_path}; "
                    f"echo '{sentinel}' \"$__gb_ec\"; stty echo\n"
                )
            else:
                one_liner = (
                    f"stty -echo; bash {script_path}; __gb_ec=$?; "
                    f"rm -f {script_path}; "
                    f"echo '{sentinel}' \"$__gb_ec\"; stty echo\n"
                )

            # Try streaming input endpoint first; fall back to legacy write endpoint
            streamed = _stream_tee_terminal_input(self._terminal_id, one_liner)
            if not streamed:
                resp = _http_post(
                    f"/api/hermes/terminal/{self._terminal_id}/write",
                    json={"data": one_liner},
                )
                resp.raise_for_status()

            return _GurbridgeProcessHandle(
                terminal_id=self._terminal_id,
                sentinel=sentinel,
                timeout=timeout,
                # Pass logging context so wait() can emit the footer
                _log_ctx={
                    "cmd": "bash",
                    "args": [cmd_string.strip()[:200]],
                    "cwd": self.cwd,
                    "env_diff_keys": list(_env_diff.keys()),
                    "started_at_s": _cmd_started_at_s,
                    "started_at_ns": _cmd_started_at_ns,
                },
            )

    def _kill_process(self, proc: _GurbridgeProcessHandle):
        proc.kill()

    def _wait_for_process(self, proc, timeout: int = 120) -> dict:
        """Poll output and strip the sentinel + trailing prompt before returning."""
        result = super()._wait_for_process(proc, timeout=timeout)
        output = result.get("output", "")
        sentinel = getattr(proc, "sentinel", "")
        if sentinel and sentinel in output:
            idx = output.find(sentinel)
            # Walk back to the start of the line containing the sentinel
            start = idx
            while start > 0 and output[start - 1] not in "\n\r":
                start -= 1
            output = output[:start].rstrip()
        result["output"] = output
        return result

    def _update_cwd(self, result: dict):
        """Read CWD from the local temp file (same host as the terminal)."""
        try:
            cwd_path = Path(self._cwd_file).read_text().strip()
            if cwd_path:
                self.cwd = cwd_path
        except (OSError, FileNotFoundError):
            pass
        # Also strip the stdout marker that _wrap_command injects
        self._extract_cwd_from_output(result)

    def execute(
        self,
        command: str,
        cwd: str = "",
        *,
        timeout: int | None = None,
        stdin_data: str | None = None,
    ) -> dict:
        """Run command and do a final cleanup of any trailing \\r left by CWD marker stripping."""
        result = super().execute(command, cwd=cwd, timeout=timeout, stdin_data=stdin_data)
        if isinstance(result, dict):
            output = result.get("output", "")
            if output:
                result["output"] = output.rstrip()
        return result

    def cleanup(self):
        """Kill the Gurbridge terminal for this task, or reset it if generic."""
        try:
            # Check if this is a generic numbered terminal (1, 2, 3, 4, etc.).
            # If so, reset it instead of killing so it stays in the grid.
            resp = _http_get("/api/hermes/terminals")
            terminals = resp.json()
            my_terminal = next(
                (t for t in terminals if t.get("id") == self._terminal_id), None
            )
            if my_terminal and re.match(r"^\d+$", str(my_terminal.get("name", ""))):
                # Generic terminal — send VT100 reset (ESC + c) to clear state
                _http_post(
                    f"/api/hermes/terminal/{self._terminal_id}/write",
                    json={"data": "\u001bc"},
                )
                logger.info(
                    "Reset generic Gurbridge terminal %s (task %s)",
                    self._terminal_id,
                    self._task_id[:8],
                )
                return
        except Exception as e:
            logger.debug("Could not check terminal name before cleanup: %s", e)

        # Named terminal created for this task — kill it.
        try:
            _http_delete(f"/api/hermes/terminal/{self._terminal_id}")
            logger.info(
                "Cleaned up Gurbridge terminal %s (task %s)",
                self._terminal_id,
                self._task_id[:8],
            )
        except Exception as e:
            logger.debug("Error killing terminal %s: %s", self._terminal_id, e)
