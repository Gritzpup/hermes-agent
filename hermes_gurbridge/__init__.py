"""
Hermes-Gurbridge: Isolated Hermes instance for Gurbridge IDE.

This wrapper sets HERMES_HOME to ~/.hermes-gurbridge to keep
Gurbridge's Hermes instance completely isolated from any other
Hermes installations on the system.

Usage:
    hermes-gurbridge              # Interactive chat
    hermes-gurbridge chat         # Interactive chat
    hermes-gurbridge sessions     # List sessions
    hermes-gurbridge update       # Update Gurbridge's Hermes fork
"""

import os
import sys
from pathlib import Path

# Set up isolated environment for Gurbridge's Hermes.
# Define the path unconditionally so it's available below regardless of whether
# HERMES_HOME was pre-set by the caller.
_DEFAULT_HERMES_HOME = "/mnt/Storage/github/gurbridge/.hermes-gurbridge"
_GURBRIDGE_HERMES_HOME = os.environ.get(
    "HERMES_GURBRIDGE_HOME",
    os.environ.get("HERMES_HOME", _DEFAULT_HERMES_HOME),
)

# Only override HERMES_HOME if not already set (allows external control).
if not os.environ.get("HERMES_HOME"):
    os.environ["HERMES_HOME"] = _GURBRIDGE_HERMES_HOME
os.environ["HERMES_IN_GURBRIDGE"] = "1"
os.environ["GURBRIDGE"] = "1"

# GURBRIDGE_DIR — the Gurbridge repo root (parent of HERMES_HOME). The agent's
# SOUL.md references this so it can find the Gurbridge codebase deterministically
# without guessing. Don't override if the launcher already set it.
if not os.environ.get("GURBRIDGE_DIR"):
    os.environ["GURBRIDGE_DIR"] = str(Path(_GURBRIDGE_HERMES_HOME).parent)

# Ensure the hermes home directory exists
Path(_GURBRIDGE_HERMES_HOME).mkdir(parents=True, exist_ok=True)


def main():
    """Entry point for hermes-gurbridge command."""
    from hermes_cli.main import main as hermes_main
    return hermes_main()
