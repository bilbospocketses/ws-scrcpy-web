# Linux user-scope service: install handoff + machine-wide re-exec (beta.46)

**Date:** 2026-06-07
**Status:** Approved — implementing
**Found by:** the `v0.1.30-beta.45` Fedora re-smoke (Module 4.2, user scope) — beta.45's F1 fix let the service get far enough to expose this.

## Problem

### F4 — the user-scope service loses the single-instance lock race
A user-scope service and the local app run as the **same user**, so they share the
per-`$XDG_RUNTIME_DIR` `flock` (`single_instance.rs`). The install fires
`systemctl --user enable --now` while the local app is still running and holding
the lock, so the service's `/opt` launcher starts, sees the lock held, logs
*"another ws-scrcpy-web-launcher instance is already running; exiting"* and exits
`0` in ~1 ms — never binding the port. Then the local instance exits too → nothing
left on 8000.

**Scope:** F4 is **user-scope only**. A system-scope service runs as **root** with
no `XDG_RUNTIME_DIR`, so its lock falls back to `/var/opt/.../control/instance.lock`
— a different file, no collision. (System scope may have a separate *port* handoff
wrinkle; that's verified separately when we test it.)

### F3 gap — verify was fooled
beta.45's Node-side `verifyServiceActive` polled `systemctl is-active`, which for a
`Type=simple` unit reports `active` the instant the process forks (systemd showed
`Duration: 141ms`). The poll caught that flicker and treated the start-then-exit-0
as success, so it never rolled back (the unit was left installed-but-dead).

### F5 — machine-wide install leaves the running instance on the deleted home mount
The machine-wide install relocates the binary to `/opt` and deletes the home
AppImage, but the **already-running** instance (which started before `/opt`
existed, so the bootstrapper ran in-place) never re-execs. It keeps serving from
its deleted AppImage FUSE mount (`/tmp/.mount_…`), shows a `(deleted)` path in the
process list, and holds both the FUSE mount and the single-instance lock.

## Design — beta.46

**Principle:** local→service is a *handoff* — the local instance must release the
lock before the service binds. Mirror the existing **uninstall→relaunch** detached
helper (`linux_service.rs::run` / `--linux-service-teardown`), reversed.

### F4 — detached install-handoff helper

1. **`SystemdClient.install` (Linux user scope):** write the unit + `systemctl
   --user enable` — **not `--now`**. (Root/system scope and Windows keep their
   current start-on-install.) The service is enabled but not started into a held
   lock; the helper starts it once the lock is free.
2. **`ServiceApi.handleInstall` (Linux user scope):** after `client.install()`,
   spawn a detached, out-of-cgroup helper (mirrors the teardown spawn):
   ```
   systemd-run --user --collect --unit=wsscrcpy-install-<ts> \
     <dataRoot>/control/operation-server/ws-scrcpy-web-launcher.exe \
     --linux-service-install-handoff --scope user --unit WsScrcpyWeb
   ```
   then schedule a **prompt** local-instance exit (release lock + port) and respond
   `{ ok: true, status: 'shutting-down', … }` so the frontend reconnects through the
   gap (same path uninstall already uses).
3. **New launcher handler `--linux-service-install-handoff`** (`linux_service.rs`,
   mirrors `run()`):
   1. **Wait for the lock to free** (the local instance exited) — poll a
      non-blocking `flock` probe / port-closed, up to ~20 s.
   2. `systemctl --user start WsScrcpyWeb.service`.
   3. **Verify it STAYS up:** poll `is-active == active` **AND** a TCP connect to
      the web port succeeds, for a few seconds (the real fix for the F3 flicker —
      a fork-then-exit unit never satisfies the port probe).
   4. **Success →** done (the frontend's reconnect poll lands on the service).
   5. **Failure →** roll back: `teardown_commands` (stop/disable/rm/reload) +
      relaunch local from the `local-appimage` marker (exactly like
      uninstall→relaunch). The user lands back in a working local app.

### F3 — verify moves to the helper (Linux user); Windows unchanged
The "stayed up + bound the port" check now lives in the handoff helper, which
outlives the local instance and can actually observe the post-handoff state.
beta.45's Node-side `verifyServiceActive` + rollback **stays for Windows** (and,
for now, Linux **system** scope). Linux user-scope routes through the helper.

### F5 — re-exec to /opt after machine-wide install
After `handleInstallSystemWide` succeeds, relaunch the running instance from
`/opt`: exit the local instance + `systemd-run --user --collect
/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage` (via the same helper seam), so it stops
running the deleted home mount, releases the FUSE mount, and holds `/opt`.

## Test plan

**Rust (`cross`, pure helpers — `run_install_handoff` itself is the exec seam,
Fedora-verified, like `run()`):**
- `start_command(scope, unit, bindir)` → `systemctl --user start WsScrcpyWeb.service`.
- `service_up(is_active, port_open)` predicate → true only when both hold.
- install-handoff arg parsing reuses `parse_args` (`--scope` / `--unit`).
- `single_instance`: a lock-free probe returns true when the lock is droppable.

**TS (vitest):**
- `SystemdClient.install` user scope → `enable` (no `--now`); root/system → `enable --now`.
- `ServiceApi.handleInstall` Linux user → spawns `--linux-service-install-handoff`
  via `systemd-run --user --collect`, schedules a prompt exit, responds
  `shutting-down`, and does **not** run the Node-side verify. Windows + Linux
  system scope still run the beta.45 verify/rollback.

## Rollout
`release:beta` PR (no manual bump — Mode 1) → squash-merge → **beta.46** → verify
`/releases/latest` = beta.46 → curate the releases page (delete the beta.45
release, keep its tag — per the established pattern) → re-smoke user-scope service
on the Fedora VM against beta.46.
