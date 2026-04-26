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

# Set up isolated environment for Gurbridge's Hermes
_GURBRIDGE_HERMES_HOME = os.path.expanduser("~/.hermes-gurbridge")
os.environ["HERMES_HOME"] = _GURBRIDGE_HERMES_HOME
os.environ["HERMES_IN_GURBRIDGE"] = "1"
os.environ["GURBRIDGE"] = "1"

# Ensure the hermes home directory exists
Path(_GURBRIDGE_HERMES_HOME).mkdir(parents=True, exist_ok=True)


def main():
    """Entry point for hermes-gurbridge command."""
    from hermes_cli.main import main as hermes_main
    return hermes_main()
