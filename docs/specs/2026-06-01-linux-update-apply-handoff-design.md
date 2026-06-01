# Linux in-app update — apply fix + "upgrading" handoff

**Date:** 2026-06-01
**Status:** Approved design
**Scope:** Linux only. Windows update path is untouched.

## Problem

After the locator + per-platform-feed fixes (PR #242, beta.23), a Linux app
**discovers** updates correctly, but **applying** one kills the app without
updating. Root cause (`UpdateService.applyUpdate`, local mode): it spawns the
Windows operation-server helper —

```js
path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe')
```

— a `.exe` at a `dataRoot` location the Linux launcher isn't staged to. On
Linux that `spawn` throws ENOENT, so the helper never starts **and the actual
Velopack apply (`waitExitThenApplyUpdate`) never runs** (the helper was meant
to drive it). The caller then does its deferred `process.exit`, Node exits, the
launcher follows → **app dies, nothing applied.** Confirmed: re-running the
beta.23 AppImage comes back on beta.23 (no update applied, nothing corrupted).

## Goal

1. Linux in-app updates **apply and relaunch** on the new version.
2. A smooth browser **"upgrading…" handoff** (the Linux-native equivalent of
   the Windows operation-server redirect), so the tab isn't left on a dead
   connection.

## Hard constraint: Windows is frozen

This is the overriding requirement. The hard-won Windows update path
(operation-server + redirect) must not change behavior.

- `applyUpdate` is **platform-split**: the `win32` branch keeps its current
  operation-server-helper code byte-for-byte; only the Linux branch changes.
- `handleApply` keeps the Windows HTML-redirect path; Linux uses the existing
  `{ok:true}` branch plus a Linux-only `mode:'reconnect'` flag.
- The Rust launcher's `--operation-server` mode is **not touched** (the chosen
  approach avoids the launcher entirely).
- The client reconnect overlay is gated on the Linux-only `mode:'reconnect'`
  flag; Windows browsers navigate away (HTML redirect) before reaching it.
- **Verification:** the full vitest suite — including the Windows
  operation-server + service-mode apply tests — stays green.

## Design (Approach A: client-side overlay + reconnect-poll)

Chosen over (B) porting the Rust operation-server to Linux — rejected because it
touches the shared launcher (Windows risk) and is heavier — and (C) apply-only
with no handoff — rejected as a poor UX (manual reconnect).

### Server — `UpdateService.applyUpdate` (Linux local-mode branch)

```
if (win32)            → existing operation-server helper (UNCHANGED)
else if service mode  → waitExitThenApplyUpdate(update, silent=true, restart=false)   (UNCHANGED; supervisor restarts)
else (Linux local)    → waitExitThenApplyUpdate(update, silent=true, restart=true)     (NEW)
                        return { redirectPort: null }
```

`restart=true` asks Velopack to apply on exit and relaunch the AppImage, which
rebinds the **same** web port (freed when the old process exits).

### Server — `UpdatesApi.handleApply`

Windows unchanged. Linux returns `{ ok: true, mode: 'reconnect' }`
(`mode` is a new optional field on `UpdatesApplyResponse` in
`src/common/UpdateEvents.ts`). Then the existing deferred `process.exit(0)`.

### Client — "upgrading" overlay + reconnect-poll

On an apply response with `mode === 'reconnect'`:

1. Render a full-viewport **`UpgradingOverlay`** (states: *applying → reconnecting → done / timed-out*). It hides the now-stale app UI.
2. Poll `GET /api/updates/status` on the **same origin** every ~1s.
   - While the server is down, fetches fail — keep polling.
   - When it answers with `currentVersion !== <version-before-apply>` → state *done* → `window.location.reload()` → user lands on the new version.
3. **Timeout (~60s):** state *timed-out* → overlay shows
   "update applied — reopen `<current URL>`" with the URL. The user is never
   stranded even if Velopack's auto-relaunch doesn't fire.

The overlay is pure client-rendered (already-loaded JS), so it survives the
server exiting during the swap.

## Components / files

| File | Change |
|---|---|
| `src/server/UpdateService.ts` | Linux local-mode branch in `applyUpdate` |
| `src/common/UpdateEvents.ts` | `mode?: 'reconnect'` on `UpdatesApplyResponse` |
| `src/server/api/UpdatesApi.ts` | Linux apply returns `mode:'reconnect'` |
| `src/app/client/UpgradingOverlay.ts` (new) | the overlay + reconnect-poll |
| `src/app/client/SettingsModal.ts` | wire apply → overlay on `mode:'reconnect'` |

## Error handling / edge cases

- **Apply throws** → existing 500 path (unchanged).
- **Port shifts** (rare; old port not freed in time) → reconnect-poll never
  matches → ~60s timeout → bookmark fallback. (Happy path is same-port.)
- **Velopack auto-relaunch fails on Linux** → app doesn't come back on its own,
  but the overlay's timeout fallback tells the user to reopen the URL; manual
  relaunch (known to work) lands them on the new version. Graceful degradation.

## Testing

- `UpdateService.applyUpdate` **Linux local** (TDD): asserts
  `waitExitThenApplyUpdate(update, true, true)` is called and **no** helper is
  spawned; `redirectPort` is null. Windows + service-mode branches unchanged
  (existing tests stay green).
- `UpdatesApi.handleApply` Linux: response carries `mode:'reconnect'`; Windows
  redirect path unchanged.
- `UpgradingOverlay` reconnect logic: given a stubbed `fetch`, transitions
  applying → reconnecting → done on version change, and → timed-out after the
  deadline.
- Full suite green (Windows apply/operation-server tests included).

## Verification (real Linux)

The one piece only a real install confirms is Velopack's Linux apply+relaunch.
Verify via **beta.25** (this fix) → **beta.26** (no-op target): install
beta.25, click update, confirm the overlay shows and the app reloads on
beta.26. If auto-relaunch doesn't fire, the timeout fallback still lands the
user on the new version after a manual reopen.
