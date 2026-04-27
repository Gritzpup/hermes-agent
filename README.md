# Hermes Agent

> Clone of [hermes-trading-firm](https://github.com/Gritzpup/hermes-trading-firm) for the Agentic Trading Platform.

## Architecture

```
hermes-trading-firm (upstream)
    │  ← pull updates from here
    └── hermes-agent (this repo, agent branch)
            │
            └── Modified by Agentic Trading Platform
                    │
                    └── archon workflows improve this copy
```

## Branches

| Branch | Purpose |
|--------|---------|
| `master` | Mirrors upstream hermes-trading-firm master |
| `agent` | This branch — platform's modified copy |

## Keeping Up to Date

Pull updates from upstream hermes-trading-firm:

```bash
git fetch upstream
git merge upstream/master
# Resolve any conflicts
git push origin agent
```

## Setup

```bash
pnpm install
cp .env.example .env  # Then configure
```

## Usage

This repo is modified by the [Agentic Trading Platform](https://github.com/Gritzpup/agentic-trading-platform) via Archon workflows. The platform:
1. Creates worktrees from the `agent` branch
2. Makes improvements in isolated experiments
3. Validates via backtest
4. Merges validated changes back to `agent`

## Port Notes

- Main hermes runs at port 4300 (from hermes-trading-firm)
- This clone uses offset ports when manually started for testing
- Platform watches main hermes at 4300 (read-only)
