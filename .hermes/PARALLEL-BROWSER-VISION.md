# Parallel Browser + Vision Workflow

When using browser tools alongside vision analysis (`browser_vision`, `vision_analyze`, etc.):

### Critical: Use Playwright Browser, NOT curl/wget/python

Web research MUST use the Playwright browser tools (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_scroll`, `browser_vision`) — never curl, wget, or python http libraries. The browser gives you DOM structure, element refs, and vision context that curl completely skips.

**Rule: `browser_navigate` first, then `browser_snapshot` to read the page before anything else.** Only then do you decide what to click, scroll, or analyze with vision.

## Core Rules

1. **Read elements first, then vision** — grab the DOM snapshot or element details before calling vision, so you have structure to reason about while waiting for pixel-level analysis.

2. **Never block on vision** — while vision is evaluating, read DOM elements, click buttons, scroll, issue other tool calls. Vision takes time to return; use that window productively.

3. **Vision and user messages arrive concurrently** — the user may type new instructions while vision is in flight. Capture and track both streams of information. Do not drop context from either.

4. **If interrupted mid-vision** — even if the user sends a message or the session shifts while vision is running, still receive and record the vision result. The analysis is still useful even if it arrived after the user moved on.

5. **Self-describe for continuity** — after any vision call returns (even late or interrupted), briefly note to yourself what was in the image so subsequent actions retain that context without needing to re-analyze.

## Why This Matters

Vision model calls take significant time to resolve. Blocking on them would mean idle waiting when there is always DOM exploration, element interaction, or other productive work to do. The browser is also receiving user input concurrently — both must be tracked.

## Applicable Tools

- `browser_navigate` — always first, load the page
- `browser_snapshot` — read page structure, get element refs
- `browser_click` — interact with elements
- `browser_scroll` — reveal more content
- `browser_vision` — screenshot analysis (async, never block on this)
- `vision_analyze` — image file analysis

## Example Sequence (good)

```
browser_navigate  → go to page
browser_snapshot  → read the page structure, find relevant refs
browser_click     → click a target element
browser_vision   → start screenshot analysis (async, don't wait)
browser_snapshot → read another part of the page (vision still running)
browser_scroll    → scroll down (vision still running)
...user types new instructions...
vision result arrives → note what it showed, continue
```

## Example Sequence (bad)

```
curl/wget/python → fetch HTML (skips DOM, no element refs, no vision)
browser_vision   → call and WAIT for result
browser_snapshot → only then read the page
browser_click    → only then interact
```
