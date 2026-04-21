# Self-Healing / Learning Loop Scripts

Two bash scripts that run a lightweight feedback loop over Hermes agent sessions,
producing persistent memory entries that accumulate institutional knowledge across
sessions. A third script (this file) documents installation and rollback.

---

## Scripts

### `lessons-learned.sh`

Runs after **each** session you want to capture.

**What it does:**
1. Finds the newest `session_*.json` in `~/.hermes/sessions/`.
2. Skips it if a marker file `~/.hermes/sessions/.lessons-done-<basename>` already exists.
3. Extracts assistant messages from the session JSON using `jq`.
4. Pipes them to `hermes chat --provider minimax -m MiniMax-M2.7 --yolo` with a structured
   retro prompt (≤ 400 words output: what worked / surprised / avoid).
5. Writes a memory file to:
   ```
   /home/ubuntubox/.claude/projects/-home-ubuntubox/memory/lesson_<YYYYMMDD_HHMM>.md
   ```
   with frontmatter (`name`, `description`, `type=feedback`).
6. Appends a one-line index entry under `## Feedback` in `MEMORY.md`.
7. Stamps a marker so the session is never double-summarised.

**DRY_RUN=1** mode: prints frontmatter + summary to stdout without writing anything.

**Output example:**
```
/home/ubuntubox/.claude/projects/-home-ubuntubox/memory/lesson_20260421_0720.md
```

---

### `firm-retro.sh`

Runs **once per day** to consolidate 24 hours of sessions.

**What it does:**
1. Walks `~/.hermes/sessions/` for `session_*.json` files modified in the last 24 h.
2. For each session with an existing marker file: locates the already-written lesson file.
3. For each session without a marker: regenerates a summary inline (same LLM prompt).
4. Pipes all summaries into a consolidated retro prompt.
5. Writes the result to:
   ```
   /home/ubuntubox/.hermes/memories/firm-retro-YYYYMMDD.md
   ```

**Output example:**
```
/home/ubuntubox/.hermes/memories/firm-retro-20260421.md
```

**SAFE BOUNDARY:** never touches `state.db`, `MEMORY.md` (the Claude Code one), or
`~/.hermes/skills/`.

---

## Installation (human enables; agent delivers only)

### Option A — Cron (run as your user, not root)

```crontab
# Summarise the most recent session every hour
0 * * * * /mnt/Storage/github/hermes-trading-firm/scripts/lessons-learned.sh >> /home/ubuntubox/.hermes/logs/lessons-learned.log 2>&1

# Consolidated daily retro at 00:05 every day
5 0 * * * /mnt/Storage/github/hermes-trading-firm/scripts/firm-retro.sh >> /home/ubuntubox/.hermes/logs/firm-retro.log 2>&1
```

Edit your crontab with `crontab -e`. The log paths are optional but recommended
so you can `tail` them to verify runs.

### Option B — Hermes post-session hook

If your `hermes` CLI supports hooks, create:

```bash
# Post-session hook — fires after every `hermes chat` session
cat > ~/.hermes/hooks/post-session.d/lessons-learned.sh << 'EOF'
#!/usr/bin/env bash
# only run if sessions dir is accessible and a new session exists
SESSIONS_DIR="${HOME}/.hermes/sessions"
newest=$(find "$SESSIONS_DIR" -maxdepth 1 -name 'session_*.json' -type f -printf '%T+\t%p\n' \
  | sort -r | head -1 | cut -f2)
[[ -n "$newest" ]] || exit 0
exec /mnt/Storage/github/hermes-trading-firm/scripts/lessons-learned.sh
EOF
chmod +x ~/.hermes/hooks/post-session.d/lessons-learned.sh
```

(Adjust the hook mechanism to match however your `hermes` version registers hooks,
e.g. `~/.hermes/hooks/` may need to be listed in `~/.config/hermes/hooks.toml`.)

---

## Rollback

### Remove cron entries
```bash
crontab -e
# delete the two lines shown above
```

### Remove post-session hook
```bash
rm ~/.hermes/hooks/post-session.d/lessons-learned.sh
```

### Re-summarise a session
The scripts use marker files (`.lessons-done-<session-basename>`) to prevent
double-work. To force re-summarisation:
```bash
rm ~/.hermes/sessions/.lessons-done-<session-basename>
# then re-run the script manually
```

### Re-run firm retro (overwrites today's file)
```bash
rm /home/ubuntubox/.hermes/memories/firm-retro-$(date +%Y%m%d).md
# then re-run
```

---

## Dependencies

Both scripts require these in PATH:
- `hermes` — the Hermes CLI (provides `hermes chat`)
- `jq` — JSON parsing
- `bash` ≥ 4 (for `mapfile`)
- `find`, `sort`, `date` — standard POSIX tools

Install `jq` if missing: `sudo apt install jq`
