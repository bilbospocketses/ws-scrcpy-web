# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.14] - 2026-04-28

### Fixed

- **Welcome modal didn't redisplay after dismiss-without-checkbox.** Pre-v0.1.14 the gate ANDed `firstRunComplete === false` with `!welcomeDismissed`. Clicking "no, run on demand" without the checkbox PATCHed `firstRunComplete=true` server-side but left `welcomeDismissed` unset, so the gate evaluated `false && true = false` and the welcome modal stayed silent on refresh — `PortChangeModal` fired instead. Gate now uses the localStorage flag alone; modal redisplays until the user explicitly checks "don't show again," matching the original spec.
- **Port modal could redundantly fire on first-run pages.** Both `WelcomeModal` and `ServiceFirstRunModal` already include bookmark-hint copy in their callouts, so the port modal would have been duplicate noise. Constructors now eagerly set `bookmarkDismissedForPort = currentPort` — state-level enforcement of "first-run overrides port modal," not just code-path order in `index.ts`. Later port changes still re-trigger `PortChangeModal` correctly because the saved port mismatches the new one.

## [0.1.13] - 2026-04-28

### Notes

- Upgrade test — no code changes. Cut to exercise the in-app update notification flow against a v0.1.12 install.

## [0.1.12] - 2026-04-28

### Fixed

- **Shell modal "File not found:" on clean VM.** `RemoteShell.createTerminal` was passing bare `'adb.exe'` to `pty.spawn`, which falls back to system `PATH` — a clean Win11 VM has no adb on PATH, so the spawn ENOENT'd silently and the xterm went black. Same family of bug as the v0.1.4 `AdbClient` bare-`'adb'` issue and the v0.1.9 `scrcpy-server dist/assets/` issue. Now resolves via `Config.getInstance().adbPath` (`<deps>/adb/adb.exe`) per the Local Dependencies Only rule.

### Added

- **Settings → "Reset welcome prompts" button.** Clears the three v0.1.10 localStorage gates (`welcomeDismissed`, `serviceFirstRunDismissed`, `bookmarkDismissedForPort`) and reloads the page so the appropriate modals re-fire. Two-step UX with explanatory copy on confirm; only touches first-run gates, not audio prefs / theme / scan history. Uninstall does not (and cannot reliably) clear browser localStorage; this gives users a clean reset path that doesn't require clearing their entire browser cache.

## [0.1.11] - 2026-04-28

### Fixed

- **Redundant `PortChangeModal` after first-run dismiss.** v0.1.10's `WelcomeModal` and `ServiceFirstRunModal` both contain bookmark copy in their info-callouts, but dismissing them with "don't show again" only set the per-modal flag — `bookmarkDismissedForPort` was untouched, so `PortChangeModal` fired on the very next page load asking the user to bookmark a port they had just acknowledged. Both modals now also save the current port to `bookmarkDismissedForPort` when dismissed with the checkbox; later port changes still re-trigger `PortChangeModal` correctly because the saved port mismatches the new one.

## [0.1.10] - 2026-04-28

### Fixed

- **scrcpy-server missing on clean-VM installs.** v0.1.9's `checkInstalled` for scrcpy-server returned `SERVER_VERSION` unconditionally without checking the filesystem, so `autoInstallMissing` skipped both the seed-promote and the network-download paths. The seed-promote path itself was also pointed one directory too high (`<installRoot>/seed/...` vs the actual `<installRoot>/current/seed/...`). Both fixed; `dependencies/scrcpy-server/` now populates on first run.
- **node-pty unavailable on clean VM (false-positive v0.1.8 fix).** `NodePtyResolver` always fetched the prebuilt manifest from GitHub before doing anything else, so a clean VM with restrictive networking returned `available: false` even with a perfectly good `pty.node` already shipped in the installer. v0.1.10 tries the bundled `import('node-pty')` first and only falls back to the manifest+download path if that import fails (e.g., ABI mismatch after a Node auto-update).
- **First-run modal re-fired after service uninstall + reinstall.** Pre-v0.1.10 gating used server-side `firstRunComplete` / `serviceFirstRunSeen` flags, which got reset across uninstall/reinstall cycles. Modal gating now runs entirely off localStorage flags that survive mode flips and are only set when the user explicitly checks "don't show again."

### Added

- **"Don't show again" checkboxes on `WelcomeModal` and `ServiceFirstRunModal`.** Dismissal only persists when the box is checked; otherwise the modal returns on the next page load. Resets only via browser cache clear (no in-app reset by design).
- **`PortChangeModal`** — bookmark reminder shown on every page load when the saved `bookmarkDismissedForPort` ≠ current port. Same "don't show again" pattern; changing ports later auto-clears the effective dismissal because the saved port no longer matches.
- **`firstRunGate.ts`** — typed wrapper around the three new localStorage keys (`wsScrcpy.welcomeDismissed`, `wsScrcpy.serviceFirstRunDismissed`, `wsScrcpy.bookmarkDismissedForPort`) with private-mode-safe getters/setters.

## [0.1.9] - 2026-04-28

### Fixed

- **scrcpy-server architectural fix.** The runtime path for the JAR (read by `DeviceProbe.ts` and `ScrcpyConnection.ts`) used to be `<install>/current/dist/assets/scrcpy-server` — the build-bundled copy. Meanwhile `DependencyManager` registered scrcpy-server in the dep updater and downloaded user-clicked-update versions to `<deps>/scrcpy-server/scrcpy-server`. So the dep updater was *load-bearing but invisible*: the path it wrote to was never read by runtime code, and a Velopack app update would silently overwrite the bundled `dist/assets/scrcpy-server` with whatever the build pipeline shipped — possibly older than what the user's dep updater had pulled. Same family of bug as the v0.1.4 bare-`'adb'` and v0.1.6 `process.execPath` issues: runtime code resolving to the wrong location.
  - Removed `import '../../assets/scrcpy-server';` from `DeviceProbe.ts` and `ScrcpyConnection.ts` (those imports tell webpack to copy the asset into `dist/`).
  - Replaced `path.join(__dirname, 'assets', 'scrcpy-server')` with a `serverFile()` getter that returns `path.join(Config.getInstance().dependenciesPath, 'scrcpy-server', 'scrcpy-server')`. Same architectural pattern as `Config.adbPath` from v0.1.4.
  - `DependencyManager.autoInstallMissing` now seed-promotes `<install>/seed/scrcpy-server/scrcpy-server` → `<deps>/scrcpy-server/scrcpy-server` on first run (idempotent — no-op if dest exists). Offline-capable: a fresh install on a network-restricted host still has a working scrcpy-server; the dep updater overwrites the seed-promoted copy with the latest from Genymobile when run.
  - `scripts/stage-publish.mjs` stages `assets/scrcpy-server` → `publish/seed/scrcpy-server/scrcpy-server` so Velopack ships the seed alongside `seed/node/`.
- **Uninstall-handoff failure when the user-session launcher inherited Local System's environment.** v0.1.8's `user_session_spawn.rs` called `CreateProcessAsUserW(.. lpEnvironment = None)`, which means the spawned child inherits the **caller's** environment — and the caller is a Local System process, not the user. So the new launcher started up with `%APPDATA%`, `%LOCALAPPDATA%`, `%USERPROFILE%`, `%TEMP%` all pointing at `C:\Windows\system32\config\systemprofile\…`. Velopack init reads `%APPDATA%` for its update cache, various launcher startup paths break, and the spawned launcher exited before reaching its supervisor's HTTP listen — `discoverServicePort` would then time out, the handoff would return false, and the fallback direct uninstall would kill the service from session 0. Result: service uninstalled, but the user's tab said "can't reach server" and no local instance came up.
  - Fix: build the user's actual environment block via `CreateEnvironmentBlock(env_ptr, user_token, FALSE)` and pass `env_ptr` as `lpEnvironment`. Add `CREATE_UNICODE_ENVIRONMENT` to `dwCreationFlags` (mandatory when `lpEnvironment` came from `CreateEnvironmentBlock`, which always returns UTF-16). Call `DestroyEnvironmentBlock` after spawn returns. Adds `Win32_System_Environment` feature to the windows-rs crate.
- **`SettingsModal.onUninstallService` now honors `data.redirectTo`.** v0.1.8 added the redirect handling to the install path but missed the uninstall path. When the service-instance API successfully spawned a user-session local launcher and returned 200 with `redirectTo` + `resumeToken`, the frontend ignored both fields and called `refreshService()` instead. UI showed "service still running" because the local instance hadn't fired the actual uninstall yet, button reset, user thought nothing happened. Now the frontend navigates to `redirectTo` (carrying the resume token in URL params) so the local instance can pick up the work in its own UAC context.
- **WelcomeModal no longer shows on service-mode instances regardless of `firstRunComplete`.** v0.1.8 service install would auto-redirect the user to the new service instance, which then re-showed the welcome modal because its in-memory `firstRunComplete` was still false (Config was loaded before the local instance flipped the flag on disk). Gating the modal trigger on `installMode !== 'user-service' && installMode !== 'system-service'` makes the bug structurally impossible — service instances by definition don't need an install-mode prompt.

### Added

- **Auto-open browser on first run (user mode only).** When a fresh local user instance starts (`firstRunComplete === false` AND `installMode` is not service-mode), the server invokes `cmd /c start "" <url>` (Windows) / `xdg-open <url>` (Linux) / `open <url>` (macOS) so the user's default browser lands directly on the welcome modal instead of requiring them to remember the URL. Best-effort, detached + ignored stdio. New `src/server/openBrowser.ts` module.
- **Bookmark hint paragraph in WelcomeModal.** Tells the user to wait until after picking install mode before bookmarking, because picking "yes install service" shifts the server to a new port. Styled as an info callout.
- **`ServiceFirstRunModal`** (modal, not banner). Shows once when a service-mode instance loads for the first time — informational, says "the service will start at boot, this URL stays valid across reboots, bookmark it now." Single dismiss button. Persists `serviceFirstRunSeen: true` via PATCH `/api/config` so it never re-fires.
- **`serviceFirstRunSeen` flag in `AppConfig`.** Separate from `firstRunComplete` to keep the two flows independent. Validated via `validateField('serviceFirstRunSeen', ...)` and persisted to `config.json`.
- **Post-uninstall bookmark reminder.** Resume overlay text on the local instance after a service uninstall now reads "service uninstalled. ws-scrcpy-web is running in user mode now (port {LOCAL_PORT}). if you bookmarked the service-mode page, update it to this URL." Visible for 5s instead of 2s.

### Audit notes

- **node-pty path-dependency audit closed.** User confirmed in v0.1.8 testing that node-pty resolution is working correctly on both the local host and the test VM. The audit conclusion from v0.1.8 (resolver chain is local-deps-correct) holds. The earlier-reported "node-pty issue on test box" appears to have been a transient first-run download artifact, not a path-resolution bug.

## [0.1.8] - 2026-04-28

### Fixed

- **Install modal stuck on "installing…" forever after a successful service install.** v0.1.7's `elevatedRunner.ts` used PowerShell's `Start-Process -Wait -PassThru` to wait for the elevated child, but `-Wait` is unreliable for `-Verb RunAs` because the elevated process runs in a different logon session and `-Wait` cannot always track cross-session children. Service install would actually succeed (binary registered, port bound) but the Node `fetch` call never resolved, leaving the welcome modal indefinitely greyed out with the "installing…" label. v0.1.8 replaces the wait pattern with **result-file polling**: PowerShell kicks off `Start-Process -Verb RunAs` and exits immediately; Node polls `fs.existsSync(resultPath)` at 200ms intervals up to a 5-minute timeout (UAC dialog can legitimately stay up that long). Bulletproof against cross-session quirks. Frontend resolves cleanly whether the user accepts UAC, declines it, or walks away from the keyboard.
- **Port-change "restart and open new tab" actually does that now.** Settings → port change → Apply previously updated `config.json` and showed "server will restart on the new port. browser will redirect." but no restart fired and no redirect happened. v0.1.8 wires `PATCH /api/config`'s `restartRequired: true` path to (a) write `<deps>/.restart` to trigger the supervisor's restart loop, (b) `process.exit(75)` 1s after responding so the supervisor restarts Node on the new port, and (c) include `redirectTo` in the response so the frontend redirects to the new port 4s later. Settings UI status text and timing aligned with reality.

### Added

- **Install-flow auto-redirect (Windows).** When the user clicks "yes install service" on the local app, the elevated helper installs and starts the service, then the local instance polls `localhost:8000..8099/api/whoami` (new endpoint, exposes `pid`/`installMode`/`version`) for an instance that is not us. The discovered URL is returned as `redirectTo` in the install response. Frontend writes "service mode active. switching you over…" and navigates 500ms later. The local instance schedules its own `process.exit(0)` 5s after responding so the user doesn't end up with two app instances and two tray icons. Result: one click, one UAC prompt, one seamless mode switch — no port confusion, no manual cleanup.
- **Uninstall-flow Path A handoff.** When the user clicks "uninstall service" while connected to the service-instance UI, the service-Node process detects it is running as Local System (via `os.userInfo().username === 'SYSTEM'`) and routes through a new cross-session spawn helper instead of attempting to uninstall itself (which would terminate the user's own browser tab mid-request). The helper uses Windows Terminal Services APIs (`WTSGetActiveConsoleSessionId`, `WTSQueryUserToken`, `CreateProcessAsUserW` — all in a new `launcher/src/user_session_spawn.rs` module) to spawn a fresh user-session local launcher. Once the new launcher's HTTP server is reachable, the service-Node issues a single-use **resume token** and returns it with `redirectTo`. The user's browser navigates to the local instance with `?resume=uninstall-service&token=…`. The local-instance frontend reads the URL params, posts to `/api/service/uninstall` with an `X-Resume-Token` header, and the local-instance API consumes the token and runs the uninstall in its own UAC context. Result: zero manual user steps. Service uninstall feels like a single-click action even though it spans two app instances.
  - **Single-use, time-bounded, action-bound resume tokens** — 16-byte hex strings stored at `<install>/.resume-tokens/<token>.json` with a 10-minute TTL. Validated, deleted-on-success in one operation. Won't replay (single-use), won't fire on a stale URL bookmarked yesterday (expiry), won't authorize the wrong action (action binding). Defense scope: accidental replay and confused-deputy attacks; not against an attacker with filesystem read access (acceptable threat for a local tray app managing a local service).
  - **Tray helper cleanup on uninstall.** v0.1.6/0.1.7 unregistered the HKCU Run-key on uninstall but didn't kill the running tray icon, leaving it pointing at a service that no longer exists. v0.1.8's elevated uninstall handler also runs `taskkill /F /IM ws-scrcpy-web-tray.exe` so the tray icon disappears immediately.
- **Single-instance launcher mutex now allows one elevated + one non-elevated instance to coexist.** v0.1.7 already namespaced by integrity level (`-User` vs `-Admin` mutex names). v0.1.8 extends the design to handle the v0.1.8 uninstall handoff case — the service-spawned local launcher in user session and any pre-existing user-session launcher get the same `-User` mutex; the launcher exits cleanly if it's the second one, leaving the existing one to handle the resume token. (The mechanism was already in place; this is an explicit acknowledgment that the design composes correctly with the new flow.)
- **`launcher.log` timestamps + `<deps>/server.log` plumbing** were added in v0.1.7 but invaluable for v0.1.8 testing — the install-modal-hang root-cause analysis took minutes instead of hours because the launcher.log made the cross-session timing visible.
- **`/api/whoami` endpoint** exposes `{ pid, installMode, version }` for cross-instance identification during install-flow port discovery. Deliberately minimal — no privileged data.
- **`shellReason` surfaced in `/api/capabilities`** when node-pty resolution fails. Previously the shell modal was silently hidden when the resolver returned `available: false`; now the frontend can render an actionable error (which the user can paste into a bug report).

### Audit notes

- **node-pty path-dependency audit completed.** The resolver chain (`src/server/NodePtyResolver.ts`) is verified local-deps-correct: downloads from our own GitHub releases (`bilbospocketses/ws-scrcpy-web/releases/.../node-pty-prebuilds-v<version>/<key>.tar.gz`) → caches at `<deps>/node-pty/v<version>/<platform>-<arch>` → copies the prebuilt to `<install>/current/node_modules/node-pty/build/Release/`. No system PATH lookups, no env-var resolution, no ambient state assumptions. The reported test-box failure is more likely a missing-prebuilt-for-host-ABI case than a path-resolution bug; the new `shellReason` surfacing should make that diagnosable from a screenshot in future reports.

## [0.1.7] - 2026-04-27

### Fixed

- **Service install no longer requires the user to manually launch as Administrator.** v0.1.6 returned 503 with "service install requires running ws-scrcpy-web as Administrator" because Velopack installs ws-scrcpy-web per-user under `%LocalAppData%` without elevation, and Servy's CLI needs admin to register services with SCM. The v0.1.6 guard correctly identified the problem but pushed the burden onto the user (right-click → Run as administrator on every launch). v0.1.7 elevates *only when needed*: clicking "yes install service" or Uninstall now spawns the launcher binary with a new `--elevate-and-run` argv mode via PowerShell's `Start-Process -Verb RunAs`, which fires the UAC prompt for that single operation. The main app continues to run unelevated. Implementation:
  - **`launcher/src/elevated_runner.rs` (new)** — Rust handler that reads a JSON args file, runs `servy-cli` + `reg.exe` (HKCU Run-key for tray) + tray spawn directly in the elevated process, and writes a structured result JSON for the parent to read.
  - **`src/server/service/elevatedRunner.ts` (new)** — Node-side counterpart. Writes args to a temp file, spawns the launcher with `Start-Process -Verb RunAs -Wait -PassThru`, reads the result. UAC denial is detected (PowerShell exits non-zero, no result file) and surfaced as a structured `{ ok: false, errorMessage: 'user declined elevation' }` payload.
  - **`src/server/service/ServyClient.ts`** — `install()` and `uninstall()` route through `runElevated`. `status()` switches from `servy-cli status` (which would also need admin) to `sc.exe query <name>` (read-only SCM access, no admin needed) so routine status polling never prompts UAC. `start()` / `stop()` / `restart()` throw "not yet wired through elevation helper" — no current UI calls them, and adding them needs the spawn-local-and-redirect flow planned for v0.1.8.
  - **New `ServiceInstallError` class** carries the elevated helper's structured result so callers can detect UAC denial via `err.isUacDeclined()`. `ServiceApi` maps that case to **HTTP 403** so the frontend can render UAC-aware retry instead of a generic 500.
  - The v0.1.6 admin guard (`isWindowsAdmin()` + `ServiceApi` 503) is removed entirely; elevation is handled at the operation site, not at the API boundary. `src/server/isWindowsAdmin.ts` is deleted.

### Added

- **Timestamps on every `launcher.log` line.** Format: `YYYY-MM-DD HH:MM:SS.fff` UTC. The v0.1.6 service-mode debugging tonight was slower than it needed to be because adjacent log entries had no time information — multiple "supervisor: server started (pid X)" lines could have been seconds or hours apart. Implementation in `launcher/src/log.rs` is dependency-free (closed-form Unix-epoch-to-civil-date math, no chrono/time crate) so the launcher binary stays tiny.
- **Server stdout/stderr captured to `<install>/dependencies/server.log`.** Without this, a Node child crash during boot (port-bind failure, native module load error, unhandled rejection) was completely invisible — release-build launchers detach from the console, and we never redirected stdio. The v0.1.6 "service runs but app unreachable" + "no port bound, no idea why" debugging required manually running Node from PowerShell to see the actual error. Now the same information lands in `server.log` automatically.
- **Single-instance launcher guard with integrity-level namespacing.** Windows named mutex (`Local\WsScrcpyWeb-SingleInstance-User` for medium-integrity, `Local\WsScrcpyWeb-SingleInstance-Admin` for high-integrity) prevents accidental duplicate launches while *intentionally* allowing one non-elevated and one elevated instance to coexist. The legitimate use case: a user has the normal app running in their tray, then needs to do a service install/uninstall — they can right-click → Run as administrator to get a parallel admin instance, do the operation, and exit it. Same-integrity duplicates (two non-elevated, two elevated) are still blocked. Implementation in `launcher/src/single_instance.rs`. Velopack hooks and elevate-and-run helpers skip the guard because they legitimately race with a running instance.

### Known issues queued for v0.1.8

- **Port-change "restart and open new tab" does nothing.** Settings → port change → Apply: server doesn't restart, no new tab opens, page stays as-is. Needs a repro pass on the client/server contract.
- **Uninstalling from a service-running session kills the user's browser tab.** When the user is interacting with the service-hosted web UI (browser pointed at the service's port) and clicks Uninstall, the elevated helper stops + deletes the service, which terminates the running web server, which kills the user's tab. v0.1.7 workaround: stop the service via `services.msc` first, OR launch a separate non-service local instance (now possible thanks to the integrity-namespaced single-instance guard) and uninstall from there. v0.1.8 will detect service-mode-self-uninstall and spawn-local-and-redirect automatically.
- **node-pty path-dependency audit.** Earlier user report: node-pty resolution may be looking for a system install rather than the local `dependencies/node-pty/`. Same family of bug as the v0.1.4 bare-`'adb'` and v0.1.6 `process.execPath` issues. Audit deferred to v0.1.8 to keep v0.1.7 shippable.

## [0.1.6] - 2026-04-27

### Fixed

- **Windows service mode now actually runs the app.** v0.1.5 fixed Servy's install flag names so the wizard stopped erroring out, but service install was still broken in three deeper ways that only surfaced once you clicked through the install:
  - **`binPath` was wrong.** `ServiceApi.ts` passed `process.execPath` — the currently-running Node binary — as the executable Servy should launch. Servy then ran `node.exe` with no script argument, Node sat idle in REPL mode, port 8000 never bound, the wrapper reported RUNNING to SCM but the app was unreachable. Same architectural failure pattern as the v0.1.4 bare-`'adb'` bug: trusting an ambient resolution (`process.execPath` resolves through PATH in dev) instead of an explicit local-deps path. v0.1.6 binds `binPath` to `<install>/ws-scrcpy-web-launcher.exe`, the packaged launcher, which already knows how to spawn Node + supervise + manage the lifecycle. Existence-check before passing to Servy so dev/from-source runs return a clear 500 rather than installing a broken service.
  - **`startupDir` was never set.** Servy logs showed `Working directory fallback applied: C:\nvm4w\nodejs` — Servy fell back to the directory of the (wrong) `binPath`, and the launcher's relative resolution of `seed/`, `dependencies/`, `dist/` silently broke. v0.1.6 adds `startupDir` to `ServiceInstallOptions` and pins it to the install root on Windows. SystemdClient on Linux now emits a `WorkingDirectory=` directive from the same field.
  - **Service didn't auto-start after install.** Servy's `install` subcommand only registers the service; it doesn't start it. With `--startupType Automatic`, Windows would have started it at next boot, but the welcome modal's "yes install service" UX leads users to expect the service to come up live. v0.1.6 calls `servy-cli start --name <name>` immediately after `install`. Wrapped in try/catch so a start failure surfaces as a warning + a "stopped" status, not a failed install.
- **Service status was always "not installed."** v0.1.5 used `servy-cli list` to derive status, but **Servy 8.2 has no `list` subcommand at all** — invoking `list` fell through to Servy's help text, which our `parseServyListStatus` parsed and never matched. UI showed "not installed" even when the service was registered and running. v0.1.6 replaces the list-parser with `parseServyStatus` that calls `servy-cli status --name <name>` and matches Servy 8.2's actual output (`Service status for '<name>': <State>`). Servy returns non-zero with a "service not found" message when the service is absent; we map that one specific case to `'not-installed'` and rethrow other errors so genuine failures (binary missing, permission denied) surface to the API layer.
- **Admin elevation was unguarded.** Servy CLI requires Administrator to register services with SCM, but Velopack installs ws-scrcpy-web per-user under `%LocalAppData%` without elevation by default. An unelevated user clicking "yes install service" would either hit a UAC prompt that hung `execFileSync` (browser sees "couldn't reach server") or get a confusing 500. v0.1.6 adds `isWindowsAdmin()` (probes via `net session`) and `ServiceApi` returns `503` with an actionable "service install requires running ws-scrcpy-web as Administrator" message before invoking Servy when the process isn't elevated.
- Added `--recoveryAction RestartProcess` to install argv. v0.1.5 omitted `--recoveryAction` and Servy logs showed `recoveryAction: None`, so a child crash had no recovery — the wrapper would just stop. RestartProcess works for every supported account (including Local Service / Network Service if we ever switch off Local System).

### Migration note for users on v0.1.4 / v0.1.5

If you installed the Windows service via the welcome modal on v0.1.4 or v0.1.5, the service is registered with a broken configuration that points at Node-with-no-script. Clean up before reinstalling:

```
servy-cli.exe stop -n WsScrcpyWeb
servy-cli.exe uninstall -n WsScrcpyWeb
```

Then run ws-scrcpy-web v0.1.6 as Administrator and re-enable service mode from Settings → Service.

## [0.1.5] - 2026-04-27

### Fixed

- **Service install wizard hard-failed with "Option 'binPath' is unknown."** The Windows ServyClient was passing `--binPath`, `--account`, `--startType`, and `--logPath` — none of which are valid Servy 8.2 CLI flags (those names look like NSSM, which Servy was originally inspired by but does not match). Servy 8.2 uses `--path`, `--startupType`, `--stdout`, `--stderr`, and `--user` (the latter omitted entirely now). The bug was hidden during v0.1.4 fresh-VM smoke because that smoke stopped at "Setup runs, app launches, page reachable" — nobody clicked "yes install service" on the welcome modal. Fixed by:
  - Rewriting the install args in `src/server/service/ServyClient.ts` to use Servy 8.2's actual flag names: `--path` (not `--binPath`), `--startupType` (not `--startType`), and `--stdout` + `--stderr` (not `--logPath`, both pointed at the same file for a unified service log).
  - Dropping `--account` entirely. The Windows service now runs as Local System (Servy's default when `--user` is omitted), which side-steps password capture in the welcome modal and is the standard for tray-app service installs.
  - Removing the `account: ServiceAccount` field from the cross-platform `ServiceInstallOptions` interface, dropping the `ServiceAccount` type from `src/server/service/ServiceClient.ts`, and stripping the corresponding plumbing from `src/server/api/ServiceApi.ts`. SystemdClient on Linux had never actually consumed `account` (it derives behavior from `scope`), so the field was dead weight there too.
  - Updating `src/server/__tests__/ServyClient.test.ts` to assert the correct Servy 8.2 argv shape *and* explicitly assert that the v0.1.4-broken flag names (`--binPath`, `--account`, `--startType`, `--logPath`, `--user`) are NOT present in argv — regression guard against a future revert.

## [0.1.4] - 2026-04-27

**v0.1.0, v0.1.1, v0.1.2, AND v0.1.3 all shipped broken and have been withdrawn.** That's four broken releases in a row. If you installed any of them: apologies for the wasted time. v0.1.4 is the FIFTH attempt and the first one where every previously-deferred packaging-path bug has been closed instead of "noted for later."

The honest accounting of how we got here:

- **v0.1.0** — Setup.exe crashed on a clean Win11 install with `VCRUNTIME140.dll was not found`. The Rust launcher and tray binaries were dynamically linked against the Visual C++ Redistributable, which a clean Win11 doesn't ship. Fixed in v0.1.1 by statically linking the MSVC C runtime.
- **v0.1.1** — Setup.exe completed, but the launcher silent-failed at first run because no Node binary could be found at `<install>/current/seed/node/`. The SP3 spec called for shipping a bootstrap Node binary at that path, but the script that populates `seed/` was deferred during P6 packaging and never landed. Fixed in v0.1.2 with a `scripts/fetch-node.mjs` that downloads + SHA256-verifies Node v24.15.0 LTS during CI.
- **v0.1.2** — `seed/node/node.exe` shipped correctly, but the launcher STILL silent-failed because the supervisor was unconditionally setting `DEPS_PATH` on its own process env before calling `resolve_node`, making `resolve_node` enforce strict mode and refuse the seed fallback. Fixed in v0.1.3 by passing `DEPS_PATH` to the Node child env directly instead of the launcher's own env.
- **v0.1.3** — Setup.exe finally installed and the app launched, but the network scan (full + quick) and device discovery hung indefinitely on every click — chip never moved, cancel did nothing, only a page refresh reset the UI. Root cause: the server invoked bare `'adb'` (PATH lookup), and on a clean machine that hit ENOENT, while on a machine with a system adb already installed it triggered a version-mismatch hang. The chip-freeze symptom was made worse by `NetworkScanner.start()` having no `catch` block — any exception got silently swallowed by `ScanMw`'s `.catch(() => {})` and the WebSocket waited forever for a message that never came. **This bug was foreseeable.** A 2026-04-15 cross-platform audit had explicitly noticed that all `new AdbClient()` calls used the default `'adb'` PATH lookup AND that `Config.adbPath` itself didn't auto-resolve to the bundled binary — and filed both as "low priority — works when ADB is in the dependencies folder or on PATH." That self-granted deferral, made by the AI assistant doing the audit, was the actual cause of v0.1.3 shipping broken; the deferred items were the bug. v0.1.4 is the fix, plus a new architectural rule (in CLAUDE.md) that bans this category of deferral on installer-shipping projects.

### Fixed (v0.1.4)

- **Network scan + device discovery work again.** `Config.adbPath` now resolves *exclusively* to the local `<install>/dependencies/adb/adb[.exe]` path (or to a user-explicit `config.json` `adbPath` override). There is no system-PATH fallback. There is no `ADB_PATH` env-var resolution. If the bundled binary isn't there yet on first run, `DependencyManager.autoInstallMissing` fetches it; until it's present, adb-dependent operations throw `AdbExecError('spawn', ...)` and surface as a `scan.error` message in the UI rather than freezing the chip.
- **`AdbClient` constructor now requires an explicit `adbPath` argument** (compile-time guardrail). The previous `'adb'` default had silently masked the bug. All 6 production call sites (`DeviceProbe`, `AdbUtils`, `Device`, `FilePushReader`, `ControlCenter`, `ScrcpyConnection`) updated to pass `Config.getInstance().adbPath`.
- **Hard timeouts on adb control-plane calls.** `AdbClient.exec` now sets `timeout` + `killSignal: 'SIGKILL'` on `devices` (5s), `mdns services` (8s), `connect` (8s), `disconnect`/forward ops (5s). Long-running commands (`shell`, `push`, `pull`) remain unbounded by design.
- **Typed `AdbExecError`** carries `kind` (`timeout` | `spawn` | `exit` | `unknown`), the resolved `adbPath`, and the `args` so the failure message is debuggable from logs alone.
- **`NetworkScanner.start()` has a `catch` block** that emits `scan.error` with the exception message before `finally` resets state. Any future scanner-side failure surfaces visibly instead of hanging the UI.
- **`AdbClient.mdnsServices` no longer swallows errors** and returns `[]` — that behavior was the original sin masking the v0.1.3 hang. It now throws and lets the caller decide on degradation.

### Installation

- **Windows installer (`Setup.exe`)** — installs per-user under `%LocalAppData%`, no admin required. Best for most users. Velopack-managed auto-updates from the in-app **Settings** panel or the header **Update Available** button.
- **Linux AppImage** — single executable; `chmod +x` and run, on any glibc 2.31+ or musl-libc distro. Velopack-managed auto-updates.
- **Windows portable ZIP** — unzip and run; no install required, no auto-updates. Air-gapped friendly.
- Stable and beta release channels, switchable in Settings without reinstall.
- Manual install path still works: clone the repo, `npm install`, `npm start`.

### Service mode

- Optional Windows service (managed by [Servy](https://github.com/aelassas/servy)) so `ws-scrcpy-web` runs at login or boot. Pick from the first-run welcome modal or Settings → Service.
- Optional Linux systemd unit. User scope (no sudo) writes to `~/.config/systemd/user/`; system scope (requires sudo) writes to `/etc/systemd/system/`. Welcome modal asks per-platform; `loginctl enable-linger` keeps user-scope services alive after logout.
- A small system-tray icon on Windows shows a single confirm-and-exit dialog. (Linux skips the tray entirely; use the web UI Stop Server button.)

### Streaming features

- **Multi-codec video** (H.264, H.265, AV1) and **multi-codec audio** (Opus, AAC, FLAC, raw PCM), all decoded via WebCodecs in the browser. No WASM fallbacks.
- **Audio capture** is SDK-aware with three sources (output / playback / mic), per-device persisted preferences, and graceful gating for older Android. Playback mode keeps device audio audible during capture (Android 13+).
- **D-pad / Touch input modes** with a toolbar toggle for leanback TV apps. UHID keyboard and mouse with hardware-level input via USB HID. Scroll wheel and Shift+scroll forwarding tuned for high-latency streams.
- **Programmatic stream API**: load `ws-scrcpy.umd.js` or `ws-scrcpy.esm.js` and call `WsScrcpy.startStream(container, deviceId, options)` to embed a stream into any DOM element. Bundled TypeScript types. Thin `embed.html?device=<udid>` shim for iframe consumers.

### Device discovery

- **Network scan** combining mDNS (modern devices) with a TCP-port-5555 sweep (older devices that do not advertise). Auto-detects gateway subnet; accepts additional subnets as CIDR, bare IP, or IP range. mDNS and TCP hits dedupe automatically.
- **Quick Scan** button on the home page for fast mDNS-only discovery.
- **Device labels** persist across sessions, keyed by both serial and MAC, so devices keep their names whether they show up via mDNS or TCP.
- **Sleep / wake toggle** on each device card with server-polled state, kept in sync over WebSocket so buttons stay accurate when the device sleeps via timer or remote.

### UI

- **First-run welcome modal** that shows the chosen port (with auto-shift if 8000 is busy) and the service-install prompt.
- **Settings panel** (gear icon, top-right) for web port, auto-update preferences, channel selection, GitHub owner override, and service install/uninstall. Dev-mode banner when running from source.
- **Dark / light theme toggle** persisted in localStorage.
- File browser with breadcrumbs, sortable columns, drag-and-drop upload, download with progress, bulk delete.
- Remote ADB shell terminal with xterm.js.
- Browser tab title is now static ("Android Power Tools") on every page.

### Self-contained dependencies

- Bundled Node.js 24.15.0 LTS (ships in the installer payload, no first-run download needed). ADB platform-tools and `scrcpy-server` v3.3.4 download on first run with SHA256 verification.
- Native `node-pty` prebuilds for Windows (x64, arm64) and Linux glibc (x64, arm64), built weekly via GitHub Actions matrix. Falls back to source-compile on unsupported targets.
- **In-app dependency updater** in the Settings panel: check and update Node.js, ADB, and `scrcpy-server` from the home page with one click.

### Linux portability

- Launcher built for `x86_64-unknown-linux-musl` — zero glibc dependency on the launcher itself. The bundled Node 24 binary still requires glibc 2.31+, which is the actual minimum-glibc for the full app.
- AppImage runtime stub swapped post-`vpk pack` with the upstream static-fuse runtime from [AppImage/type2-runtime](https://github.com/AppImage/type2-runtime). The .AppImage no longer needs `libfuse2` or `libfuse3` installed on the host.

### Privacy and code signing

- `PRIVACY.md` documents outbound traffic (update checks, optional dep installs from `nodejs.org`, `dl.google.com`, `github.com`). No telemetry. No analytics. No project-operated server.
- Code signing via [SignPath Foundation](https://signpath.org)'s free OSS program — application is in review. Once approved, the next release will be the first signed release. Until then, integrity is verifiable via the `SHA256SUMS` file shipped with each release.

## [0.1.3] - 2026-04-27 [YANKED]

**Withdrawn.** Setup.exe installed and the app launched, but the network scan (full + quick) and device discovery hung on every click — chip frozen at 0/N, cancel button non-functional, only a page refresh reset the UI. Root cause was bare `'adb'` PATH lookup combined with a missing `catch` block in the scanner's main try. See [0.1.4] above for the full root-cause writeup and fix. The GitHub Release page was deleted. Tag retained for archaeology.

## [0.1.2] - 2026-04-27 [YANKED]

**First actually-installable release.** v0.1.0 (initial tag) and v0.1.1 (VCRUNTIME fix + branded icons) both shipped with broken installers — v0.1.0 crashed on a clean Win11 install with `VCRUNTIME140.dll was not found`, and v0.1.1 fixed that crash but exposed a separate gap where the post-install app launch silent-failed because the bundled Node bootstrap binary was missing from the installer payload. Both have been withdrawn from the Releases page; this is the first version that actually installs and runs end-to-end on a clean machine. See § Install-blocker fixes below for the full chain.

### Install-blocker fixes (the v0.1.0 → v0.1.2 journey)

- **v0.1.1 fix → still in v0.1.2:** the Rust launcher and tray binaries now statically link the MSVC C runtime (`-C target-feature=+crt-static`), so they have no runtime DLL dependency on the Visual C++ Redistributable. v0.1.0 crashed with `VCRUNTIME140.dll was not found` on any Windows install missing VCRedist (true of fresh Win11). Verified with `dumpbin /dependents`: only Windows-native DLLs remain.
- **v0.1.2 fix:** `Setup.exe` now actually launches the installed app. v0.1.1 fixed the VCRUNTIME crash but the launcher then silent-failed at first run because no Node binary could be found at `<install>/current/seed/node/`. Process lifetime was under 200 ms — invisible in Task Manager. The SP3 spec called for shipping a bootstrap Node binary at that path, but the script that populates `seed/` was deferred during P6 packaging and never landed. New `scripts/fetch-node.mjs` downloads + SHA256-verifies Node v24.15.0 LTS from `nodejs.org/dist/`, stages the binary into `seed/node/`, and is invoked from `release.yml` before `stage-publish.mjs` on both Windows and Linux jobs.
- **v0.1.1 fix → still in v0.1.2:** branded app icon now appears in Explorer, taskbar, Start Menu, Add/Remove Programs, and the Setup.exe installer itself. Setup.exe gets it via `vpk pack --icon`; launcher and tray binaries embed it via `winresource`-driven `build.rs` files.
- **v0.1.1 change → still in v0.1.2:** the broken Velopack `--msiDeploymentTool` MSI artifact was withdrawn from the release pipeline. It was an SCCM/Intune deployment-tool harness, not a user-clickable installer. Setup.exe (per-user, wizardful) and Portable.zip remain the supported Windows install paths. A real user-facing WiX MSI is logged as a future enhancement.
- **v0.1.2 change:** Linux AppImage is now truly portable — `chmod +x` and run on any Linux from the last 18 years. Two changes land together: (i) the Rust launcher is built for `x86_64-unknown-linux-musl`, so the binary itself has zero glibc dependency (`ldd` on the shipped ELF reports `not a dynamic executable`); (ii) the AppImage runtime stub is swapped post-`vpk pack` with the upstream static-fuse runtime from [AppImage/type2-runtime](https://github.com/AppImage/type2-runtime), so the .AppImage no longer needs `libfuse2` (or `libfuse3`) installed on the host. Net minimum-glibc is still 2.31+ (set by the bundled Node 24), but the launcher itself runs on anything including musl-libc distros like Alpine.

### Installation

- **Windows installer (`Setup.exe`)** — installs per-user under `%LocalAppData%`, no admin required. Best for most users. Velopack-managed auto-updates from the in-app **Settings** panel or the header **Update Available** button.
- **Linux AppImage** — single executable; `chmod +x` and run, on any glibc 2.31+ or musl-libc distro. Velopack-managed auto-updates.
- **Windows portable ZIP** — unzip and run; no install required, no auto-updates. Air-gapped friendly.
- Stable and beta release channels, switchable in Settings without reinstall.
- Manual install path still works: clone the repo, `npm install`, `npm start`.

### Service mode

- Optional Windows service (managed by [Servy](https://github.com/aelassas/servy)) so `ws-scrcpy-web` runs at login or boot. Pick from the first-run welcome modal or Settings → Service.
- Optional Linux systemd unit. User scope (no sudo) writes to `~/.config/systemd/user/`; system scope (requires sudo) writes to `/etc/systemd/system/`. Welcome modal asks per-platform; `loginctl enable-linger` keeps user-scope services alive after logout.
- A small system-tray icon on Windows shows a single confirm-and-exit dialog. (Linux skips the tray entirely; use the web UI Stop Server button.)

### Streaming features

- **Multi-codec video** (H.264, H.265, AV1) and **multi-codec audio** (Opus, AAC, FLAC, raw PCM), all decoded via WebCodecs in the browser. No WASM fallbacks.
- **Audio capture** is SDK-aware with three sources (output / playback / mic), per-device persisted preferences, and graceful gating for older Android. Playback mode keeps device audio audible during capture (Android 13+).
- **D-pad / Touch input modes** with a toolbar toggle for leanback TV apps. UHID keyboard and mouse with hardware-level input via USB HID. Scroll wheel and Shift+scroll forwarding tuned for high-latency streams.
- **Programmatic stream API**: load `ws-scrcpy.umd.js` or `ws-scrcpy.esm.js` and call `WsScrcpy.startStream(container, deviceId, options)` to embed a stream into any DOM element. Bundled TypeScript types. Thin `embed.html?device=<udid>` shim for iframe consumers.

### Device discovery

- **Network scan** combining mDNS (modern devices) with a TCP-port-5555 sweep (older devices that do not advertise). Auto-detects gateway subnet; accepts additional subnets as CIDR, bare IP, or IP range. mDNS and TCP hits dedupe automatically.
- **Quick Scan** button on the home page for fast mDNS-only discovery.
- **Device labels** persist across sessions, keyed by both serial and MAC, so devices keep their names whether they show up via mDNS or TCP.
- **Sleep / wake toggle** on each device card with server-polled state, kept in sync over WebSocket so buttons stay accurate when the device sleeps via timer or remote.

### UI

- **First-run welcome modal** that shows the chosen port (with auto-shift if 8000 is busy) and the service-install prompt.
- **Settings panel** (gear icon, top-right) for web port, auto-update preferences, channel selection, GitHub owner override, and service install/uninstall. Dev-mode banner when running from source.
- **Dark / light theme toggle** persisted in localStorage.
- File browser with breadcrumbs, sortable columns, drag-and-drop upload, download with progress, bulk delete.
- Remote ADB shell terminal with xterm.js.
- Browser tab title is now static ("Android Power Tools") on every page.

### Self-contained dependencies

- Bundled Node.js 24.15.0 LTS, ADB platform-tools, and `scrcpy-server` v3.3.4. The app downloads ADB and `scrcpy-server` on first run if missing, with SHA256 verification. Node ships in the installer payload itself (the v0.1.2 fix above) so first-run works offline.
- Native `node-pty` prebuilds for Windows (x64, arm64) and Linux glibc (x64, arm64), built weekly via GitHub Actions matrix. Falls back to source-compile on unsupported targets.
- **In-app dependency updater** in the Settings panel: check and update Node.js, ADB, and `scrcpy-server` from the home page with one click.

### Privacy and code signing

- `PRIVACY.md` documents outbound traffic (update checks, optional dep installs from `nodejs.org`, `dl.google.com`, `github.com`). No telemetry. No analytics. No project-operated server.
- Code signing via [SignPath Foundation](https://signpath.org)'s free OSS program — application is in review. Once approved, the next release will be the first signed release. Until then, integrity is verifiable via the `SHA256SUMS` file shipped with each release.

## [0.1.1] - 2026-04-27 [YANKED]

### Fixed

- **Setup.exe now installs successfully on clean Windows boxes.** v0.1.0 failed with `VCRUNTIME140.dll was not found` → `application install hook failed` on any machine missing the Visual C++ Redistributable (true of a fresh Win11 install). The Rust launcher and tray binaries now statically link the MSVC C runtime (`-C target-feature=+crt-static`), so they have no runtime DLL dependency on VCRedist. Verified with `dumpbin /dependents`: only Windows-native DLLs remain. *(Setup.exe install completes; app launch is still broken in v0.1.1 — see v0.1.2.)*
- Internal: `libcDetect.test.ts` mock typing widened from `string` to `fs.PathLike`, and `detectInstallScope` now uses `path.win32.dirname` for execPath splitting on POSIX CI hosts. CI-only fixes; no runtime behavior change.

### Changed

- **Branded app icon** now appears in Explorer, taskbar, Start Menu, Add/Remove Programs, and the Setup.exe installer itself. Previously all three displayed the default Rust toolchain / Velopack generic icon. Setup.exe gets it via `vpk pack --icon`; the launcher and tray binaries embed it via new `build.rs` files using the `winresource` crate.

### Removed

- **Windows MSI artifact withdrawn.** The MSI we shipped in v0.1.0 was Velopack's `--msiDeploymentTool` output — designed for SCCM / Intune mass deployment, not user-clickable (it silently registered as a "Deployment Tool" in Add/Remove Programs without installing the actual app). Setup.exe (per-user, wizardful) and Portable.zip remain the supported Windows install paths. A real user-facing WiX MSI is logged as a future enhancement.

## [0.1.0] - 2026-04-27 [YANKED]

First public release.

### Installation

- **Windows installer (`Setup.exe`)** — installs per-user under `%LocalAppData%`, no admin required. Best for most users. Velopack-managed auto-updates from the in-app **Settings** panel or the header **Update Available** button.
- **Windows MSI** — installs system-wide under `Program Files` (requires admin). For corporate / SCCM / Group Policy deployment scenarios. Same auto-update behavior as Setup.exe.
- **Linux AppImage** — single executable; `chmod +x` and run. Velopack-managed auto-updates.
- **Windows portable ZIP** — unzip and run; no install required, no auto-updates. Air-gapped friendly.
- Stable and beta release channels, switchable in Settings without reinstall.
- Manual install path still works: clone the repo, `npm install`, `npm start`.

### Service mode

- Optional Windows service (managed by [Servy](https://github.com/aelassas/servy)) so `ws-scrcpy-web` runs at login or boot. Pick from the first-run welcome modal or Settings → Service.
- Optional Linux systemd unit. User scope (no sudo) writes to `~/.config/systemd/user/`; system scope (requires sudo) writes to `/etc/systemd/system/`. Welcome modal asks per-platform; `loginctl enable-linger` keeps user-scope services alive after logout.
- A small system-tray icon on Windows shows a single confirm-and-exit dialog. (Linux skips the tray entirely; use the web UI Stop Server button.)

### Streaming features

- **Multi-codec video** (H.264, H.265, AV1) and **multi-codec audio** (Opus, AAC, FLAC, raw PCM), all decoded via WebCodecs in the browser. No WASM fallbacks.
- **Audio capture** is SDK-aware with three sources (output / playback / mic), per-device persisted preferences, and graceful gating for older Android. Playback mode keeps device audio audible during capture (Android 13+).
- **D-pad / Touch input modes** with a toolbar toggle for leanback TV apps. UHID keyboard and mouse with hardware-level input via USB HID. Scroll wheel and Shift+scroll forwarding tuned for high-latency streams.
- **Programmatic stream API**: load `ws-scrcpy.umd.js` or `ws-scrcpy.esm.js` and call `WsScrcpy.startStream(container, deviceId, options)` to embed a stream into any DOM element. Bundled TypeScript types. Thin `embed.html?device=<udid>` shim for iframe consumers.

### Device discovery

- **Network scan** combining mDNS (modern devices) with a TCP-port-5555 sweep (older devices that do not advertise). Auto-detects gateway subnet; accepts additional subnets as CIDR, bare IP, or IP range. mDNS and TCP hits dedupe automatically.
- **Quick Scan** button on the home page for fast mDNS-only discovery.
- **Device labels** persist across sessions, keyed by both serial and MAC, so devices keep their names whether they show up via mDNS or TCP.
- **Sleep / wake toggle** on each device card with server-polled state, kept in sync over WebSocket so buttons stay accurate when the device sleeps via timer or remote.

### UI

- New **first-run welcome modal** that shows the chosen port (with auto-shift if 8000 is busy) and the service-install prompt.
- **Settings panel** (gear icon, top-right) for web port, auto-update preferences, channel selection, GitHub owner override, and service install/uninstall. Dev-mode banner when running from source.
- **Dark / light theme toggle** persisted in localStorage.
- File browser with breadcrumbs, sortable columns, drag-and-drop upload, download with progress, bulk delete.
- Remote ADB shell terminal with xterm.js.
- Browser tab title is now static ("Android Power Tools") on every page.

### Self-contained dependencies

- Bundled Node.js, ADB platform-tools, and `scrcpy-server` v3.3.4. The app downloads these on first run if missing, with SHA256 verification.
- Native `node-pty` prebuilds for Windows (x64, arm64) and Linux glibc (x64, arm64), built weekly via GitHub Actions matrix. Falls back to source-compile on unsupported targets.
- **In-app dependency updater** in the Settings panel: check and update Node.js, ADB, and `scrcpy-server` from the home page with one click.

### Privacy and code signing

- New `PRIVACY.md` documenting outbound traffic (update checks, optional dep installs from nodejs.org / dl.google.com / github.com). No telemetry. No analytics. No project-operated server.
- Code signing via [SignPath Foundation](https://signpath.org)'s free OSS program — application is in review at v0.1.0 release. Once approved, **v0.1.1** will be the first signed release. Until then, integrity is verifiable via the `SHA256SUMS` file shipped with the release.

### Notes

- See `docs/RELEASING.md` for the release runbook.
- `docs/TECHNICAL_GUIDE.md` covers architecture and module-level details.

## [1.0.0] - 2026-04-17

First public release. Browser-based Android screen mirroring rebuilt from the ground up on vanilla scrcpy v3.x with a modernized Node.js + TypeScript stack.

### Added

**Stream API + embed mode** (this release's headline)
- Public `WsScrcpy.startStream(container, deviceId, options)` library shipped as UMD (`ws-scrcpy.umd.js`) and ES module (`ws-scrcpy.esm.js`) with bundled TypeScript types (`ws-scrcpy.d.ts`)
- `/embed.html?device=<udid>` thin wrapper for iframe consumers; transparent background, auto-connect, full toolbar
- `StreamHandle` with idempotent `stop()`, `isConnected`, `deviceId`
- `onConnect` / `onDisconnect` / `onError` lifecycle callbacks with typed payloads
- Full URL parameter surface (`host`, `port`, `secure`, `pathname`, `codec`, `encoder`, `bitrate`, `maxFps`, `maxSize`, `audio`, `keyboard`)

**Modal system**
- Native HTML `<dialog>` base class (`Modal`) with glassmorphism styling, `@starting-style` transitions, and `addHeaderButton()` helper
- `ConfigureScrcpy`, `ShellModal`, `ConnectModal`, `ListFilesModal` all extend the base class
- Device labels displayed in modal headers

**File browser** (`ListFilesModal`)
- Sticky header, reserved actions column, SVG hover icons that scale with size picker, sortable columns, breadcrumb navigation, bulk selection, drag-and-drop upload, download with progress, client-side filter

**Input**
- UHID keyboard + mouse via USB HID report descriptors (pointer lock)
- D-pad / Touch input mode toggle (D-pad default for TV apps, fire-then-debounce for scroll wheel)
- Scroll wheel with i16fp encoding (`sc_float_to_i16fp`) and latent-stream-tuned normalization
- Clipboard toolbar buttons (GET device→host, SET host→device) — modernized from legacy MoreBox textarea flow

**Codecs**
- Multi-codec video: H.264, H.265 (HEVC), AV1 with smart auto-selection (H.265 preferred, falls back to H.264 for Firefox)
- Multi-codec audio: Opus, AAC, FLAC, raw PCM via WebCodecs `AudioDecoder` + `AudioWorklet`
- HEVC SPS parser with RBSP stripping, AV1 config record parser
- Edge H.265 rendering fix: 8-arg `drawImage` using full coded rect as source (Edge reports display dims ≠ coded dims)

**Device management**
- Connected-devices card grid with live WebSocket updates
- Network scan via `adb mdns services` with one-click connect
- Device labels persisted to `device-labels.json`, keyed by `ro.serialno`
- Per-card sleep/wake toggle with server-side polling (`dumpsys power`, 5s loop, `Promise.all` concurrency)
- Disconnect button for network-connected devices

**Deployment**
- Self-contained folder layout: `dependencies/node/`, `dependencies/adb/`, `start.cmd` / `start.sh` launcher scripts
- In-app updater for Node.js + node-pty (paired), ADB platform-tools, scrcpy-server
- Windows file-locking workaround: rename running `node.exe`, write `.restart` marker, launcher relaunches
- Dark/light theme toggle with localStorage persistence

**Server**
- Tagged logger (`Logger.for('Tag')`) replaces all raw `console.log`; tees to `ws-scrcpy-web.log` with ISO timestamps, 5MB rotation
- `uncaughtException` + `unhandledRejection` handlers log to file before exit
- Crash-safe WebSocket close (readyState guard, 123-byte reason truncation)
- Vanilla scrcpy-server v3.3.4 binary; no Java patching

**API endpoints**
- `GET /api/dependencies/*` — updater status and operations
- `GET /api/devices/labels` / `PUT /api/devices/labels`
- `POST /api/devices/scan` — mDNS discovery
- `POST /api/devices/connect` / `POST /api/devices/disconnect`
- `POST /api/devices/files/*` — file browser operations including delete

**Quality stats overlay**
- Top-left HUD shows resolution, video codec, encoder name, bitrate, FPS counters; font scales with canvas resolution
- Toolbar bar-chart button toggles stats visibility
- Server echoes encoder in session metadata

**Tests**
- Vitest suite for control messages, binary readers/writers, multiplexer, codec configs, device labels
- 87 tests passing across the final release

### Changed

- Dependencies overhaul: Node 24 LTS, TypeScript 6, Biome 2, webpack 5, node-pty 1.1.0, xterm 6.x
- Runtime dependencies reduced to 2 total: `ws`, `node-pty`
- Control message protocol: `ScrollControlMessage` now 20-byte int16 (not 25-byte int32); `TouchControlMessage` payload corrected to 31 bytes
- Default keyboard: ON at stream start
- Default FPS: 15 (tuned for latent network streams)
- Default encoder: auto-selects hardware HEVC (`c2.mtk.hevc.encoder`, Qualcomm or Exynos equivalents)
- Home page centered at max-width 1800px (5 cards on 4K)
- Toolbar icons centered via SVG sizing; vertical spacing increased

### Removed

- iOS support, Chrome DevTools proxy, WASM decoder fallbacks, vendor decoder shims (~6,500 lines deleted)
- `adbkit`, Express, YAML, ESLint, path-browserify (replaced by own implementations)
- `GoogMoreBox` (383 lines) — clipboard flow replaced by toolbar buttons
- `#!action=stream` URL hash routing
- `?embed=true` URL parameter and all `body.embed` CSS rules
- Patched `scrcpy-server.jar` — project now uses unmodified Genymobile binaries

### Fixed

- Edge WebCodecs H.265 displayWidth/codedWidth mismatch causing blurry or clipped frames
- Firefox `VideoDecoder.isConfigSupported` falsely rejecting `avc1.42E01E` — H.264 now skips the check
- Mouse click freeze after stream-quality refresh (race: old demuxer's async `onclose` fired after `isRefreshing` reset)
- Stale device cards persisting across disconnects (ControlCenter + client-side `updateDescriptor` both now remove disconnected devices)
- Scan Network missed plain `_adb._tcp` services (filter was restricted to `_adb-tls-connect`)
- `RemoteShell` crash from `ws.send()` on closed socket (readyState guard)
- `AdbUtils.ts` and `RemoteShell.ts` cross-platform fixes (hardcoded `'adb'` → `Config.adbPath`, `env.PWD` → `process.cwd()`)

### Security

- WebSocket close reason truncated to 123-byte spec limit with try/catch — offline devices no longer crash the Node process
