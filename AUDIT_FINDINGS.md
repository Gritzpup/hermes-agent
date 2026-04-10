# Hermes Trading Firm Application Audit Report
Date: 2026-04-09
Focus Areas: AI council transparency, learning page, dashboard source mix, terminal summaries

## CRITICAL ISSUES

### 1. Learning Page Council Source Counts Are Stale (DATA TRUTHFULNESS - HIGH SEVERITY)
**File:** `./apps/web/src/routes/learning/+page.svelte` (line 10)

**Issue:** The learning page displays "Council source mix" showing Pi/API/CLI/Rules vote counts, but these counts never update after initial page load. The counts are calculated from `data.paperDesk.aiCouncil` which is loaded once in `+page.server.ts` and never refreshed.

**Evidence:**
- Learning page calculates: `const councilSourceCounts = getCouncilSourceCounts(data.paperDesk.aiCouncil);` (line 10)
- This uses data from initial SSR load in `learning/+page.server.ts` (line 10)
- The PiCouncilTraceSection component polls for new traces every 8s, but source counts don't update
- Dashboard has same display but gets live updates via SSE feed (dashboard updates every 1s)

**Impact:** Users see stale source count data on learning page. If system switches between Pi and fallback modes, the learning page won't reflect this for hours until user refreshes.

**Severity:** HIGH - Violates UI truthfulness, misleads users about current system state

---

### 2. Terminal Panel Vote Lines Formatting Error (CORRECTNESS - MEDIUM SEVERITY)
**File:** `./services/api/src/index.ts` (line 1459)

**Issue:** All three council votes (Claude, Codex, Gemini) are concatenated into a single line instead of being separate array entries. This creates an excessively long line that breaks terminal display formatting.

**Evidence:**
```typescript
`[votes] ${latestPrimary ? formatVoteLine('claude', latestPrimary) : '[claude] waiting for vote'} · ${latestChallenger ? formatVoteLine('codex', latestChallenger) : '[codex] waiting for vote'} · ${latestGemini ? formatVoteLine('gemini', latestGemini) : '[gemini] waiting for vote'}`
```

This single string contains all three votes with " · " separators, creating a line that's typically 150+ characters.

**Expected:** Each vote should be a separate entry in the `lines` array per the TerminalPane contract (contracts line 1052).

**Impact:** Terminal display shows one extremely long line instead of three readable lines. Horizontal scrolling required, poor UX.

**Severity:** MEDIUM - Breaks intended display format, impacts readability

---

## MODERATE ISSUES

### 3. Learning Page Doesn't Show Fallback Warning (UI TRUTHFULNESS - MEDIUM SEVERITY)
**Files:** 
- `./apps/web/src/routes/+page.svelte` (lines 473-478) - Dashboard HAS warning
- `./apps/web/src/routes/learning/+page.svelte` - Learning page MISSING warning

**Issue:** Dashboard shows advisory banner when AI council uses fallback (API/CLI/rules instead of Pi), but learning page doesn't show this warning despite displaying the same source mix data.

**Evidence:**
Dashboard code:
```svelte
{#if councilFallbackCount > 0}
  <div class="advisory-banner">
    <span>Fallback active</span>
    <span>{councilFallbackCount} of {paperDesk.aiCouncil.length} decisions used API / CLI / rules instead of Pi.</span>
  </div>
{/if}
```

Learning page has no equivalent fallback indicator despite using `councilSourceCounts`.

**Impact:** Users on learning page don't know when AI council is degraded and using fallback modes. This is important operational information.

**Severity:** MEDIUM - Missing critical system state indicator

---

### 4. Transcript Viewer Role Filter Description Is Confusing (UI CLARITY - LOW SEVERITY)
**File:** `./apps/web/src/lib/components/PiCouncilTraceSection.svelte` (line 135)

**Issue:** Filter section says "Pi transport only · narrow the transcript log by model role" but the "Pi transport only" part is redundant since ALL traces are Pi transport by contract definition.

**Evidence:**
- UI text (line 135): `<span class="subtle">Pi transport only · narrow the transcript log by model role.</span>`
- Contract (contracts line 1032): `transport: 'pi';` - hardcoded, no other options
- The filter is by `role` (claude/codex/gemini), not by transport

**Impact:** Confusing label suggests there might be non-Pi traces, which is impossible. Users might wonder why they can't filter by transport.

**Severity:** LOW - Confusing but doesn't break functionality

---

## OBSERVATIONS (NOT BUGS, BUT WORTH NOTING)

### 5. Learning Page Loads Traces But Doesn't Use Them For Source Counts
**Files:**
- `./apps/web/src/routes/learning/+page.server.ts` (line 9) - loads traces
- `./apps/web/src/routes/learning/+page.svelte` (line 10) - uses paperDesk.aiCouncil instead

**Observation:** The page loads `data.traces` via API but calculates source counts from `data.paperDesk.aiCouncil`. These are different data sources:
- `traces` = raw Pi transcript log entries (from `/api/ai-council/traces`)
- `aiCouncil` = council decisions (from paper desk snapshot)

This is technically correct since traces and decisions are different entities, but it's confusing that both are loaded but only decisions are used for source counts.

---

### 6. Terminal Snapshot Summary Text Truncation
**File:** `./services/api/src/index.ts` (lines 1444-1445, 1454-1458)

**Observation:** Terminal summaries use `previewText()` function to truncate, but there's no indication in the UI that text is truncated. The `previewText` function (not shown in audit) presumably truncates but doesn't add "..." indicator consistently.

**Note:** This is minor since terminals are meant to show live snapshots, not full history.

---

## RECOMMENDATIONS

1. **Fix Critical Issue #1:** Learning page should either:
   - Poll `/api/paper-desk` to refresh source counts every 5-10s, OR
   - Add timestamp showing "Source counts as of [time]" to indicate staleness, OR
   - Calculate from live-updated traces instead of static paperDesk

2. **Fix Critical Issue #2:** Split terminal vote line into three separate array entries:
   ```typescript
   latestPrimary ? formatVoteLine('claude', latestPrimary) : '[claude] waiting for vote',
   latestChallenger ? formatVoteLine('codex', latestChallenger) : '[codex] waiting for vote',
   latestGemini ? formatVoteLine('gemini', latestGemini) : '[gemini] waiting for vote'
   ```

3. **Fix Moderate Issue #3:** Add fallback warning to learning page matching dashboard pattern

4. **Fix Moderate Issue #4:** Simplify filter description to just "Filter by model role:" or "Reviewer role filter:"

---

## SUMMARY

**Concrete bugs found:** 2 (Issues #1 and #2)
**UI truthfulness issues:** 2 (Issues #1 and #3)
**Clarity issues:** 1 (Issue #4)
**Total findings:** 5 concrete issues + 2 observations

All findings include specific file paths, line numbers, and code evidence. No speculative issues reported.
