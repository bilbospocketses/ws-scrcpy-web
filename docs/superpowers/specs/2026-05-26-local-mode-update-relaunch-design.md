# §40 — Local-mode update relaunch

## Problem

`waitExitThenApplyUpdate(restart=true)` fails silently in local mode. Velopack's Update.exe cannot relaunch the app under a non-elevated user identity — the `current/` swap either fails or completes but Update.exe can't start the new binary. The app comes back on the old version with no error. Service mode works because `restart=false` + Servy's post-stop.bat handles the relaunch under LocalSystem.

## Solution

Make local mode work like service mode: `restart=false` for all modes + our own relaunch mechanism.

### Change 1: UpdateService.ts

Change line 377 from:
```typescript
this.mgr.waitExitThenApplyUpdate(this.state.pendingUpdate, true, !isServiceMode);
```
to:
```typescript
this.mgr.waitExitThenApplyUpdate(this.state.pendingUpdate, true, false);
```

`restart=false` for ALL modes. We own the relaunch in both service mode (post-stop.bat + `sc start`) and local mode (new local-post-stop.bat).

### Change 2: supervisor.rs

In the local-mode apply-update branch (the block that checks `!cfg_now.is_service_mode()` + marker exists), after spawning the operation-server, generate and spawn a local-post-stop.bat:

```bat
@echo off
timeout /t 12 /nobreak >nul
start "" "<install_root>\current\ws-scrcpy-web-launcher.exe"
exit /b 0
```

- Written on-the-fly to `<dataRoot>/control/local-post-stop.bat` (Velopack-untouchable location)
- Spawned detached via `cmd.exe /c` (fire-and-forget)
- The 12s sleep matches the service-mode post-stop bat's proven timing
- After the sleep, `current/` has been swapped by Update.exe → bat launches the NEW launcher
- New launcher starts → writes operation-server stop marker → operation-server winds down → browser navigates

### What doesn't change

- **Operation-server** — still spawned by the supervisor, still serves "updating, please wait" page, still winds down on stop marker from the new launcher
- **Service-mode flow** — completely untouched (Servy's post-stop.bat + `sc start`)
- **Frontend** — no changes (upgrade-server page works the same)
- **Marker lifecycle** — apply-update-pending marker still deleted by supervisor before spawning (existing code)

### Sequence (local mode, after fix)

```
t=0s    Node calls waitExitThenApplyUpdate(restart=false)
t=0s    Node exits cleanly
t=0s    Supervisor: sees clean exit + apply-update marker
t=0s    Supervisor: deletes marker
t=0s    Supervisor: spawns operation-server (binds port 8000)
t=0s    Supervisor: writes + spawns local-post-stop.bat
t=0s    Supervisor: exits
t=~1s   Velopack Update.exe calls --veloapp-obsolete (old binary)
t=1-3s  Update.exe swaps current/ (no relaunch — restart=false)
t=0-12s Operation-server serves "updating, please wait" page
t=12s   local-post-stop.bat sleep finishes → launches current/launcher.exe (NEW version)
t=12s   New launcher starts → writes stop marker
t=12s   Operation-server detects stop marker → enters wind-down
t=~15s  New Node starts, binds port → operation-server navigates browser
```

### Files changed

| File | Change |
|------|--------|
| `src/server/UpdateService.ts` | `restart` param: `!isServiceMode` → `false` |
| `launcher/src/supervisor.rs` | Write + spawn local-post-stop.bat in apply-update branch |
