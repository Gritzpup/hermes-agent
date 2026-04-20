# COO Journal

This directory holds snapshots of the OpenClaw COO's decision history, committed
periodically by the `coo-journal-committer` Tilt resource (every 6 hours).

Each snapshot is a JSONL file named by date:

- `YYYY-MM-DD-actions.jsonl` — every action the COO took (enacted or dry-run)
- `YYYY-MM-DD-directives.jsonl` — every directive/note/pause/amplify the COO wrote

Live sources (recreated each day): `services/openclaw-hermes/.runtime/coo-actions.log`
and `.runtime/coo-directives.jsonl`.

Commits land on whichever branch this worktree tracks. They're append-only —
the journal grows over time and gives you a git-historied audit trail.
