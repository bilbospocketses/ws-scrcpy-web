# Stop-Server-&-Exit button + item-40 residuals — design

**Date:** 2026-06-02
**Items:** todo §27 (in-app exit for Linux / all platforms) + §40 residuals (40a, 40b, 40c)
**Ships in:** v0.1.30-beta.39 (combined vehicle for the next Fedora smoke)

---

## Background — two corrections from reading the current code

The §27 todo entry was written from assumptions that the code does not support. Both
were verified against the tree before this design:

1. **"exit code 75 signals the launcher to quit cleanly" — INVERTED.**
   `launcher/src/supervisor.rs:25` defines `const EXIT_RESTART: i32 = 75`, and
   `decide_restart(exit_code, marker_exists)` *restarts* on `exit_code == 75` or a
   `.restart` marker. `src/server/index.ts:295` documents it: "process.exit(75)
   (restart-for-update) bypasses [cleanup] so the daemon stays alive across
   supervisor-driven restarts." **A clean quit is `process.exit(0)` with no restart
   marker** → `decide_restart(0, false) == None` → supervisor logs "clean exit; not
   restarting" and returns. **No new launcher exit-signal is needed for the quit.**

2. **"new `/api/app/quit` + `AppApi` + `ExitAppModal`" — mostly already exists.**
   `src/server/api/ServerShutdownApi.ts` already serves `POST /api/server/shutdown`
   → `process.exit(0)`, and its own doc comment says it exists for *"the Settings
   'Stop Server & Exit' button, lands later."* This item **is** that button.
   `src/app/client/ConfirmModal.ts` (`ConfirmModal.confirm({title,message})`) already
   covers the dialog. No dedicated modal, no new endpoint.

### The real problem to solve

`ServerShutdownApi` calls `process.exit(0)` **directly**, which does **not** run the
SIGINT/SIGTERM cleanup in `index.ts:267 exit()` — the part that does
`scanAdb.killServer()` + `runningServices.forEach(s => s.release())`. So the existing
quit path **orphans the adb daemon** (and any running services). Item 27 is therefore:
a frontend button + making the quit path run the existing cleanup + reaping the
Windows tray, which is otherwise left behind.

---

## Decisions (locked with user, 2026-06-02)

- Reuse + fix `/api/server/shutdown` (one cleanup path), **not** a new endpoint.
- Button lives in the existing Settings service/updates area, **all platforms**.
- **Windows:** the quit must also reap the tray helper.
- **Service mode:** the button is **disabled + a neutral note**, not actionable.

---

## Design

### Layer 1 — server: shared `gracefulShutdown()`

`src/server/index.ts`

- Extract the cleanup body of `exit(signal)` into an exported, awaitable
  `gracefulShutdown(): Promise<void>` that performs the existing steps:
  `scanAdb.killServer()` (await, best-effort) + `runningServices.forEach(s => s.release())`,
  preserving the `interrupted` double-invoke guard and the 10s exit watchdog.
- SIGINT/SIGTERM handlers call `gracefulShutdown()` then exit (current behavior,
  unchanged observable result).
- **Exit-75 path stays bypassed** — restart-for-update must not kill the adb daemon.

`src/server/api/ServerShutdownApi.ts`

- Before scheduling `process.exit(0)`, `await gracefulShutdown()` so the adb daemon +
  services are torn down on the button/tray path too. Response is still written first
  (200 `{ok:true}`), then cleanup + exit on the scheduled tick. Keep the injected
  `schedule`/`exit` seams for unit tests; inject the cleanup fn too so tests assert it
  ran without killing the Vitest worker.
- This also fixes the latent orphan on the existing Windows-tray shutdown path
  (no-accepted-tech-debt).

### Layer 2 — frontend: the button + gating

`src/app/client/SettingsModal.ts` (+ reuse `ConfirmModal`)

- Add a **`stop server & exit`** button (lowercase, app motif) in the service/updates
  area of Settings.
- Flow: click → `ConfirmModal.confirm({title, message})` → on `true`, `POST
  /api/server/shutdown` → then `window.close()`; if the tab can't self-close, navigate
  to `about:blank` and show inline "app stopped — close this tab".
- **Service-mode gating:** when `/api/service/status` reports an installed service
  (the signal the modal already consumes for scope pre-selection), render the button
  **disabled** with a neutral note: *"managed by the system service — stop via your
  service manager, or uninstall the service."* (Clicking it in service mode would
  fight the service manager / trigger a restart, so it must not be actionable.)

### Layer 3 — launcher: Windows tray reap

`launcher/src/main.rs` (`#[cfg(windows)]`)

The tray helper is spawned **detached** (`DETACHED_PROCESS`, `tray_supervisor.rs:276`)
and is **not** adopted into the kill-on-close Job Object, so it deliberately survives
launcher exit; the supervisor also respawns it every 10s. A clean `process.exit(0)`
therefore leaves an orphaned tray pointing at a dead launcher.

- At the launcher's **terminal exit** — after `supervisor::run()` returns (it loops
  internally for restarts and only returns on a real terminal exit) and before
  `std::process::exit(exit_code)` — reap the tray with
  `taskkill /F /IM ws-scrcpy-web-tray.exe` (the same call the supervisor already uses
  for stale-tray cleanup, `tray_supervisor.rs:140`).
- **Gate:** skip the reap when an `apply-update-pending` **or** `uninstall-pending`
  marker is present under `<dataRoot>/control/` — those terminal exits are
  exit-to-relaunch (update apply / uninstall handoff) and the tray must persist /
  is handled by that flow. A plain quit has no marker → tray reaped.
- Set the tray-supervisor `stop_flag` (returned by `start_background`) before the
  reap if it's held at that scope, so no respawn races the kill; the immediate
  `process::exit` makes this belt-and-suspenders. Confirm `start_background`'s
  `stop_flag` is reachable at the exit site during implementation.

This is a general orphan-tray-after-terminal-exit fix, not just the button path.

---

## Item 40 — residuals

### 40a — Rust `data_root` honors `DATA_ROOT` (Linux)

`common/src/config.rs`. TS `resolveDataRoot` (Config.ts:151) resolves
`DATA_ROOT > XDG_DATA_HOME > ~/.local/share` on non-Windows, but
`data_root_for_linux` / `data_root_from_env` only do `XDG_DATA_HOME > HOME` — the
explicit `DATA_ROOT` launcher-bridge override is ignored. Add an injectable
`data_root` override param to the pure `data_root_for_linux` (mirrors the existing
injectable-param test pattern) and read `DATA_ROOT` first in the non-Windows branch of
`data_root_from_env`. Windows branch unchanged (TS also ignores `DATA_ROOT` on win32).
Confirm the launcher's own `DATA_ROOT`-set site so honoring it here is not circular.
Add Rust unit tests mirroring the TS precedence. `cross test --workspace` is authoritative.

### 40b — neutral `renderServiceInfo` for system-scope uninstall

`src/app/client/SettingsModal.ts`. The system-scope uninstall **success** follow-up
(`uninstallFollowupMessage('system')`, ~line 1172) is rendered through
`renderServiceError` (red label + "retry" button) though it is informational. Add a
neutral `renderServiceInfo(msg)` sibling (no error class, no retry) and use it for that
path. Add a test.

### 40c — fix stale comment

`src/server/UpdateService.ts:592`. The comment cites
`launcher/src/post_stop_handler.rs::marker_path`, which does not exist. Correct it: the
marker path is `<dataRoot>/control/apply-update-pending`, produced/consumed by
`launcher/src/linux_apply.rs::apply_marker_path` (Linux) and the bat written by
`launcher/src/elevated_runner.rs::write_post_stop_bat` (Windows), with
`Config.applyUpdatePendingMarkerPath` as the Node-side source of truth. Comment-only.

---

## Testing

- **vitest:** `gracefulShutdown` runs on the `/api/server/shutdown` path (injected
  cleanup spy); SettingsModal button (confirm → POST → close path) + service-mode
  disabled+note; `renderServiceInfo` neutral styling.
- **cross test --workspace** (Linux, authoritative for cfg-gated Rust): `data_root`
  `DATA_ROOT`-precedence cases; Windows tray-reap marker-gate is `#[cfg(windows)]`
  pure-logic where extractable (the `taskkill` itself is VM-smoke-verified).
- **clippy** `-D warnings`.

## Smoke additions (before the run)

- 27 / Windows local: quit → app fully exits, **tray icon gone**, no orphaned
  `node.exe` / `adb.exe` / tray.
- 27 / Windows update: an in-app update still **keeps** the tray (marker gate).
- 27 / Linux local: quit → clean exit, `adb kill-server` ran, no orphans;
  `window.close()` fallback notice shows.
- 27 / service mode (both OS): button **greyed with the note**, not actionable.
- 40b: system-scope uninstall follow-up renders as **neutral info**, not red/retry.

## Out of scope

- Linux tray (none exists). macOS (not shipped).
- Any change to the exit-75 restart/update path.
