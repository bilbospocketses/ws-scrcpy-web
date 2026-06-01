# Linux AppImage self-update (local mode) — replace Velopack apply

**Date:** 2026-06-01
**Status:** Approved design
**Scope:** Linux, `installMode === 'user'` (local) only. Windows and Linux service mode are untouched.

## Problem

Velopack 1.0.1's `UpdateNix apply` cannot apply updates to our AppImage. Confirmed from
`/tmp/velopack.log` on real Fedora: the updater spawns, finds the downloaded package, then
fails in the same millisecond — `Apply error: This application is not properly installed:
Update.exe does not exist in the expected path` — before touching a single file.

Root cause: `UpdateNix` is launched (`velopack` crate `manager.rs::unsafe_apply_updates`) with
only `apply --package <nupkg> --waitPid <pid> [--silent] --root <$APPIMAGE>`. It re-derives its
**own** locator from `--root` via `Context: FromSpecifiedRootDir(<appimage>, None)`; the derived
`UpdateExePath` does not exist, so `VelopackLocator::new` (`locator.rs:114`) returns
`NotInstalled`. The explicit `VelopackLocatorConfig` our Node code builds is used only for
*discovery* (`checkForUpdatesAsync`, which works) and is **not** propagated to the apply binary.

The failure is mode- and restart-independent: reproduced in a clean local install
(`installMode:"user"`, `Restart:true` — i.e. PR #246's actual Linux branch) and in prior
service-mode runs (`Restart:false`), always the identical error. The 60 MB nupkg downloads and
validates; the apply never runs; the install stays on the old version; nothing relaunches.

PR #246's `waitExitThenApplyUpdate(restart=true)` change is therefore inert on Linux — the call
is made, Velopack simply cannot honor it. Velopack 1.1.1's changelog shows no fix for this path
(its Linux change is the AppImage type-2 runtime, PR #899).

**Secondary defect (Bug A):** `UpgradingOverlay` (a `position:fixed; z-index:99999` div appended
to `document.body`) renders *behind* the Settings modal, because the Settings modal is a native
`<dialog>` opened with `showModal()` → the browser **top layer**, which paints above the entire
normal-DOM stacking context regardless of z-index. This hides the overlay's timeout fallback
("reopen the url"), so when apply fails the user is given no guidance.

## Goal

1. Linux local-mode in-app updates **apply and relaunch** on the new version, deterministically,
   without depending on Velopack's updater.
2. The upgrading overlay — and especially its fallback message — is **always visible**.

## Hard constraints

- **Windows frozen.** `launcher/src/operation_server.rs`, the Windows `applyUpdate` /
  `handleApply` branches, and the service-mode branch are byte-for-byte unchanged. The full
  vitest suite — including the Windows operation-server + service-mode apply tests — stays green.
- **Linux service mode untouched.** Out of scope; a separate task set (with items 32/33).
- **Local-Dependencies-Only.** No system-PATH / env-var binary resolution. The apply helper is
  the app's own launcher binary, already staged inside the app's `dataRoot`.

## Design

### Discovery (unchanged, with one trim)

Velopack `checkForUpdatesAsync` continues to detect the available version from the
`releases.linux-<channel>.json` feed (works today via the explicit locator). On Linux,
**skip the Velopack nupkg auto-download** (`downloadIfNeeded`): set status `ready` on
availability without fetching the now-unused 60 MB nupkg. Our apply downloads the AppImage
instead.

### Apply — Node (`UpdateService.applyUpdate`, Linux local branch)

Replaces the `waitExitThenApplyUpdate` call for the Linux-local case
(gated `this.platform !== 'win32' && installMode === 'user'`):

1. Resolve target version (`state.availableVersion`) and channel (`linux-<beta|stable>`).
2. Stream-download the release AppImage asset to a staging file in `dataRoot` (outside the
   AppImage mount, so it survives the app exiting):
   - URL: `https://github.com/<owner>/ws-scrcpy-web/releases/download/v<version>/WsScrcpyWeb-linux-<channel>.AppImage`
   - Dest: `<dataRoot>/control/update-staging/WsScrcpyWeb-linux-<channel>.AppImage.new`
3. Download `SHA256SUMS` from the same release; find the line whose filename column equals the
   AppImage asset name; verify the staged file's SHA-256 against that hash.
   **On download error or hash mismatch → abort: return an error, do NOT `process.exit`.** The
   app keeps running on the current version.
4. Spawn the staged helper, detached:
   `<dataRoot>/control/operation-server/ws-scrcpy-web-launcher --linux-apply --staged <new> --target <$APPIMAGE> --wait-pid <pid>`
5. Return `{ redirectPort: null }`; `handleApply` returns `{ ok:true, mode:'reconnect' }` (the
   existing PR #246 path); the existing deferred `process.exit(0)` runs.

Network + SHA-256 verification live in Node (HTTP + `crypto` already available in the server
stack). The helper performs only the post-exit file operation.

### Apply — helper (launcher, new `#[cfg(target_os = "linux")]` `--linux-apply` mode)

The helper is the launcher binary already copied to `<dataRoot>/control/operation-server/` by
`operation_server::refresh_helper_binary` on every boot — outside the mount, so it survives the
unmount. New subcommand:

1. Parse `--staged`, `--target` (= `$APPIMAGE`), `--wait-pid`.
2. Wait for the pid to exit (poll, bounded ~60 s).
3. Back up `--target` → `<target>.bak`.
4. Move staged → target: `rename` when same filesystem, else copy + `fsync` + `rename`;
   `chmod 0755` the result.
5. Relaunch: `exec` (or spawn-detached) `--target`; the helper then exits. The new AppImage
   re-mounts, runs the launcher, binds the freed web port.
6. Any failure before relaunch → restore `<target>.bak` and write a
   `<dataRoot>/control/update-error` marker; do not relaunch.

SELinux (Fedora): the helper runs as the user (`unconfined_u`) and execs a `user_home_t`
AppImage, which is permitted in user scope — only the `init_t` system-service path (item 33) was
denied.

### Client (Bug A fix + reuse)

- Reuse `runUpgradingHandoff` / `reconnectAfterApply` (built in PR #246): on `mode:'reconnect'`,
  show the overlay, poll the same origin, reload on a new version, timeout → "reopen `<url>`".
- **Fix:** make `UpgradingOverlay` render in the top layer — build it as a `<dialog>` element
  appended to `document.body` and opened with `showModal()` (shown last → above the Settings
  `<dialog>`). Keep the inline critical styles (it must render with the stylesheet mid-reload).
  No z-index reliance.

## Components / files

| File | Change |
|---|---|
| `src/server/UpdateService.ts` | Linux-local: skip nupkg download in `checkForUpdates`; in `applyUpdate`, replace `waitExitThenApplyUpdate` with download → verify → spawn-helper. New private helpers: release-asset URL builder, `downloadToFile`, `verifySha256`, `parseSha256Sums`. |
| `src/server/api/UpdatesApi.ts` | No change expected (`mode:'reconnect'` already returned for non-win32). Re-confirm by test. |
| `src/app/client/UpgradingOverlay.ts` | Render as a top-layer `<dialog>` via `showModal()` (replaces the body-appended `z-index:99999` div). `remove()` calls `close()` then removes. |
| `launcher/src/linux_apply.rs` (new) + arg wiring in `launcher/src/main.rs` | `--linux-apply` mode: wait-pid, backup, swap (rename / copy-fallback), relaunch, restore-on-fail. Gated `#[cfg(target_os = "linux")]`. |
| Tests | Node apply branch + SHA verify; Rust swap/restore; client overlay top-layer. |

## Error handling / edge cases

- Download fail / SHA mismatch → abort before any swap; app unaffected, stays on current version.
- Helper swap fail → restore backup + error marker; the current version still launches.
- Relaunch fail → the now-visible overlay timeout fallback tells the user to reopen the URL;
  the new AppImage is already in place, so a manual reopen lands on the new version.
- `$APPIMAGE` moved/renamed by the user → `--target` is the actual `process.env.APPIMAGE` path
  captured at apply time; if it is not writable, abort with an error marker (no partial state).
- `dataRoot` and `$APPIMAGE` on different filesystems → copy + rename fallback in the helper.
- `<target>.bak` is cleaned on the next clean launch.

## Testing

- `UpdateService` Linux-local apply (TDD, injected `fetch`/`fs`/`spawn`): downloads → verifies →
  spawns the helper → returns `mode:'reconnect'`; SHA mismatch → abort, no spawn, error surfaced;
  Linux `checkForUpdates` does **not** download the nupkg.
- SHA-256 verify + `SHA256SUMS` parse — unit tests (good hash passes, bad hash fails, correct
  line selected).
- Rust helper: backup / swap / restore decision logic in a tempdir (same-fs rename succeeds;
  induced failure restores the backup). The wait-pid + exec is covered by a thin integration
  seam; the file-op core is a pure, unit-tested function.
- Client: `UpgradingOverlay` calls `showModal()` and mounts a `<dialog>` (jsdom).
- **Full existing suite green** — Windows operation-server + service-mode apply tests unchanged
  (the freeze guardrail).

## Verification (real Linux)

Cut a beta, install in user mode on Fedora, click update → the overlay is visible → the app
relaunches on the new version. Confirm: `$APPIMAGE` is rewritten (mtime + reported version
change), `.bak` is cleaned on the next launch, and `/tmp/velopack.log` no longer shows an
`UpdateNix` apply attempt (the updater is no longer invoked for apply).

## Out of scope (separate task sets)

- Linux **service-mode** (user-service + system-service) update apply.
- Item 32 (service uninstall teardown) and item 33 (system-scope SELinux AVC).
- Velopack 1.0.1 → 1.1.1 bump (item 31) — now decoupled from the apply fix; its remaining value
  is the type-2 runtime / libfuse2-gate removal only.
