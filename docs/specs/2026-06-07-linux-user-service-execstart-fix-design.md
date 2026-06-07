# Linux user-scope service: stable ExecStart + install rollback (beta.45)

**Date:** 2026-06-07
**Status:** Approved — implementing
**Found by:** the `v0.1.30-beta.44` Fedora smoke (Module 4.2, user scope)

## Problem

Installing a **user-scope** systemd service on Linux leaves the app dead and
unrecoverable. Three compounding bugs, all confirmed at runtime + in code during
the beta.44 Fedora smoke:

### F1 — user-scope `ExecStart` points at the volatile launch path

`ServiceApi.handleInstall` sets `binPath = $APPIMAGE` (the running AppImage's
path, e.g. `~/Downloads/WsScrcpyWeb-linux-beta.AppImage`). For **system** scope
`renderUnitFile` overrides `ExecStart` to the staged `/opt` copy, but for **user**
scope it uses `binPath` verbatim (`SystemdClient.ts:241-243`). That path is:

- **volatile** — it is the throwaway installer artifact (machine-wide install
  deletes it; users delete downloads), and
- **possibly not executable** — a browser-downloaded AppImage is `-rw-r--r--`
  (the GUI/Dolphin can still launch it, but systemd's `ExecStart` does a raw
  `execve()` that requires `+x`).

Result: the unit fails `status=203/EXEC ("Permission denied")` on every start,
hits `StartLimitBurst`, and gives up. (Confirmed **not** SELinux — `ausearch -m
avc` was empty; the Downloads AppImage was labeled `user_home_t` and `-rw-r--r--`,
while a perfectly good `/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage` — `0755`, `bin_t`
— sat unused.)

### F2 — PATH-reliant tray autostart written on Linux (Local-Deps violation + residue)

User-scope install calls `writeTrayAutostart` (`SystemdClient.ts:824-851`). When
no tray binary is found on disk (`resolveTrayHelperPath()` → null), it falls back
to `Exec=ws-scrcpy-web-tray` — a **bare name resolved via `PATH`**. On Linux that
fallback is *always* taken (there is no Linux tray — item 27), so every install
writes `~/.config/autostart/ws-scrcpy-web-tray.desktop` pointing at a nonexistent
PATH binary. This violates Local-Dependencies-Only and leaves orphaned autostart
residue (the Linux uninstall path — `systemd-run` teardown — bypasses
`removeTrayAutostart`, so it is never cleaned).

### F3 — install never verifies the service started; no rollback

`handleInstall` schedules `process.exit(0)` on a fixed 15 s timer
(`ServiceApi.ts:446-451`) **without checking the service is active**, and returns
`ok:true`. `install()` does not throw on a failed start (systemd `Type=simple`
reports "started" on fork, before the `execve` fails), so the existing error path
never fires. A failed start therefore kills the local instance anyway → the app
self-destructs with no fallback, no error, and a stale `installMode=user-service`
left in config.

## Design

### F1 — resolve a stable, executable `ExecStart` for user scope (Approach A)

In `SystemdClient.install()` (user-scope branch), resolve the unit's binary
**before** rendering:

1. If the machine-wide binary exists (`/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage`,
   already `0755` / `bin_t`) → `ExecStart` = that path. No copy.
2. Otherwise → copy the source AppImage (`opts.binPath`) to a stable per-user
   location **`<dataRoot>/bin/WsScrcpyWeb.AppImage`**, `chmod 0755`, and
   `ExecStart` = that copy.

Either way the target is stable and guaranteed executable. `WorkingDirectory`
becomes the directory of the resolved binary. `ServiceApi` passes `dataRoot` in
the install options for Linux (currently omitted) so the client can compute the
`bin/` location. This mirrors how system scope already stages to a stable path,
and keeps everything under the app's own dataRoot (Local-Deps-clean).

Rejected: (B) always copy to `<dataRoot>/bin` even when `/opt` has it — needless
61 MB duplication; (C) just `chmod +x $APPIMAGE` in place — leaves the volatility.

### F2 — never emit a PATH-reliant tray autostart

In `writeTrayAutostart`, when `resolveTrayHelperPath()` returns null, **skip
writing** (log + return) instead of falling back to the bare-name `Exec`. The
absolute-path write stays for any future bundled tray binary. On Linux (no tray)
this makes the call a clean no-op — no Local-Deps violation, no orphaned residue.

### F3 — verify active, then roll back on failure

Replace the unconditional scheduled exit in `handleInstall` with:

1. Poll `client.status()` until it returns `running`, up to ~15 s
   (condition-based wait, short interval).
2. **Active** → proceed exactly as before (schedule the local-instance exit, hand
   off, `ok:true`).
3. **Never active** → roll back:
   - `client.uninstall(WS_SCRCPY_SERVICE_NAME)` — remove the dead unit,
   - revert `installMode` to the previous value,
   - return `ok:false` with `reason:'service-start-failed'` (+ a short detail),
   - **do not** schedule the exit — the local instance stays alive so the user
     lands back in a working local app instead of a dead one.

This makes *any* failed service start recoverable (not just F1's) and auto-fixes
the stale-`installMode` artifact.

## Test plan (vitest, TDD — failing first)

- `renderUnitFile` user scope → `ExecStart` is the `/opt` binary when the
  machine-wide AppImage exists; otherwise the `<dataRoot>/bin` copy. Never the
  raw `opts.binPath`.
- staging: when no `/opt` binary, `install()` copies the source AppImage to
  `<dataRoot>/bin/WsScrcpyWeb.AppImage` and `chmod`s it `0755`.
- `writeTrayAutostart`: writes nothing (and no PATH-bare `Exec`) when no tray
  binary resolves; still writes an absolute-path entry when one is found.
- `handleInstall`: when the service never reaches `running`, it calls
  `uninstall`, reverts `installMode`, responds `ok:false` /
  `reason:'service-start-failed'`, and does **not** schedule a process exit.

No Rust changes — all three fixes are in TypeScript (`SystemdClient.ts`,
`ServiceApi.ts`, `ServiceClient.ts` for the options/reason types).

## Rollout

`release:beta` PR (no manual version bump — Mode 1 auto-cuts it) → squash-merge →
auto-release cuts **`v0.1.30-beta.45`** (Windows + Linux). Then delete the
**beta.44** GitHub release (keep its tag) and re-run the Module 4 / 5 / 6
service-mode smoke on the Fedora VM against beta.45.
