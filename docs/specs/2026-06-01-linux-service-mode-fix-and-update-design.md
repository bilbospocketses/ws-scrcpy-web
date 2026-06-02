# Linux service mode — fix install/uninstall + enable in-app updates (user + system scope)

**Date:** 2026-06-01
**Status:** Approved design
**Scope:** Linux **service mode** only (`installMode` = `user-service` / `system-service`). Windows and Linux **local** mode (the beta.27 path) are byte-for-byte untouched.

This is the direct follow-up to `2026-06-01-linux-appimage-self-update-design.md`, which deferred exactly this work in its "Out of scope": Linux service-mode update apply, item 32 (uninstall teardown), item 33 (system-scope SELinux AVC).

## Problem

Three defects, in dependency order. The service modes must be made *functional* (Phase 1) before in-app updates on top of them can be (Phase 2).

### Item 33 — system-scope install can't start (SELinux), confirmed in code

`ServiceApi.handleInstall` sets `binPath = process.env.APPIMAGE` (the **user-home** AppImage) for Linux (`ServiceApi.ts:240-242`), and `SystemdClient.install` renders the system unit with `ExecStart=${opts.binPath}` into `/etc/systemd/system/` (`SystemdClient.ts:178, 266`). A system unit runs under systemd's `init_t` domain; SELinux targeted policy (Fedora enforcing) denies `init_t` exec of a `user_home_t` file → `avc: denied { execute } scontext=…:init_t tcontext=…:user_home_t`. The service can't start; `Restart=on-failure` retries → the AVC repeats endlessly (observed: 7556 alerts in ~11h). User scope is unaffected — it runs as the unconfined user, which may exec home files.

### Item 32 — uninstall leaves the app half-torn-down, confirmed gap in code

Windows uninstall does an elaborate **out-of-process** handoff (operation-server + `post-stop.bat` + scheduled task + spawn a fresh local launcher — `ServiceApi.ts:406-474`, `supervisor.rs:196-307`). The Linux path (`SystemdClient.uninstall`) just runs `systemctl [--user] disable --now` **from the service's own Node process**, which is itself a member of the unit's cgroup. So the service stops the cgroup it is living in, with:
- no `reset-failed` (a failed/looping unit stays failed),
- no reap of children that **escaped** the cgroup (the `adb` daemon double-forks/daemonizes and is the prime suspect for "process still running"),
- no handoff to relaunch the app in local mode ("app non-functional").

The robust fix is correct regardless of the exact straggler; the precise process will be confirmed against the user's Fedora observation during verification.

### Service-mode update gap

`UpdateService.applyUpdate` early-returns **all** service mode into Velopack's `waitExitThenApplyUpdate` (`UpdateService.ts:446-449`) — the `UpdateNix apply` path proven broken on our AppImage (see the sibling spec). So Linux service-mode updates silently no-op. The beta.27 download-based apply that follows is gated local-only by that early-return.

## Goal

1. **System-scope service installs and runs** on SELinux-enforcing distros.
2. **Uninstall (both scopes) tears down cleanly** — unit removed, stragglers reaped, restart-loop cleared — and returns the user to a working local-mode app where appropriate.
3. **In-app updates apply + restart the service** in **both** `user-service` and `system-service` modes, without Velopack's apply, reusing the beta.27 download→verify→swap machinery.

## Hard constraints

- **Windows frozen.** All Windows `applyUpdate`/`handleInstall`/`handleUninstall` branches, the operation-server, and the Windows service-mode apply early-return are byte-for-byte unchanged. The full vitest + cargo suites stay green.
- **Linux local mode frozen.** The beta.27 local apply path (`installMode === 'user'`, `linux_apply.rs` bare-relaunch) is untouched.
- **Local-Dependencies-Only.** OS tools (`systemctl`, `pkexec`, `loginctl`, `ldconfig`, `systemd-run`, `cp`, `chmod`, `restorecon`, `chcon`, `semanage`) are invoked by **absolute path**, not bare name (closes the same PATH-hijack surface we closed on Windows with absolute `System32` paths). The app binary is the launcher helper already staged in `dataRoot`; `adb` is the bundled `<deps>/adb/adb`. This converts the existing bare-name calls in `SystemdClient` as part of the work.

## Key mechanism — the out-of-cgroup helper

In service mode the launcher → Node → adb/scrcpy-server all live in the **unit's cgroup**. systemd's default `KillMode=control-group` kills the entire cgroup on stop/restart. Therefore **any actor that must stop → swap/teardown → (re)start the unit cannot live in that cgroup**, or it is killed mid-operation. This single fact is the root of item 32 *and* the design of the Phase 2 apply.

The fix, shared by item 32 and Phase 2: perform the lifecycle work from a helper launched **outside** the unit's cgroup via **`systemd-run`** (a transient unit owned by the systemd manager — `--user` for user scope, the system manager for system scope). This is the systemd-idiomatic analogue of the Windows operation-server/post-stop handoff. The helper is the launcher binary already copied to `<dataRoot>/control/operation-server/ws-scrcpy-web-launcher` on every boot by `operation_server::refresh_helper_binary` (cross-platform, `supervisor.rs:123`).

> **Verify on Fedora:** the exact `systemd-run` invocation, including the `--user` cgroup-v2 nuance (systemd#3388), and that a transient unit survives `systemctl stop` of our service unit.

## Design

### Phase 1A — item 33: stage the AppImage to a system path (system scope)

System-scope install stages a root-owned, correctly-labelled copy and points the unit at it. All privileged steps run inside the **single existing pkexec command** in `SystemdClient.install`:

1. `mkdir -p /opt/ws-scrcpy-web`
2. `cp "<source $APPIMAGE>" /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage` (stable, channel-agnostic name so updates swap a known path)
3. `chmod 0755` the staged file
4. **Label `bin_t`** so `init_t` may exec it: prefer persistent `semanage fcontext -a -t bin_t '/opt/ws-scrcpy-web(/.*)?'` + `restorecon -Rv /opt/ws-scrcpy-web`; fall back to `chcon -t bin_t` when `semanage` is absent (no `policycoreutils-python-utils`). (`/opt` files otherwise often land `default_t`, which `init_t` can't exec.)
5. Write the unit with `ExecStart=/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage`, `daemon-reload`, `enable --now`.

`SystemdClient` derives the staged target internally for system scope; `ServiceApi` keeps passing the source `$APPIMAGE` as `binPath`. **User scope is unchanged** — `ExecStart=$APPIMAGE` (home), runs as the user, no SELinux issue.

> **Verify on Fedora:** that an `init_t` system service cleanly execs a `bin_t`-labelled `/opt` AppImage (FUSE-mounts as root, binds, no further AVC).

### Phase 1B — item 32: clean uninstall + return to local

Replace the in-cgroup self-uninstall with an out-of-cgroup handoff:

1. **`ServiceApi.handleUninstall` (Linux):** persist `installMode → local` (drop the `-service` suffix) *before* handing off (mirrors the Windows revert-first ordering), then `systemd-run` the staged helper with a new `--linux-service-teardown --scope <user|system> --unit <name>` subcommand and return. The unprivileged user-scope path uses `systemd-run --user`; the system-scope service is already **root**, so it uses the system manager directly (no pkexec).
2. **Helper (out of cgroup), new launcher mode:**
   - `systemctl [--user] stop <unit>` — synchronous; reaps everything *in* the cgroup (launcher, Node, in-cgroup children).
   - `systemctl [--user] disable <unit>`; `systemctl [--user] reset-failed <unit>` (clears the restart-loop state).
   - Remove the unit file (`~/.config/systemd/user/<name>.service` or `/etc/systemd/system/<name>.service`); for system scope also `rm -rf /opt/ws-scrcpy-web` and `semanage fcontext -d` the rule; `daemon-reload`.
   - Reap **escaped** stragglers: `adb kill-server` via the bundled `<deps>/adb/adb` (absolute path); best-effort kill of orphaned `scrcpy-server`.
   - Remove the tray autostart `.desktop` (user scope; already done today — keep).
   - **Relaunch policy:** *user scope* relaunches the home AppImage into local mode (desktop UX continuity); *system scope* tears down cleanly **without** auto-relaunch (headless-dominant — the admin re-launches their own AppImage), and the browser shows a "service removed" message. The home AppImage path for the user-scope relaunch is captured at install time in a `dataRoot/control/local-appimage` marker (consistent with the other control markers), used only if it still exists, else fall back to the browser-guidance message.

### Phase 2A — user-scope update

1. Narrow the `applyUpdate` service-mode early-return to **Windows only** (`isServiceMode && this.platform === 'win32'`), so Linux service mode falls through to a new service-aware path.
2. Linux user-service apply: reuse the existing download → `SHA256SUMS` verify → staging-file machinery (identical to the local path). Then `systemd-run --user` the staged helper with `--linux-apply --staged <new> --target <$APPIMAGE> --service-restart user --unit <name>`.
3. **Extend `linux_apply.rs`:** when `--service-restart <scope> --unit <name>` is present, the post-download sequence becomes `systemctl [--user] stop <unit>` (synchronous) → brief settle/poll until the AppImage file is unlocked (FUSE unmount) → `swap_appimage` (reused) → `systemctl [--user] start <unit>`, instead of the bare relaunch. No `--wait-pid` needed (stop is synchronous).
4. The service Node does **not** `process.exit`; the helper stops the unit. No privilege needed (user manager, home AppImage, user-owned).
5. **UI:** the service rebinds the **same** configured web port, so the existing in-browser `reconnectAfterApply` + top-layer `UpgradingOverlay` (`mode:'reconnect'`) bridges the gap. No operation-server needed (unlike Windows, there is no port-shift). Confirm by test + on Fedora.

### Phase 2B — system-scope update

The system service runs as **root**, so the apply handler (hit from the browser → root service Node) can do the privileged work directly — **no pkexec prompt → headless-capable**:

1. Download + verify to a root-writable staging file under `dataRoot`.
2. `systemd-run` (system manager) the staged helper with `--linux-apply --staged <new> --target /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage --service-restart system --unit <name> --relabel`.
3. Helper: `systemctl stop <unit>` → swap the `/opt` copy → re-apply the `bin_t` label (`restorecon`, or `chcon -t bin_t`) → `systemctl start <unit>`.

> **Verify on Fedora (the open risk):** whether the `init_t`-domain service / its `systemd-run` transient unit may write `/opt`, relabel, and run `systemctl` under enforcing SELinux. If blocked, ship a **narrow, targeted** policy allowance for this app's path only — **never** broad `audit2allow` (the todo's explicit prohibition).

## Components / files

| File | Change |
|---|---|
| `src/server/api/ServiceApi.ts` | Linux install: keep passing source `$APPIMAGE`; persist `localAppImagePath` for the uninstall relaunch. Linux uninstall: replace the direct `client.uninstall()` with revert-to-local + `systemd-run` handoff to the teardown helper. |
| `src/server/service/SystemdClient.ts` | System-scope: stage to `/opt` + label `bin_t` inside the pkexec command; render unit `ExecStart` = staged path. Uninstall logic moves to the launcher helper (out-of-cgroup); `SystemdClient` retains pure unit/path/command builders. Convert bare-name OS-tool calls to absolute paths. |
| `src/server/UpdateService.ts` | `applyUpdate`: narrow the service early-return to win32; add the Linux service-apply path (download→verify→`systemd-run` helper with `--service-restart`). |
| `launcher/src/linux_apply.rs` | Add `--service-restart <user\|system> --unit <name> [--relabel]`: stop → settle → swap → (relabel) → start, instead of bare relaunch. Pure command/sequence builders unit-tested. |
| `launcher/src/main.rs` | Wire `--linux-service-teardown`; extend `linux_apply` arg parsing. |
| `launcher/src/linux_service.rs` (new, or extend `linux_apply.rs`) | Teardown sequence (stop/disable/reset-failed/rm/relabel-cleanup/reap/relaunch) as pure, testable builders + a thin exec seam. |
| OS-tool resolver (new small module) | Absolute-path resolution for `systemctl`/`pkexec`/`systemd-run`/`restorecon`/`chcon`/`semanage`/`cp`/`chmod` (checks known `/usr/bin`,`/usr/sbin`,`/bin`,`/sbin` locations). |
| Tests | vitest: install (system→staged binPath, user→home), uninstall handoff (marker + `systemd-run`, not direct disable), Linux service-apply branch (download→verify→`systemd-run`; **win32 service early-return preserved**), absolute-path resolver. cargo: `linux_apply` swap/restore (existing) + service-restart + teardown command builders. |

## Error handling / edge cases

- Download fail / SHA-256 mismatch → abort before any stop/swap; the service stays on the current version.
- `systemd-run` absent (non-systemd host) → error with guidance (systemd-run ships with systemd; service mode already requires systemd).
- Helper swap fail → restore `<target>.bak`, do **not** `start` into a broken binary; write a `dataRoot/control/update-error` marker; the unit can be re-started on the old version.
- SELinux denies the 2B privileged ops → error marker + guidance; ship a narrow targeted policy only if Fedora testing requires it.
- pkexec dismissed at install/uninstall → surfaced as today (`authentication was dismissed`).
- **Headless system scope:** install/uninstall need a polkit agent (an at-the-machine admin action — a pre-existing constraint from item 28); **updates do not** (root self-update). Documented, not a regression.
- User-scope relaunch when the home AppImage was moved/renamed → write marker + browser guidance instead of relaunching a missing path.

## Testing

- **vitest (TDD, injected `fetch`/`fs`/`spawn`/exec):** install scope→binPath mapping; uninstall writes the handoff + invokes `systemd-run` (never a direct in-cgroup `disable --now`); `applyUpdate` Linux service path downloads→verifies→`systemd-run`s the helper; **Windows service-mode apply unchanged** (still the `waitExitThenApplyUpdate` early-return — the freeze guardrail); absolute-path OS-tool resolver.
- **cargo (tempdir/pure):** `linux_apply` backup/swap/restore (existing) + the new `--service-restart` command sequence builder + the teardown sequence builder (stop/disable/reset-failed/rm/reap order).
- **Full existing suite green** — Windows + Linux-local tests are the regression fence.

## Verification (real Fedora — the oracle)

1. **system install:** service reaches `active` with no AVC; `init_t` execs the `bin_t` `/opt` AppImage.
2. **uninstall (both scopes):** unit gone, `reset-failed` clears the loop, no straggler (adb daemon reaped); user-scope relaunches local; system-scope clean teardown + browser message.
3. **user-scope update:** beta.N → N+1, service restarts on the same web port, browser reconnects via the overlay.
4. **system-scope update:** beta.N → N+1 **headless** (no prompt) — root self-update swaps `/opt` + restarts; confirm `init_t` may write/relabel/`systemctl` (or scope a narrow policy).
5. **out-of-cgroup helper:** the `systemd-run` transient unit survives `systemctl stop` of our service unit.

## Out of scope (separate work)

- **Phase 3 UX (deferred per user, after Phases 1+2):** restyle the "Administrative Privileges Required" confirm-modal buttons (`cancel`/`continue`, install + uninstall variants) to **white outline + white text**, matching the welcome/bookmark/service-mode modals (beta.29). Platform-agnostic CSS.
- **Device-name SQLite DB** in `dataRoot` — unrelated deferred item, tracked separately in `todo_ws_scrcpy_web.md`.
- **Velopack 1.0.1 → 1.1.1 (item 31)** and the libfuse2-gate removal.
- **System-scope-as-root posture** — a system unit with no `User=` runs the whole app (adb/scrcpy) as root. This is the existing item-28 design; not changed here.
