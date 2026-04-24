# Parallel Browser + Vision Workflow

When using browser tools alongside vision analysis (`browser_vision`, `vision_analyze`, etc.):

## Core Rules

1. **Never block on vision** — while vision is evaluating, read DOM elements, click buttons, scroll, issue other tool calls. Vision takes time to return; use that window productively.

2. **Vision and user messages arrive concurrently** — the user may type new instructions while vision is in flight. Capture and track both streams of information. Do not drop context from either.

3. **If interrupted mid-vision** — even if the user sends a message or the session shifts while vision is running, still receive and record the vision result. The analysis is still useful even if it arrived after the user moved on.

4. **Read elements first, then vision** — for pages you are exploring, grab the DOM snapshot or element details before calling vision, so you have structure to reason about while waiting for pixel-level analysis.

5. **Self-describe for continuity** — after any vision call returns (even late or interrupted), briefly note to yourself what was in the image so subsequent actions retain that context without needing to re-analyze.

## Why This Matters

Vision model calls take significant time to resolve. Blocking on them would mean idle waiting when there is always DOM exploration, element interaction, or other productive work to do. The browser is also receiving user input concurrently — both must be tracked.

## Applicable Tools

- `browser_vision`
- `vision_analyze`
- Any screenshot-based inspection that triggers async image analysis

## Example Sequence (good)

```
browser_snapshot  → get page structure
browser_click     → click target element
browser_vision   → start screenshot analysis
browser_snapshot → read another part of the page (vision still running)
browser_click     → click next element (vision still running)
...user types new instructions...
vision result arrives → note what it showed, continue
```

## Example Sequence (bad)

```
browser_vision   → call and WAIT for result
browser_snapshot → only then read the page
browser_click    → only then interact
```
