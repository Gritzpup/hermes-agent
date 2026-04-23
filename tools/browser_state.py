"""Shared mutable state for browser automation tools.

Centralizes all module-global state to avoid circular imports
and make dependencies explicit.
"""

import threading
from typing import Dict, Any, Set

# Active browser sessions: task_id -> {session_name, ...}
active_sessions: Dict[str, Dict[str, str]] = {}

# Task IDs with active screen recordings
recording_sessions: Set[str] = set()

# Last activity timestamp per task_id
session_last_activity: Dict[str, float] = {}

# Cleanup thread state
cleanup_done = False
cleanup_thread = None
cleanup_running = False
cleanup_lock = threading.Lock()
