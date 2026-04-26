# ACP (Agent Client Protocol) Fix Summary

## Problem
The `acp-client.ts` was failing to establish an ACP session because the `openclaw acp` process was using a default session key that didn't match the session ID returned by `session/new`.

## Root Cause
- `openclaw acp` defaults to session key like `agent:main:main`
- The code was calling `session/new` which returns a UUID session ID
- When `session/prompt` was sent with the UUID session ID, the server returned "Session not found" because the session key didn't match

## Fix Applied
Added `--session agent:main:explicit:${SESSION_ID}-acp` to the `openclaw acp` spawn command:

```typescript
// Before:
this.child = spawn(OPENCLAW_CMD, ['acp', '--no-prefix-cwd'], ...);

// After:
this.child = spawn(OPENCLAW_CMD, ['acp', '--no-prefix-cwd', '--session', `agent:main:explicit:${SESSION_ID}-acp`], ...);
```

## Additional Finding
Even after fixing the session key, `session/prompt` times out after 5 minutes. Gateway logs show:
```
"session file locked (timeout 10000ms): pid=2770198 /home/ubuntubox/.openclaw/agents/main/sessions/hermes-bridge.jsonl.lock"
```

The main `hermes-bridge` session (handled by the openclaw-gateway) holds a file lock that conflicts with ACP session processing.

## Current Status
- **Session establishment**: ✅ Works with the fix
- **Session/prompt**: ❌ Times out due to gateway lock conflict
- **Fallback to spawn**: ✅ Works correctly

## Files Modified
- `services/openclaw-hermes/src/acp-client.ts` - Added `--session` flag to spawn command

## Commit Message
```
fix(acp): pass --session agent:main:explicit:<id>-acp to openclaw acp spawn

The openclaw acp process needs an explicit --session key that matches
the sessionId returned by session/new. Without this, session/prompt
returns "Session not found". The -acp suffix avoids file-lock conflicts
with the main gateway process that holds the hermes-bridge session lock.

Note: session/prompt still times out due to gateway lock contention;
bridge correctly falls back to spawn path.
```
