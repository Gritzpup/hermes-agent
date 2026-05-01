"""Module entry point so `python3 -m hermes_gurbridge` works."""
import sys
from . import main

if __name__ == "__main__":
    sys.exit(main() or 0)
