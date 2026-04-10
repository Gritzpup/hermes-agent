# Legacy Hermes Snapshot

This repo was created from the active Hermes Trading Post environment without mutating the old codebase.

## Snapshot Scope

- Source project: `/mnt/Storage/github/project-sanctuary/hermes-trading-post`
- Active Tilt source: `/mnt/Storage/github/tilt/Tiltfile`
- New extraction target: `/mnt/Storage/github/hermes-trading-firm`

## Preserved State

- `legacy-status.txt` captures the dirty git status from the old Hermes project at scaffold time.
- `legacy-tilt-resources.txt` captures the active Tilt resources that existed at scaffold time.
- The old Hermes project was left in place so no local changes or runtime state were discarded during extraction.

## Known Legacy Issues Observed Before Extraction

- Gemini-based paper AI bots were failing authentication.
- The old Hermes backend was stuck in reconnect loops to live bot services.
- Strategy definitions were inconsistent across UI, paper, and live layers.
- The old Hermes app was tightly coupled to `project-sanctuary` and a shared Tilt monorepo.
