# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> **A note on release history.** Every version below `0.1.30` was a development
> milestone published during bring-up, while the app was not yet a working
> cross-platform application. To avoid implying those builds were finished
> releases, their GitHub Releases have been removed — but every git tag is
> retained, so the full history stays browsable and the per-version entries
> below are unchanged. **`0.1.30` is the project's first true release** — the
> first build that is functional on both Windows and Linux — published once
> Linux is fully verified. The **next full release** will ship alongside the
> Docker image.

## [Unreleased]

### Fixed

- **Installing the Linux *system-wide* service now serves the app instead of timing out.** The install started the service with `systemctl enable --now` while the app you triggered it from was still holding the web port — so the freshly-started service saw the port already in use, assumed another instance owned it, opened that URL, and exited immediately. Nothing ended up serving, and the settings screen reported *"service is running but port discovery timed out."* The system-service install now works the same way the per-user service already did: it registers the service without starting it, hands off to a privileged helper that waits for the original app to exit and free the port, then starts and verifies the service. As a safety net, the launcher also no longer mistakes itself for an already-running service to defer to — and if the service still can't start, the app you launched it from is brought back, so a failed install never leaves you with nothing running.
- **The Settings panel no longer shows a scrollbar for long messages.** It's a bit wider now, so lengthy status and error text has room to wrap instead of overflowing the panel's height.

### Changed

- Quieter Linux logs: the file-listing handler no longer logs unrelated channel negotiations on every page load, and the Windows-only "stray adb (taskkill)" shutdown line is no longer printed on Linux/macOS, where it does nothing.

## [0.1.30-beta.56] - 2026-06-09

### Added

- **The browser tab now shows the app's favicon** (derived from the app icon). The page had no favicon before, so the tab showed a generic/blank icon.

### Fixed

- **The Linux app-menu icon now appears immediately after a machine-wide install on KDE.** beta.55 installed the icon correctly, but KDE's launcher keeps a per-user icon cache that doesn't refresh on its own — so the install now rebuilds it (`kbuildsycoca` + clears the stale per-user icon cache) as your user, with no manual cache-clear or re-login needed. (No-op on GNOME/others, where the system icon-cache refresh already covers it.)

## [0.1.30-beta.55] - 2026-06-09

### Fixed

- **The Linux app-menu icon now actually renders** (completing the beta.54 fix). beta.54 bundled the icon correctly, but the machine-wide install runs as root (`pkexec`) and can't read it from the *per-user FUSE-mounted* AppImage — the privileged `cp` failed silently and the menu entry stayed blank. The icon is now staged to a root-readable temp (`os.tmpdir()`) before the install copies it into the hicolor theme.

## [0.1.30-beta.54] - 2026-06-09

### Fixed

- **The Linux app-menu shortcut now shows the app icon** instead of a blank placeholder. The machine-wide install resolved the menu icon from a `$APPDIR/.DirIcon` path that vpk's AppImage doesn't actually provide, so it never installed; the icon now ships bundled (`tray-icon.png`, resolved next to `package.json` like the version file) and installs reliably into the hicolor theme.
- **Clicking the Linux app-menu shortcut while the app is already running now reopens it** — it opens the running instance's URL in the browser instead of doing nothing. Previously only an active *system* service reopened; a user-scope service or a running local instance silently no-op'd.

## [0.1.30-beta.53] - 2026-06-09

### Fixed

- **System-service install no longer fails when the app is already installed for all users.** A system-service install requires a prior install-for-all-users, so the running binary *is* the `/opt` copy — but the install script then copied that binary onto itself (`cp` rejects identical source and destination), aborting every system-service install. It no longer re-stages the binary; the service unit runs the existing `/opt` copy directly.
- **Long error messages on the Settings screen now span the full width** instead of cramping into the narrow label column — matching how status messages already wrapped.
- A benign `reset-failed` step during a Linux service uninstall no longer logs as an `ERROR` (it returns non-zero when the unit isn't in a failed state — the normal case after a clean stop).

### Changed

- **Settings notes and status/error text are now indented and bold-italic** so they read as sub-text of the setting they annotate — white for status, red for errors. The uninstall confirmation dialog's buttons are styled to match the rest of the app (white-outline cancel, red-outline uninstall).
- Internal: the uninstall launcher's best-effort command runner and argument parsing were deduplicated (no behavior change).

## [0.1.30-beta.52] - 2026-06-09

### Fixed

- **The Windows in-app uninstall now fully removes the data root.** When you unchecked "keep my settings & logs", the uninstall could leave `%ProgramData%\WsScrcpyWeb` behind. The helper that does the cleanup ran from *inside* that folder (`…\control\operation-server\`), and Windows can't delete a running program — and even after a successful delete, the helper's own logging immediately recreated the `logs` folder. The helper now copies itself to the system temp folder and that copy — with logging turned off, and after waiting for the original to exit — runs the uninstaller and deletes the data root, so nothing is left behind. Keeping settings still preserves `config.json` and `logs`.

## [0.1.30-beta.51] - 2026-06-08

### Added

- **Uninstall ws-scrcpy-web from inside the app on Windows.** The Settings → App **uninstall** action — previously Linux-only (on Windows you had to use Add/Remove Programs) — now works on Windows too: it runs the Velopack uninstaller (`Update.exe --uninstall`, which removes the install and stops/removes any installed service and the tray), with the same **keep my settings & logs** option (checked by default; unchecking also deletes config, logs, and dependencies).

### Changed

- **Reordered the Settings → App section and moved the uninstall confirmation to an overlay modal.** The rows are now, top to bottom: reset prompts → install for all users (Linux only) → stop server & exit → uninstall, on both Windows and Linux. The uninstall confirmation is now a top-layer modal (instead of an inline panel) with a **keep my settings & logs** checkbox that defaults to checked, a white **cancel** and a red **uninstall** button.

### Fixed

- **"Stop server & exit" now fully cleans up on Windows.** It previously left the tray (`ws-scrcpy-web-tray.exe`) resident and only ran `adb kill-server`, which can leave stray `adb.exe` processes behind. The tray-supervisor poll thread is now stopped before the tray is reaped (so it can't respawn the tray that was just killed), and the shutdown also runs `taskkill /F /IM adb.exe /T` to catch any stray adb — the same belt-and-braces the in-app update path already uses.

## [0.1.30-beta.50] - 2026-06-08

### Changed

- **Shortened the Settings → App "install for all users" button.** It now reads **install for all users** instead of "install ws-scrcpy-web for all users" — the App section already makes the app clear, so the name was redundant. (The **uninstall ws-scrcpy-web** action keeps its name.)

### Fixed

- **Linux service start no longer logs a spurious `ERROR … text file busy`.** On service start the launcher refreshes its bundled operation-server helper by copying the current binary over it — but in service mode that helper *is* the binary already running, so the copy fails with `ETXTBSY` ("text file busy"). The failure is harmless (the running copy is already the current version; the next start refreshes it while it's free), so it is now logged as a warning instead of an alarming error.

## [0.1.30-beta.49] - 2026-06-08

### Added

- **Install for all users — now available any time from Settings (Linux).** Previously a machine-wide `/opt` install could only be chosen at the first-run prompt. The App section of Settings now has an explicit **install for all users** action that relocates the app to `/opt` under a single administrator prompt; once it's installed system-wide the control greys out and shows that it's already installed for all users (`/opt`).
- **The machine-wide app now shows a proper icon in the apps menu (Linux).** Installing for all users also drops the app's icon into the system icon theme, so its launcher entry shows the ws-scrcpy-web icon instead of a generic placeholder.
- **Uninstall ws-scrcpy-web from inside the app (Linux).** The App section adds a complete **uninstall…** action that removes the app — including a machine-wide `/opt` install and any installed user- or system-scope service — in a single pass, with at most one administrator prompt. A **keep my settings & logs** option preserves your `config.json` and logs (so a later reinstall reuses your saved port) while still removing the program and its bundled dependencies.

## [0.1.30-beta.48] - 2026-06-08

### Fixed

- **Installing a service no longer shows a false "port discovery timed out" error.** After a service install handed the web port over to the service, the settings page would occasionally spin and then report that it couldn't determine the service's port — even though the service was running fine and a manual refresh loaded it. The post-install reconnect was inferring that the hand-off had finished from two unreliable signals: a `config.json` change that never happens when the service rebinds the *same* port, and briefly catching the port unbound (a race against the 2-second poll). When the service came back quickly on the same port it caught neither and ran out the clock. The service now reports its own identity, and the page waits for that positive signal before reconnecting — so the hand-off is detected reliably regardless of timing. (Intermittent by nature; most visible on Linux user-scope installs.)

## [0.1.30-beta.47] - 2026-06-08

### Fixed

- **Installing for all users no longer pops a redundant browser tab.** The post-install relaunch from `/opt` (and any in-app update relaunch) now tells the freshly-launched instance to skip opening a browser — your existing tab reconnects on its own, so you no longer end up with a second one.

## [0.1.30-beta.46] - 2026-06-07

### Fixed

- **Linux user-scope service install now starts the service cleanly.** beta.45 fixed the unit's `ExecStart`, which exposed a deeper race: the service and the still-running local app share the same per-user single-instance lock, so the service exited "already running" before it could bind the port — and the app went dark. Installing now performs a proper hand-off — the local instance steps aside so the service can take the lock and the port — and verifies the service actually *stays up and is serving* before committing (not just that systemd forked it). If it doesn't come up, the install rolls back and the local app is relaunched, so you're never left with nothing on the port.
- **Installing for all users no longer leaves the old process running from a deleted file.** After a machine-wide install relocated the binary to `/opt` and deleted the home AppImage, the already-running instance kept serving from the now-deleted file (it showed up as a stale `(deleted)` entry in the process list and still held the single-instance lock). It now relaunches from `/opt` once the install completes, so the deleted-file process is gone and the app runs from the installed location.

## [0.1.30-beta.45] - 2026-06-07

### Fixed

- **Linux user-scope service install now works.** The user-scope systemd unit pointed `ExecStart` at the AppImage's launch path (e.g. your `~/Downloads` copy) — which systemd refuses to run when the file isn't marked executable (a browser download isn't), and which vanishes if that file is later moved or deleted. The unit now targets a stable, guaranteed-executable binary instead: the shared `/opt` binary when the app is installed machine-wide, otherwise a copy staged under `~/.local/share/WsScrcpyWeb/bin/`. (Found during the 0.1.30 Linux smoke — the service failed to start with `203/EXEC` and the app went dark.)
- **A failed service install no longer leaves the app dead.** The install flow now confirms the service actually reaches the running state before it shuts down the local instance. If the service doesn't come up, the install is rolled back — the half-installed unit is removed, the previous mode is restored, and the app keeps running locally with a clear error — instead of exiting on a blind timer and stranding you with nothing on the port.
- **No more stray tray autostart entry on Linux.** Installing a user-scope service wrote `~/.config/autostart/ws-scrcpy-web-tray.desktop` pointing at a `ws-scrcpy-web-tray` command resolved from `PATH`, but Linux has no tray binary, so the entry was orphaned (and wasn't cleaned up on uninstall). The autostart file is now written only when an actual tray binary is found on disk — never as a bare `PATH` name — so Linux installs no longer leave it behind.

## [0.1.30-beta.44] - 2026-06-06

### Changed

- **Velopack upgraded 1.1.1 → 1.2.0 across all touchpoints** (the npm SDK in `package.json`, the Rust crate in `Cargo.lock`, and the `vpk` CLI pin in `release.yml` for both the Windows and Linux build legs). 1.2.0 is a maintenance release — notably a Linux locator root-path fix (velopack#921) on the AppImage update path and stricter semver validation (velopack#923) — with no API or CLI-flag changes (`--msi` / `--instLocation` unchanged), so the upgrade is drop-in.

## [0.1.30-beta.43] - 2026-06-05

### Changed

- **Installing system-wide now removes the original home AppImage.** When you choose "yes, all users", the final step of the machine-wide install deletes the AppImage you launched from (a true relocate), so you don't keep a stale home copy running alongside the `/opt` one. Re-download if you want a fresh local copy.

## [0.1.30-beta.42] - 2026-06-05

### Changed

- **The Linux "install for all users?" first-run prompt has clearer copy and now requires an explicit choice.** The body spells out both paths — clicking "yes, all users" installs the app to `/opt` with one administrator prompt; clicking "no, me only" leaves it running from wherever you launch it — and the two buttons are labelled to match. The dialog can no longer be dismissed without deciding: the close (×) button is removed and Escape / clicking outside the dialog are ignored, so it no longer silently reappears on the next launch after an accidental dismissal.

## [0.1.30-beta.41] - 2026-06-05

### Added

- **Linux machine-wide install (`/opt`) — parity with the Windows PerMachine MSI.** ws-scrcpy-web can now install system-wide for all users. On first launch the home AppImage offers to install system-wide; accepting relocates the binary to `/opt/ws-scrcpy-web/` via a single `pkexec` and drops a system-wide `/usr/share/applications` desktop entry, so every user launches it under their own login with their own per-user data. Declining runs the app in place and is remembered (no re-nag) — you re-opt-in only through an explicit "install system-wide" action. The home AppImage doubles as a bootstrapper: when a machine-wide install is present it execs the shared `/opt` binary.
- **Uninstall now relaunches in the active user's desktop session (Linux).** Mirroring the Windows active-session model, uninstalling the machine-wide app — by any administrator — relaunches it for the active graphical desktop user on the same web port, discovered via `loginctl`. When there is no active session (headless), it falls back to on-screen guidance instead of leaving an orphaned process.
- **Per-user single-instance guard and service-aware launch (Linux).** A per-user `flock` on `$XDG_RUNTIME_DIR` now blocks the same user from double-launching (whether from `/opt` or from home) — the previous Linux single-instance path was a no-op stub. A local launch while an active system service is running defers to the service (opens its URL) instead of starting a second server.

### Changed

- **Linux system-scope state moved to `/var/opt` (FHS), and the system service install is gated on a machine-wide install.** The binary and bundled dependencies live in `/opt/ws-scrcpy-web/` (SELinux `bin_t`); variable state — config, logs, and auto-updated dependencies — now lives in `/var/opt/ws-scrcpy-web/` (`var_lib_t`), replacing the former `/opt/ws-scrcpy-web/data`. The **system**-scope service radio is disabled (with an explanatory note) until the app is installed system-wide; the user-scope service stays available in both modes.
- **In-app updates and migration for machine-wide installs.** In system-service mode the root service updates `/opt` + `/var/opt` directly with no prompt (headless self-update); in machine-wide-but-no-service mode an app-binary update takes a single `pkexec` and swaps the running `/opt` binary by rename (avoiding `ETXTBSY`), relaunching after exit so the single-instance lock releases first. A newer home AppImage over an older `/opt` install is detected and offered as an update. An existing legacy system install under `/opt/ws-scrcpy-web/data` is detected and migrated to `/var/opt` on upgrade in a single `pkexec` (stop/disable the old unit, remove the old tree and its SELinux rule, set up `/var/opt`, reinstall the unit), carrying over your web port and install mode.

### Fixed

- **System-scope uninstall now removes both SELinux `fcontext` rules.** A system install registers two `semanage fcontext` rules (the `/opt` tree and the variable-state path), but uninstall removed only the tree rule, leaving a stale `var_lib_t` entry behind. Uninstall now deletes both.

### Docs

- **README:** corrected the Linux AppImage download name to the channel-suffixed `WsScrcpyWeb-linux-stable.AppImage` / `WsScrcpyWeb-linux-beta.AppImage`, and rewrote the libfuse2 section — the AppImage now bundles the static type-2 runtime, so it launches without host `libfuse2`; the libfuse2 note now scopes to the in-app updater only.
- **TECHNICAL_GUIDE:** documented Linux service mode (systemd; user/system scopes; SELinux `/opt` staging), the Linux launcher subcommands, and the Linux download-and-swap update apply (sections 19/20/22); corrected the reset-prompts field list (23.4) and the dependency version table (12).
- **THIRD-PARTY-NOTICES:** added attribution for the bundled MIT runtime dependencies (`ws`, `@xterm/*`, `node-pty`, `velopack`).
- Misc: self-contained the SignPath disclosure (RELEASING) and removed references to an internal-only file from RELEASING / PROGRAMDATA-MIGRATION; fixed the spec/plan paths in CONTRIBUTING; completed the localStorage inventory in PRIVACY.

## [0.1.30-beta.40] - 2026-06-03

### Fixed

- **Linux system-scope service install now uses persistent, self-contained `/opt` paths instead of `/tmp` + the installing user's home.** A system-scope install left the root service mis-pathed: its `config.json` landed in `/tmp/WsScrcpyWeb` (ephemeral — wiped on reboot) because the unit set no `DATA_ROOT` and a root service has no `HOME`, and it ran `node`/`adb` from the installing user's `~/.local/share/.../dependencies` (fragile, a root-executing-user-writable-binary surface, and a Local-Dependencies-Only violation). The install now points the unit's `DATA_ROOT` + `DEPS_PATH` at `/opt/ws-scrcpy-web/{data,dependencies}`, copies the deps into `/opt` (the tree is `bin_t`-labelled so `init_t` can exec them; the data dir gets a more-specific `var_lib_t` rule so the service can write it under SELinux), and seeds the service's `config.json` (`installMode`, `firstRunComplete`, the user's web port) — so the service reads a correct, persistent config (no stray WelcomeModal), survives reboots, runs the app's own deps, and the post-install browser hand-off lands on the same port. As defense-in-depth, Rust `data_root_for_linux` no longer silently falls back to `/tmp` when nothing is set; it fails loudly so a misconfiguration is caught. (The system-scope uninstall→relaunch hand-off is a separate follow-up.)
- **"Reset welcome and bookmark prompts" now fully clears the per-port bookmark dismissal.** `WelcomeModal` and `ServiceFirstRunModal` eagerly PATCHed `bookmarkDismissedForPort` to the current port in their constructors. Because the reset re-shows the welcome modal (it sets `firstRunComplete: false`), that eager write re-stamped the current port over the reset's `null` — so the bookmark reminder stayed suppressed for that port. The eager stamp was redundant (modal priority is already gated in `index.ts`, and each modal's completion path stamps the port legitimately) and has been removed.
- **README points to the real "stop server & exit" location.** The Linux "no tray icon" note directed users to a nonexistent "Settings → Server → Stop Server"; it now points to "Settings → App → stop server & exit" (where the button shipped in beta.39), and the button is listed in the Configuration section.

## [0.1.30-beta.39] - 2026-06-02

### Added

- **"Stop server & exit" button (Settings → App).** A new button cleanly stops the server and closes the app on every platform. It confirms first, then runs graceful teardown — stopping the adb daemon and releasing active device streams — before exiting, and closes the browser tab (falling back to an "app stopped — you can close this tab" page when the browser blocks self-close). On Windows it also reaps the standalone tray helper, which is spawned detached and would otherwise be left orphaned pointing at a dead launcher (the reap is skipped during an in-app update / uninstall handoff, which relaunch and keep their tray). The button is disabled with an explanatory note in service mode, where the OS service manager owns the lifecycle. It reuses the existing `/api/server/shutdown` endpoint, which now runs the same graceful teardown the `SIGINT`/`SIGTERM` path does — fixing a latent case where a tray- or endpoint-initiated shutdown exited directly and left the adb daemon orphaned.

### Fixed

- **The Linux Rust data-root resolver now honors `DATA_ROOT`.** `data_root_for_linux` followed only `XDG_DATA_HOME > HOME`, while the Node side (`resolveDataRoot`) honors `DATA_ROOT > XDG_DATA_HOME > ~/.local/share`. An explicit `DATA_ROOT` override is now respected on the Rust side too, across **both** of its callers — the launcher spawn path (`Paths::compute`) and the service-teardown / tray-reap path (`data_root_from_env`) — so they cannot diverge from the Node child's data root.
- **The system-scope service uninstall confirmation renders as neutral info, not an error.** The "service removed — relaunch the app manually" follow-up was shown through the error renderer (red text + a "retry" button) though it is an informational success; it now renders as a plain status line.

## [0.1.30-beta.38] - 2026-06-02

### Added

- **In-app updates now apply in Linux service mode (user and system scope).** Previously only local-mode Linux updates applied; service mode silently no-op'd (it routed to Velopack's AppImage-incompatible apply). The same download → SHA-256-verify → swap machinery is now used for service mode: a launcher helper, launched out-of-cgroup via `systemd-run`, stops the unit → swaps the AppImage → (system scope) re-applies the `bin_t` SELinux label → starts the unit. **user-service** updates the home AppImage via the user manager; **system-service** updates the `/opt` staged copy as root via the system manager — no polkit prompt, so a system service can self-update headlessly. Windows and Linux-local apply paths are unchanged.

### Changed

- **Velopack synced to 1.1.1 across all touchpoints.** Dependabot (#279) bumped only the npm SDK to 1.1.1, leaving the Rust crate (`Cargo.lock`) and the `vpk` CLI pin (`release.yml`) at 1.0.1 — a 3-way skew (the SDK and CLI share a serialization protocol). The Rust crate and `vpk` CLI are now 1.1.1 too. 1.1.1 ships the type-2 AppImage runtime (embedded FUSE), which paves the way to drop the `libfuse2` first-run gate in a follow-up, once verified on a no-libfuse2 distro.

### Fixed

- **The auto-release version-bump now commits `Cargo.lock`.** beta.37 taught `npm run version:bump` to sync the workspace crate versions in `Cargo.lock`, but the auto-release bump-PR commit was assembled from a fixed three-file list (`package.json`/`Cargo.toml`/`CHANGELOG.md`) that dropped the lock change — so the lockfile still lagged through CI-cut releases. `Cargo.lock` is now part of the bump commit, and the beta.37 lag has been resynced.

## [0.1.30-beta.37] - 2026-06-02

### Changed

- **Confirmation dialogs now use the white-outline button style.** The "Root/Administrative Privileges Required" (service install and uninstall) and "End Shell Session" confirm dialogs had solid light-fill buttons; their cancel and confirm buttons now use the shared white-outline button style (white outline + white text, transparent) introduced for the welcome, bookmark, and service-mode modals in beta.29, so every modal button matches.

### Fixed

- **The Linux service-scope radios show which scope is active again when a service is installed.** While a service was installed the user/system scope radios used the `disabled` attribute, and Chromium desaturates `accent-color` on disabled controls — so the selected dot rendered as washed-out grey and you couldn't tell which scope was active. The radios are now kept enabled and made read-only via `pointer-events: none` + `tabindex="-1"`, so the blue selected dot stays visible. (Scope detection itself was already correct; it now has unit-test coverage.)
- **`npm run version:bump` now keeps `Cargo.lock` in sync.** The bump script updated `package.json` and `Cargo.toml` but not `Cargo.lock`, so the workspace crates' resolved versions in the lockfile lagged the manifest. The script now also rewrites the `ws-scrcpy-web-{common,launcher,tray}` version entries in `Cargo.lock` by text edit (so it still runs in the toolchain-less auto-release bump job), and the existing lag has been resynced.

## [0.1.30-beta.36] - 2026-06-02

### Changed

- **v0.1.30-beta.36 is a no-op companion to beta.35** — identical code, published as the update *target* to validate the #27 relaunch fix end-to-end. From a beta.35 instance, run the full failing path — install a user-scope service → uninstall it (relaunch via `systemd-run --collect`) → update — and confirm it swaps **and auto-relaunches** onto beta.36 unattended.

## [0.1.30-beta.35] - 2026-06-02

### Fixed

- **Linux local-mode update now auto-relaunches after the swap (#27, follow-up to beta.33).** beta.33 made the apply helper survive and the binary swap succeed, but the *relaunch* still failed in the service-uninstall case: the helper spawned `systemd-run --user --collect <app>` with `.spawn()` and exited immediately — and because the helper itself runs in its own `--collect` transient unit, exiting reaped that unit's cgroup and killed the `systemd-run` child before it could register the relaunch unit, so the swapped new version never started (the update "succeeded" on disk but the app didn't come back). The relaunch now uses `.status()` (waits for `systemd-run` to register the user-manager-owned transient unit before the helper exits), mirroring the service-teardown relaunch; the non-systemd path still detached-spawns directly. The TS spawn side awaits `systemd-run`'s registration the same way. Net: a local update — including right after a user-scope service uninstall — now swaps **and** relaunches onto the new version unattended.

## [0.1.30-beta.34] - 2026-06-02

### Changed

- **v0.1.30-beta.34 is a no-op companion to beta.33** — identical code, published purely as the update *target* to validate the #27 local-apply fix end-to-end. The fix only takes effect once you're running a version that has it, so validation requires updating **from** beta.33: from a beta.33 instance — especially one relaunched after a **user-scope service uninstall** (the `systemd-run --collect` case that was failing) — update to beta.34 and confirm the AppImage swaps and the app relaunches on beta.34.

## [0.1.30-beta.33] - 2026-06-02

### Fixed

- **Linux local-mode in-app update no longer silently fails to swap (#27).** The update downloads and SHA-256-verifies the new AppImage, then hands off to an out-of-mount helper to swap `$APPIMAGE` and relaunch. That helper was spawned with a plain `detached: true`, which keeps it in the *app's* cgroup — so when the app was running inside a `systemd-run --collect` transient unit (e.g. an instance relaunched by the service-uninstall teardown), the unit's cgroup was reaped on the app's exit and the helper was **killed before it swapped**: the update appeared to hang and the app stayed on the old version (a reboot "fixed" it by returning to a normally-launched instance). The helper now runs in its **own** `systemd-run --user --collect` transient unit (separate cgroup), falling back to `setsid` then a bare detached spawn on non-systemd hosts; and it relaunches the swapped AppImage the same way so the new instance survives the helper's exit. The helper also clears the staged file + the apply-update marker on completion. A normally-launched update was unaffected; this fixes the update-after-service-uninstall case. Windows + Linux service mode unchanged.

## [0.1.30-beta.32] - 2026-06-02

> Note: the beta.31 version number was skipped — the auto-release flow cut these changes as beta.32. There was no public beta.31 release.

Fixes for issues found smoke-testing **beta.30**'s Linux service mode on real Fedora 44 (SELinux enforcing), plus a bookmark global-dismiss option. Windows service mode and Linux local mode are byte-for-byte unchanged; there are no launcher/Rust changes.

### Added

- **Global bookmark dismissal.** The bookmark reminder (`PortChangeModal`) gains a second option — "don't show again — ever, even when the port changes" — gated behind a confirmation dialog and persisted as `bookmarkDismissedGlobally` in `config.json`. Checking it supersedes and disables the per-port checkbox. "Reset welcome and bookmark prompts" now clears it as well.

### Fixed

- **Linux system-scope service uninstall now tears down under SELinux.** The teardown handoff exec'd the launcher helper from `~/.local/share/…` (`data_home_t`), which SELinux (Fedora enforcing) denies `init_t` from executing — so a system-scope uninstall silently failed and the service persisted. System install now also stages the helper into `/opt/ws-scrcpy-web/` (labelled `bin_t` by the existing fcontext rule), and uninstall execs that copy via `systemd-run --system`, wrapped in `pkexec` when the triggering process isn't already root. User-scope uninstall is unchanged.
- **systemd `StartLimit*` keys moved to `[Unit]`.** `StartLimitIntervalSec`/`StartLimitBurst` were emitted in `[Service]`, where systemd ignores them — so the restart cap never applied and a failing unit restarted every 5 s indefinitely. They now live in `[Unit]`.
- **No more orphaned/concurrent local instances after a Linux service install.** The post-install local-instance exit was gated to Windows; on Linux the originating local app lingered (up to three concurrent instances were observed) and held the web port. It now exits after a successful install on Linux too.
- **No false "port discovery timed out" after install.** When the service reclaims the same web port — now the common case, since the local instance exits — the install poll detects the local server going away and reconnects to the same URL after a short grace, instead of reporting an error. The port-shift navigate path (used on Windows) is unchanged.
- **Install-scope radio contrast.** When a service is installed the scope radios are disabled and were muted to `opacity:0.5` with no `accent-color`, hiding the selected dot; they now use `accent-color:#5b9aff` and a lifted `0.65` disabled opacity.

### Docs

- **README:** corrected the systemd unit name to `WsScrcpyWeb.service` and scope-qualified the "do not move the AppImage" caveat — a system-scope service runs the staged `/opt/ws-scrcpy-web/` copy, so only a user-scope service is affected by moving the home AppImage.

## [0.1.30-beta.30] - 2026-06-02

### Fixed

- **Linux system-scope service install now starts under SELinux (item 33).** The system unit's `ExecStart` was the user-home `$APPIMAGE`, but systemd runs system units under the `init_t` domain and SELinux-enforcing (Fedora) denies `init_t` exec of a `user_home_t` file — so the service failed to start and restart-looped on a repeating AVC. System-scope install now stages the AppImage to a root-owned `/opt/ws-scrcpy-web/`, labels it `bin_t` (persistent `semanage fcontext` + `restorecon`, with a `chcon` fallback for minimal images — all best-effort and isolated so a label failure on a non-SELinux distro doesn't abort the install), and points the unit's `ExecStart` there. User scope is unchanged (runs as the unconfined user from the home AppImage).
- **Linux service uninstall now tears down cleanly and returns to local mode (item 32).** Uninstall previously ran `systemctl disable --now` from inside the service's own cgroup, killing the calling process mid-operation (leaving stragglers and a non-functional app). It now hands off to an out-of-cgroup helper launched via `systemd-run` (a transient unit that survives stopping the service unit): the helper stops → disables → `reset-failed` → removes the unit (and, for system scope, the `/opt` staging plus the SELinux `fcontext` rule) → reaps the escaped adb daemon → and on user scope relaunches the home AppImage in local mode via its own transient unit. Windows uninstall is byte-for-byte unchanged.

### Changed

- **Linux service-mode OS tools now resolve to absolute paths (Local-Dependencies-Only).** `systemctl`, `pkexec`, `loginctl`, `ldconfig`, `systemd-run`, `cp`, `chmod`, `restorecon`, `chcon`, and `semanage` are invoked by absolute path (resolved across `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`) instead of by bare name, closing the `$PATH`-hijack surface — mirroring the Windows `System32` hardening.

## [0.1.30-beta.29] - 2026-06-01

### Changed

- **Consistent modal button styling (all platforms).** The welcome modal's install-service buttons use white text (was blue), and the bookmark (`PortChangeModal`) + service-first-run (`ServiceFirstRunModal`) "got it" buttons now get the same white-outline / white-text / mono treatment — they previously fell back to the browser-default button because their `.modal-button` class had no CSS. All three modals now match the app's outline-button motif.

## [0.1.30-beta.28] - 2026-06-01

### Changed

- **v0.1.30-beta.28 is a no-op companion release to beta.27** — identical code, published as the upgrade target for verifying the new download-based Linux in-app update apply: install beta.27 in user mode on Linux, click update, and confirm the "updating…" overlay appears (above Settings), the AppImage is downloaded + SHA-256-verified + swapped, and the app relaunches on beta.28.

## [0.1.30-beta.27] - 2026-06-01

### Fixed

- **Linux in-app updates now actually apply (fourth Linux updater fix — the real one).** beta.25's `waitExitThenApplyUpdate(restart=true)` was inert on Linux: Velopack 1.0.1's `UpdateNix apply`, invoked with only `--root <appimage>`, re-derives its own locator via `FromSpecifiedRootDir` and fails the `UpdateExePath.exists()` check (`locator.rs:114`) — aborting in under a millisecond with "Update.exe does not exist in the expected path", before any file is touched (confirmed on real Fedora via `/tmp/velopack.log`, mode- and restart-independent). Linux local-mode apply no longer uses Velopack's updater: it downloads the published AppImage from the GitHub release, verifies it against the release `SHA256SUMS`, and hands off to an out-of-mount launcher helper (`--linux-apply`) that backs up + swaps `$APPIMAGE` and relaunches it. Velopack 1.1.1 documents no fix for this path, so the dependency is unchanged. Windows + Linux service mode are byte-for-byte unchanged.
- **Upgrading overlay no longer hides behind the Settings dialog.** The `UpgradingOverlay` was a `z-index:99999` div on `document.body`, but the Settings modal is a native `<dialog>` opened with `showModal()` — the browser top layer, which paints above the normal DOM regardless of z-index, so the overlay (and its "reopen the url" timeout fallback) was invisible when apply failed. The overlay is now itself a top-layer `<dialog>`.

### Changed

- **Linux discovery no longer pre-downloads the unused Velopack nupkg.** With apply fetching the AppImage directly, the ~60 MB nupkg is never used on Linux, so `checkForUpdates` skips it there.

## [0.1.30-beta.26] - 2026-06-01

### Changed

- **v0.1.30-beta.26 is a no-op companion release to beta.25** — identical code, published as the update target for verifying the now-fixed Linux in-app update APPLY path (install beta.25, click update, confirm the "updating…" overlay appears and the app reloads on beta.26).

## [0.1.30-beta.25] - 2026-06-01

### Added

- **"Updating…" handoff overlay for Linux in-app updates.** On a `mode:'reconnect'` apply response, the client shows a full-viewport `UpgradingOverlay` and polls the same origin until the relaunched app answers on the new version, then reloads — with a bookmark-URL fallback if it doesn't return within ~60s (so you're never stranded). Windows keeps its operation-server redirect; the reconnect path is gated on the Linux-only `mode` flag. (PR #246.)

### Fixed

- **Linux in-app updates now apply and relaunch (third + final Linux updater fix).** After beta.23 fixed discovery (locator + per-platform feed), *applying* an update on Linux killed the app without updating: local-mode `applyUpdate` spawned the Windows operation-server helper (`ws-scrcpy-web-launcher.exe`), which ENOENTs on Linux, so Velopack's apply never ran and the deferred `process.exit` took the app down (re-running the AppImage came back on the old version). Linux local-mode now calls `waitExitThenApplyUpdate(restart=true)` directly — Velopack applies on exit and relaunches the AppImage, which rebinds the freed web port. Windows is byte-for-byte unchanged. (PR #246.)

## [0.1.30-beta.24] - 2026-06-01

### Changed

- **v0.1.30-beta.24 is a no-op companion release to beta.23** — identical code, published solely as the update target for verifying the now-fixed Linux in-app updater (install beta.23, confirm it auto-updates to beta.24). The no-op-companion practice was retired for the stable Windows updater (see `docs/RELEASING.md`), but is re-used here specifically to verify the Linux updater end-to-end.

## [0.1.30-beta.23] - 2026-06-01

### Fixed

- **Linux in-app updates: `UpdateManager` no longer fails to construct.** beta.21 (#237) passed no locator on Linux, delegating to Velopack's `auto_locate_app_manifest`. But that function (velopack 1.0.1 `lib-rust/src/locator.rs`) locates the install by searching **`std::env::current_exe()`** for `/usr/bin/`, and our server runs under the Node binary in `<dataRoot>/dependencies/node/` (Local-Dependencies-Only) — no `/usr/bin/` segment — so it returned "Could not locate '/usr/bin/'", construction threw, `init()` nulled `mgr`, and every check silently no-oped. The Linux locator is now hand-built and anchored on `__dirname` (the bundle at `<mount>/usr/bin/dist`, reliably under the mount): contents dir = `installRoot/bin` = `<mount>/usr/bin`, mirroring Velopack's own Linux output. (`$APPIMAGE` only sets `RootAppDir`; it does not drive install-root discovery, contrary to the beta.21 assumption.) (PR #242.)
- **Linux in-app updates: the feed now contains an installable Linux package.** Even with the locator fixed, the app queried `releases.{beta,stable}.json` — which list only the Windows package — while the Linux build packed channel `linux` and never uploaded its feed/nupkg. Linux now uses per-platform channels: the app queries `linux-<channel>` (`UpdateService.resolveExplicitChannel`), `package-linux.mjs` packs `--channel linux-<beta|stable>` (+ `-o Releases`), and `release.yml` uploads the `releases.linux-<channel>.json` feed + Linux `.nupkg`. Windows packaging is unchanged. (PR #242.)

### Security

- **`dependabot-auto-merge.yml` no longer grants a workflow-level write token.** The top-level `permissions:` block granted `contents: write` + `pull-requests: write` to the entire workflow; the `auto-merge` job now declares those writes itself and the workflow default drops to `contents: read`. Closes the high-severity `TokenPermissionsID` (OpenSSF Scorecard / CodeQL) code-scanning alert. Mirrors the `release.yml` hardening that closed Scorecard alert #16.

## [0.1.30-beta.22] - 2026-05-28

### Fixed

- **Linux in-app updates now actually work (corrects beta.19's attempted fix).** beta.19 (#230) hand-built `VelopackLocatorConfig` on Linux from `path.resolve(__dirname, '..', '..')`, but that Windows-shaped arithmetic is off by one level on the AppImage: the payload sits at `<mount>/usr/bin/dist` (one deeper than Windows' `<root>/current/dist`), so `installRoot` resolved to `<mount>/usr` and `path.join(installRoot,'usr','bin')` produced a doubled `<mount>/usr/usr/bin`. Velopack couldn't find `UpdateNix`/`sq.version` there, `UpdateManager` construction threw, `init()`'s catch nulled `mgr`, and every update check silently no-oped. Fixed by passing **no** locator on Linux and delegating to Velopack's native `auto_locate_app_manifest` (which derives the correct paths from `$APPIMAGE`); Windows keeps its explicit locator. A `platform` injection seam on `UpdateService` lets both branches be unit-tested on any host — the original bug hid because tests only ran the host-platform branch. (PR #237; shipped in beta.21 + beta.22.)
- **Linux service install now produces a service that actually runs.** The systemd unit's `ExecStart` was `process.execPath`, which in the server process is the Node binary (the server runs as a Node child of the launcher), not the launcher/AppImage. systemd started Node with no script argument; under its `/dev/null` stdin Node read EOF and exited immediately, so the service never bound a port, never auto-shifted on collision, the install-flow redirect timed out ("couldn't find the new port"), and status read "stopped." Fixed by using the stable `$APPIMAGE` entry as `ExecStart` (running it re-mounts and runs the launcher → server binds + auto-shifts the port via PortPicker), falling back to `process.execPath` for from-source runs. Applies to both user and system scope. (PR #237.)
- **Linux service scope radio now reflects the installed scope.** `/api/service/status` now reports the authoritative scope from `SystemdClient.resolveActiveScope()` (which systemd unit file exists on disk) via a new optional `ServiceClient.getInstalledScope()`; the settings modal selects the scope radio from that, falling back to mapping all four `installMode` forms instead of only the two `-service` forms. Pre-fix a drifted or reverted `installMode` left both radios unselected on an installed service. (PR #237.)

### Changed

- **v0.1.30-beta.22 is a no-op companion release to beta.21** — identical code, published solely as the update target for verifying the now-fixed Linux in-app updater (install beta.21, confirm it auto-updates to beta.22). See `docs/RELEASING.md` "no-op companion releases."

## [0.1.30-beta.21] - 2026-05-28

## [0.1.30-beta.20] - 2026-05-28

### Changed

- **Settings modal controls column now flexes to fill remaining width** (`grid-template-columns: [labels] 20rem [controls] 1fr` — was `[labels] 20rem [controls] 16rem [end] 1fr`). The pre-fix fixed 16rem controls column was sized against Windows font rendering ("not installed — install?" ≈ 231px at 13px monospace, fit). On Linux 1920x1080 unscaled the same monospace string renders ~10% wider and wrapped to two lines, along with "system (req. sudo)" radios and other steady-state controls. Flexing controls to `1fr` gives Linux the breathing room without affecting Windows visually (controls hug left via `.settings-control justify-content: flex-start`; extra width on Windows is just empty space to the right of each control).
- **Server section label tightened** from "save restarts & redirects to new port" to "save restarts & redirects" — the "to new port" suffix is implicit (saving the port field obviously redirects to that port) and was the longest steady-state label string, putting pressure on the 20rem labels column on Linux.

## [0.1.30-beta.19] - 2026-05-28

### Changed

- **Settings modal Linux scope chooser now always renders, even when the service is installed.** When the service is installed, the radios are pre-selected from the active install mode (`user-service` → user, `system-service` → system) and disabled — switching scope is still a deliberate uninstall→reinstall operation (systemd user-scope and system-scope unit files can't coexist for the same service name), but now the user can see at a glance which scope they picked. Pre-fix the row was hidden entirely once installed and there was no in-UI way to tell the active scope. Disabled-radio labels render with `opacity: 0.5` + `cursor: not-allowed` via a `:has(input:disabled)` rule. `ServiceStatusResponse` now carries `installMode` so the frontend doesn't need a second endpoint to populate the row.
- **Settings modal Linux scope chooser now lives in a standard 2-column grid row** matching the update channel row. Description on the left ("service scope"), radios on the right ("user" / "system (req. sudo)"). The pre-v0.1.30 implementation rendered the chooser as a `<fieldset>` spanning both columns, which (a) didn't match any other settings row and (b) starved the install-button row below it of horizontal space on narrower modal widths, causing the button text "not installed — install?" to wrap to two lines. Removed the orphaned `.settings-scope-fieldset` CSS as part of the cleanup.

### Fixed

- **Linux system-scope service install now triggers the pkexec password prompt as designed.** A stale guard in `ServiceApi.handleInstall` (predating PR #211) returned 403 with the message *"system scope requires root. Relaunch the AppImage with sudo, or pick user scope."* whenever the API received a `scope: 'system'` request from a non-root process — short-circuiting before `SystemdClient.install()` (which was rewritten in PR #211 to elevate via pkexec) was ever reached. The guard was a holdover from when `SystemdClient` also threw on non-root system-scope, "doing it at the API boundary lets us return a clean HTTP error code." `SystemdClient` no longer throws there. Removed the guard so the request falls through to the pkexec path. Paired updates: `AdminConfirmModal.ts` Linux confirmation text rewritten from *"the appimage must be launched with sudo"* to *"polkit will show a password prompt next."* The 403-asserting test in `ServiceApi.test.ts` was inverted to confirm `installFn` IS called with `scope: 'system'` and the API returns 200; pkexec mechanics remain `SystemdClient`'s responsibility.
- **Linux in-app updates now work.** `UpdateService` built `VelopackLocatorConfig` with Windows-shape paths (`UpdateExePath: <root>/Update.exe`, `CurrentBinaryDir: <root>/current`, etc.) on every platform. Velopack 1.0.1's lib-rust `auto_locate_app_manifest` validates `UpdateNix` existence at the configured path before returning, so `UpdateManager` construction threw on every Linux AppImage launch. Beta.7's PR #216 added an `mgr === null` guard in `reconfigure()` to mask the throw at the cost of silent no-op updates. Now platform-branched: Windows keeps the Squirrel-style `<installRoot>/current/` layout; Linux mirrors the Velopack Linux locator exactly — `RootAppDir = $APPIMAGE`, `UpdateExePath = <mount>/usr/bin/UpdateNix`, `PackagesDir = /var/tmp/velopack/WsScrcpyWeb/packages`, `ManifestPath = <mount>/usr/bin/sq.version`, `CurrentBinaryDir = <mount>/usr/bin`, `IsPortable = true`. The `mgr === null` guard is retained as defensive belt-and-suspenders only.

### Changed

- `release.yml` Publish step: `make_latest: 'legacy'` → `make_latest: true`. The legacy value was intended to fix releases-page sort drift but caused GitHub's Latest badge to stick at `v0.1.30-beta.9` across the entire beta.10–18 push on 2026-05-28, making 9 newer betas invisible to Velopack's `GithubSource` (which queries `/releases/latest` to discover the newest release in the configured channel). Forcing every release to claim Latest restores discovery; sort order will be addressed separately if it regresses.

### Removed

- v0.1.30-beta.3 through v0.1.30-beta.17 GitHub releases. They were iterative UI-polish + Linux-debug intermediates that have no value to anyone outside testing. v0.1.30-beta.18 absorbs all their content and remains the discoverable beta. Tags are preserved in git history; only the GitHub releases (and their attached assets) were deleted.

## [0.1.30-beta.18] - 2026-05-28

### Changed

- Device card button internal padding reduced: modal-launch buttons `0.3rem 0.75rem` → `0.15rem 0.5rem`; disconnect + sleep-wake `4px 10px` → `2px 8px`. Text size unchanged.
- All device card buttons left-aligned within their grid cells (modal-launch + action). Cell padding (`0 8px`) provides offset from the gray cell border.
- Device card grid cells uniform height (`36px` with `box-sizing: border-box`) across both the services grid and the device-actions row, so all three rows are the same height. Previously the modal-launch row 2 was shortest (button content without icon), and the action row was tallest (heavier button styling); now all three render identical.

## [0.1.30-beta.17] - 2026-05-28

### Fixed

- Device card horizontal padding now symmetric (8px 14px); the 3px green/red active-state left border is outside this padding so it doesn't unbalance the content area.
- Device card grid dividers now render crisp (no sub-pixel anti-aliasing). The previous attempt used 1px grid-track dividers (`grid-template-columns: 1fr 1px 1fr`), which position based on neighbor auto-tracks that often land on sub-pixel boundaries — the browser anti-aliased the line across two physical pixels, making it thicker and dimmer than the outer borders. Switched to cell-border drawing: `.desc-block` items stretch to fill their grid cells and get `border-right` / `border-bottom` via `:nth-child` to draw the cross; action buttons are now wrapped in `.action-cell` divs with the same treatment. Borders sit at element edges (always integer pixels) and render at the same crispness as the outer card border.
- Blue button border moved from `.desc-block` (now the cell) to the inner `.action-button` / `<a>` (the actual button shape). Visual unchanged — blue-bordered button sits centered inside a gray-bordered cell.

## [0.1.30-beta.16] - 2026-05-28

### Changed

- "check for updates" button (Dependencies section) now uses green border + text (`var(--success-color)`), matching the "turn on" sleep-wake button.
- Network-discovery scan buttons (quick scan, scan network, manually add) now use orange border + text (`var(--warning-color)`).
- `--warning-color` (dark theme) changed from amber `#fbbf24` to orange `#fb923c` for a clearer "not yellow" orange. Light theme `#b45309` (already orange-700) unchanged. `.dep-warn` status badge follows the new orange.

## [0.1.30-beta.15] - 2026-05-28

> Note: v0.1.30-beta.14 was tagged but its squash-merge silently failed, so the beta.14 release artifacts contain beta.13 content. This release combines everything that was meant for beta.14 plus the table-grid additions below.

### Changed

- `.dep-btn` button border (3 scan-section buttons + "check for updates" button) changed from `var(--text-color)` (white) to `#5b9aff` (matching their blue text).
- Device card modal-launch + action buttons centered within their grid cells (`justify-items: start` → `center`).
- Device card button grids redrawn as full table-style grids with both outer (left/right/top/bottom) and inner (vertical between columns, horizontal between modal-launch rows) borders. Dividers implemented as real 1px grid tracks (`grid-template-columns: 1fr 1px 1fr`, `grid-template-rows: auto 1px auto`) so they land on integer pixel positions regardless of card width — fixes the sub-pixel anti-aliasing artifact where the vertical divider appeared thicker/lighter on cards whose width didn't divide evenly into 2.

## [0.1.30-beta.13] - 2026-05-28

### Changed

- Device card button borders now match their text color: disconnect red, turn on green, turn off red, "checking…" gray, modal-launch buttons (shell/list files/connect/config stream) blue.
- Card inner padding shifted asymmetric (8px / 8px / 8px / 20px — left bumped 8 → 20). Card outer width unchanged; the inner content shifts right to balance the open whitespace on the right of the value column.

## [0.1.30-beta.12] - 2026-05-28

### Changed

- Device card separator spacing equalized: gap above the modal-launch buttons now matches the gap above the action buttons (services `padding-top` 4px → 8px).
- Action button borders unified with the modal-launch button color (`var(--text-color)`); text colors stay red (disconnect), green (turn on), red (turn off), gray (checking…).
- Action buttons aligned to the same 2-column grid as the modal-launch buttons: disconnect under the left column (shell / list files), turn-on/off under the right column (connect / config stream).

## [0.1.30-beta.11] - 2026-05-28

### Changed

- Device card layout: action buttons (disconnect + turn on/off) moved to the bottom of the card. Modal-launch buttons (shell, list files, connect, config stream) shift up accordingly.
- "opens in modal" label removed; the four blue modal-launch buttons are self-explanatory and the label was making cards taller than needed.

## [0.1.30-beta.10] - 2026-05-28

### Changed

- Device card polish: thin border-top separator above the disconnect/turn-on/off action row (matches the "opens in modal" services separator); label-to-value gap widened from 8px to 24px so info reads less cramped; gap between disconnect and turn-on/off buttons widened from 8px to 20px.

## [0.1.30-beta.9] - 2026-05-28

### Fixed

- **Linux device card overflow.** Disconnect + turn-on/off buttons moved out of the device-info table cell (`<td rowSpan=2>`) into a dedicated `<div class="device-actions">` sibling row, centered horizontally. Linux's wider mono-font rendering used to push the table layout past the card border when actions were a rowSpan cell -- clipping the "turn off" button and the Device Name pencil edit icon. Buttons now sit in their own row below the SDK info, centered, with no clipping on either platform.

## [0.1.30-beta.8] - 2026-05-28

### Changed

- **PortChangeModal dismissal moved from localStorage to config.json.** Adds `bookmarkDismissedForPort: number | null` field to `AppConfig`; defaults to `null`. Stores the last-acknowledged web port; modal re-shows whenever the current web port differs from this value. The localStorage version was unreliable on Linux AppImage where the browser may treat each launch as a different origin, causing the modal to appear repeatedly. Deletes `src/app/client/firstRunGate.ts` and its tests; all modal-dismissal state now lives server-side in `config.json` alongside `firstRunComplete` and `serviceFirstRunSeen`.

## [0.1.30-beta.7] - 2026-05-27

### Fixed

- **Linux updates error on channel change.** `reconfigure()` now skips UpdateManager reconstruction when `mgr` is null (init couldn't construct it on Linux AppImage where Velopack SDK has no `Update.exe` equivalent). Prevents "reconfigure failed" error in Settings > Updates.
- **Device card clipping.** Remove `overflow:hidden` from device card container -- it was clipping the pencil edit button and the right edge of the "turn off" button.

## [0.1.30-beta.6] - 2026-05-27

### Fixed

- Device card layout regression: remove `table-layout:fixed` from device info table -- it collapsed the label column to ~3px, causing device info labels to overlay values and "turn off" button text to overflow its border.

## [0.1.30-beta.5] - 2026-05-28

## [0.1.30-beta.4] - 2026-05-28

## [0.1.30-beta.3] - 2026-05-27

## [0.1.30-beta.2] - 2026-05-27

## [0.1.30-beta.1] - 2026-05-27

## [0.1.29] - 2026-05-27

### Changed

- **Velopack upgraded from prerelease 0.0.1589-ga2c5a97 to stable 1.0.1.** Bumped across all four touchpoints: Rust crate (`Cargo.toml`), npm package (`package.json`), and vpk CLI pin (`release.yml`, both build-windows and build-linux jobs). Zero API changes -- all Rust builder patterns, npm exports, and CLI flags are preserved. The `--msi` flag now produces a true Windows Installer MSI (improved per-machine support, proper installer UI) instead of the older Squirrel-style wrapper.
- **Automated release pipeline.** New `auto-release.yml` workflow automates version bump + tag push on labeled PR merges. Add `release:beta` or `release:stable` label to a PR; on merge, the pipeline computes the next version, creates a bump PR, and after CI passes, pushes the tag to trigger the full build + publish.

### Fixed

- **Service uninstall no longer races Servy's recovery timer.** Replaced the fire-and-forget `post-stop.bat` uninstall path with a launcher-driven approach: the launcher spawns a detached process that calls `servy-cli stop` (putting Servy in stopping state, which disables recovery) followed by `servy-cli uninstall` and local-mode launcher spawn. Uses Task Scheduler to escape the Servy job object. The launcher blocks until Servy's stop signal arrives, eliminating the timing dependency that caused the uninstall to hang indefinitely.
- **Shell close confirmation redesigned.** Replaced the raw inline-styled `<dialog>` with a proper `ShellCloseConfirmModal` extending the Modal base class -- same title bar, theme toggle, glassmorphism frame, and right-aligned footer buttons as the service install/uninstall modal.
- **Shell button no longer greyed out in service mode.** Node-pty staging guard now correctly detects the prebuilt binary, preventing the shell feature from being disabled when running as a Windows service.

### Removed

- **Iterative bug-test releases cleaned from GitHub Releases.** Deleted: v0.1.29-beta.1 through beta.10 (service uninstall + shell modal + CI pipeline iterations). Orphaned git tags remain (tag protection ruleset).

## [0.1.28] - 2026-05-27

Stable release rolling up the v0.1.28-beta.17/18 series. Headline: **local-mode in-app updates now work reliably** — the operation-server binds a separate port so it never fights Node for the socket, eliminating the IPv4-dead dual-stack bug that plagued the entire beta chain.

### Fixed

- **Local-mode update redesign (§40).** Operation-server now binds `config_port + 1` (probing upward) instead of competing with Node for `config_port`. Eliminates the IPv4-dead / dual-stack corruption bug where `127.0.0.1:8000` became unreachable after updates while `[::1]:8000` worked. Three stacked bugs fixed: port conflict (separate port), stale helper binary (neutralized — old code fails gracefully), Node resolution (`spawn_server` now resolves from `dependencies/node/` before falling back to `seed/node/`). Browser redirect flow: Node spawns operation-server → poll-reads port file → serves redirect to browser → operation-server probes for new Node → redirects browser back.
- **Welcome modal "No" without checkbox no longer writes to config.** Clicking "No, run on demand" without checking "don't show again" previously PATCHed `installMode: 'user'` to config.json (showing a misleading "saving..." flash). Now only writes when the checkbox is checked. Modal re-fires on next page load as expected.

### Changed

- **`resolve_node_with` relaxed.** When `deps_path` is set but the node binary isn't there yet (first-run bootstrap), resolution now falls through to `seed/node/node.exe` instead of hard-failing. `spawn_server` passes `deps_path` directly instead of reading `DEPS_PATH` from process env.
- **Supervisor §40 path simplified.** `wait_for_port_free` + stop-marker coordination is now service-mode only. Node spawns the operation-server directly (moved from supervisor).
- **Updating page JS rewritten.** Polls `/api/discover` on the operation-server's own port (was `/api/config` on the shared port). 60-second timeout with error message.
- **Releases page sort fix.** `make_latest: 'legacy'` in release.yml so GitHub uses SemVer-aware sorting instead of each beta forcibly stealing the Latest badge.

### Removed

- **Iterative bug-test releases cleaned from GitHub Releases.** This project uses GitHub's CI pipeline as a secondary vetting backstop — each CI-validated iteration IS the test. The Releases page accumulates artifacts not intended as user-facing installs. Periodically pruned to keep the page navigable. Orphaned git tags remain (tag protection ruleset). Deleted: v0.1.28-beta.1-16 (§40 iterations), v0.1.25-beta.* (service rearchitecture, rolled into v0.1.26), v0.1.5-v0.1.23 (rapid iteration chain).

### Migration

v0.1.27 and v0.1.26 users can in-app update to v0.1.28 normally. The separate-port operation-server activates automatically. No fresh install required.

## [0.1.27] - 2026-05-25

### Fixed

- shell-disabled tooltip now shows per-reason wording from `/api/capabilities` instead of hardcoded Node-ABI message
- file browser error overlay (was `console.error` only, now shows visual overlay)
- file browser hashchange navigation (back/forward buttons now drive content load)
- scrubbed 3 private CLAUDE.md citations from public source comments

### Changed

- TECHNICAL_GUIDE refreshed with 5 new architecture sections (§19-23) + README updated for v0.1.26
- removed stale TODO comments (drag-from-outside, HostTracker binary rewrite)

## [0.1.26] - 2026-05-25

Stable release rolling up 67 beta iterations (v0.1.25-beta.1 through beta.67). Headline: **service mode completely rearchitected** — installs and uninstalls are now seamless, no UAC prompt on uninstall, no 30s port-sweep delays, no stuck modals, and the tray helper is unified across both modes.

### Changed

- **Service uninstall rearchitected (operation-server pattern).** Replaces the Theory D cross-session handoff dance. The service-Node writes an uninstall marker, spawns a lightweight Rust operation-server to hold the port, and exits. Servy's post-stop bat completes the uninstall + spawns a fresh user-session launcher. The browser stays on a spinner page throughout — no "this site can't be reached", no UAC prompt, no stuck fetch. Completes in ~5-10s.
- **Service install: mtime-based port discovery (eliminates 30s delay).** Instead of sweeping 100 ports for the new service-Node's `/api/whoami`, the frontend now polls `/api/service/status` until config.json's mtime changes (meaning the new process wrote its port), then navigates. Instantaneous once the service starts.
- **Tray architecture unified.** Both local and service modes now use a standalone `ws-scrcpy-web-tray.exe` supervised by the launcher's 10s poll loop. Eliminates the dual-code-path (in-process thread vs standalone exe) that caused icon-registration collisions and no-recovery states. Mode-aware text updates automatically on install/uninstall.
- **In-app upgrade page.** A Rust-based upgrade-server binds the app port before Node exits, serves a static "updating, please wait..." page for the entire Velopack swap window (~3-8s). Wind-down probe detects when the new Node is ready and navigates the browser there — including across port shifts.
- **All console window flashes eliminated.** Every `Command::new` in the launcher now uses `CREATE_NO_WINDOW` via `silent_command`. No cmd.exe black-rectangle flicker during install, uninstall, or tray operations.
- **TS6 compliance.** Every `try/finally` cleanup site across `src/` converted to `using`/`await using` declarations. Zero `} finally {` blocks remain.

### Fixed

- **Session-ID inconsistency (§33).** Two Win32 APIs were answering "which session?" differently — `WTSGetActiveConsoleSessionId` (unstable on VM/RDP/idle) vs `WTSEnumerateSessionsW` (correct). All callers consolidated on the latter via `common::session::active_interactive_session()`. Fixes the deterministic "uninstall fails after reboot" bug and the non-deterministic "tray 5s-poll kills handoff mid-flight" bug.
- **Service-mode port persistence (§32 Part 5c).** Local Node's in-memory `webPort` now syncs to the actual service port immediately after install, preventing stale writes from clobbering config.json.
- **AdminConfirmModal double-showModal.** Settings → Install/Uninstall Service now works (was silently broken by a redundant `showModal()` call).
- **Dev-mode dep update safety.** In-app Node/ADB updates gated behind launcher presence; `installNodejs` uses extract-then-rename with rollback on failure.
- **First-run modal dismissal survives port shifts.** Moved from localStorage to config.json (port-independent).

### Added

- Operation-server `/api/discover` endpoint (config.json disk-read for uninstall transition)
- Service operation interstitial modals (spinner during install/uninstall)
- Post-stop bat diagnostic logging
- Local-deps compliance audit report (`docs/audits/2026-05-25-local-deps-compliance.md`)

### Removed

- `src/server/service/discoverServicePort.ts` (replaced by mtime-based discovery)
- `src/app/client/ServerReachabilityOverlay.ts` (replaced by upgrade-server)
- Theory D handoff dead code (`handoffUninstallToUserSession` + helpers)
- In-process tray thread (`launcher/src/tray.rs`)
- HKLM\Run tray auto-start (replaced by supervisor-owned spawn)

### Security

- CodeQL advanced setup with Rust scanning (actions + javascript-typescript + rust)
- All GitHub Actions SHA-pinned with `sha_pinning_required: true` enforced
- Sigstore SLSA Provenance attestations on Windows MSI + Linux AppImage
- Dependabot for npm + github-actions ecosystems

### Migration

v0.1.24 and v0.1.25-beta.* users can in-app update to v0.1.26 normally. The operation-server pattern activates automatically; old post-stop bats from earlier betas are regenerated on first service operation. No fresh install required.

## [0.1.25-beta.67] - 2026-05-25

## [0.1.25-beta.66] - 2026-05-25

### Changed

- replaced 30s blocking `discoverServicePort` port sweep with mtime-based config.json discovery for both install and uninstall flows; frontend polls until config.json mtime changes (new process wrote its bound port), then navigates — eliminates the dead-port-spin bug on uninstall (beta.65 repro)
- operation-server gains `/api/discover` endpoint for the uninstall transition window
- `/api/service/status` now returns `diskWebPort` + `configMtime` from disk on every call

### Removed

- `src/server/service/discoverServicePort.ts` — dead code after §39

## [0.1.25-beta.65] - 2026-05-25

## [0.1.25-beta.64] - 2026-05-25

## [0.1.25-beta.63] - 2026-05-25

## [0.1.25-beta.62] - 2026-05-25

## [0.1.25-beta.61] - 2026-05-25

## [0.1.25-beta.60] - 2026-05-25

## [0.1.25-beta.59] - 2026-05-25

## [0.1.25-beta.58] - 2026-05-25

## [0.1.25-beta.57] - 2026-05-25

## [0.1.25-beta.56] - 2026-05-25

## [0.1.25-beta.55] - 2026-05-25

## [0.1.25-beta.54] - 2026-05-25

## [0.1.25-beta.53] - 2026-05-25

## [0.1.25-beta.52] - 2026-05-25

### Fixed

- **All console window flashes eliminated.** Full audit of every `Command::new` in the launcher: `silent_command` (with `CREATE_NO_WINDOW`) now covers icacls (×2 in hooks.rs), taskkill (hooks.rs + tray_supervisor.rs), servy-cli (hooks.rs run_servy), and the tray spawn in elevated_runner. `silent_command` promoted to `pub(crate)` and signature widened to `impl AsRef<OsStr>`.
- **Uninstall modal-to-operation-server transition.** Replaced the blind 8s `window.location.reload()` with a poll loop that detects when the service dies, then waits for the operation-server to bind the port before reloading. Modal stays visible throughout; transition is as fast as the operation-server starts.
- **First-run modal dismissal survives port shifts.** Server-side `firstRunComplete` / `serviceFirstRunSeen` flags synced into localStorage before modal gate checks, so navigating to a new port no longer re-fires dismissed modals.
- **Stale `.old` files cleaned up after successful Node/ADB updates.** `node.exe.old` and `adb.exe.old` (created by the rename-before-copy rollback pattern) are now deleted after `copyDirContents` succeeds.
- **`installAdb` rollback parity.** Applied the same rename-before-copy + rollback pattern from `installNodejs` (PR #98). On Windows, `adb.exe` is now renamed to `adb.exe.old` before `copyDirContents`; if copy fails, `adb.exe` is restored. Prevents a partial-update state where `adb.exe` is missing after a failed ADB update.

### Removed

- **Dead Theory D handoff code (Phase 5 sweep).** Deleted `handoffUninstallToUserSession` method + `issueToken`, `writeUninstallHandoffMarker`, `resolveActiveSessionId`, `resolveLauncherPathForElevation` imports from `ServiceApi.ts` (-99 lines). `consumeToken` retained (still referenced by the resume-token validation block). No behavior change.

## [0.1.25-beta.51] - 2026-05-25

## [0.1.25-beta.50] - 2026-05-25

## [0.1.25-beta.49] - 2026-05-25

## [0.1.25-beta.48] - 2026-05-25

## [0.1.25-beta.47] - 2026-05-25

## [0.1.25-beta.46] - 2026-05-25

## [0.1.25-beta.45] - 2026-05-24

## [0.1.25-beta.44] - 2026-05-24

### Changed

- **Service uninstall now uses operation-server pattern (Phase 4 user-visible flip).** Replaces the Theory D handoff dance. New flow: service-Node writes `uninstall-pending` marker, spawns operation-server (detached), returns `shutting-down` status, exits; post-stop.bat runs `servy-cli uninstall` + spawns fresh user-session launcher; operation-server serves "Uninstalling service, please wait..." page throughout. Frontend `ServiceOperationModal` stays open during transition. **No more UAC prompt during uninstall.** `handoffUninstallToUserSession` function body remains as dead code; deletion in Phase 5.
- **Console window flashes eliminated during service install/uninstall.** `silent_command` helper in `elevated_runner.rs` sets `CREATE_NO_WINDOW` on servy-cli, taskkill, and reg.exe spawns.

## [0.1.25-beta.43] - 2026-05-24

### Fixed

- **Post-stop bat migration on update.** `hook(updated)` now regenerates `post-stop.bat` at the new `<dataRoot>/control/post-stop/` path when it detects the bat only exists at the pre-consolidation `<dataRoot>/post-stop/` path. Also copies the regenerated bat back to the old path so Servy (whose `--postStopPath` config still references the old path) runs current content (new helper paths + diagnostic logging). Cleans up old `<dataRoot>/operation-server/` and `<dataRoot>/upgrade-server/` directories (supervisor already refreshes to `control/` paths on every startup). `write_post_stop_bat` promoted to `pub(crate)` for cross-module access.

## [0.1.25-beta.42] - 2026-05-24

## [0.1.25-beta.41] - 2026-05-24

### Fixed

- **Dev mode no longer crashes on Update Node click.** Per-dep `requiresLauncher` flag gates the in-app dep updater. In dev mode, `nodejs` and `adb` show a disabled "update (dev)" button with a tooltip pointing at `scripts/fetch-node.mjs`. `scrcpy-server` remains updatable in dev (no launcher needed). `POST /api/dependencies/:name/update` returns HTTP 503 with `reason: 'launcher-required'` for the dev-mode refusal. `autoInstallMissing` skips launcher-required deps when launcher unavailable, breaking the restart loop that occurred after a failed manual update left `node.exe` renamed to `node.exe.old`.

- **`installNodejs` no longer leaves Node missing on failed updates.** Reordered to extract to `tmpDir` first (non-destructive); only after extract succeeds does it rename `node.exe` to `node.exe.old` and copy new files. On copy failure, the rename is rolled back so `node.exe` remains the prior version. Applies to production failure modes (network-zip-corrupt, disk-full, AV-quarantine, malformed archive).

Tests: vitest 708/708 (was 695/695 pre-fix; +13 new tests across dependencyDefinitions, dependencyManager, dependencyManager.update, dependencyManager.autoInstallMissing, dependencyApi.update suites).

### Added

- **Service install/uninstall interstitial modals (Phase 3).** New `ServiceOperationModal extends Modal` renders "installing service, please wait..." or "uninstalling service, please wait..." during pending API state. Mounted on click, closed via `using` dispose declaration on every exit path. Three wire-in points: Settings install + Settings uninstall + Welcome install. Non-dismissible (escape / backdrop / close button overridden as no-ops). Visual parity with the launcher-served operation-server page. DOM constructed via createElement + textContent (no innerHTML). (+6 vitest tests in serviceOperationModal.test.ts.)

- **post-stop.bat diagnostic logging.** Each branch of the three-state bat now appends a timestamped log line to `<dataRoot>/logs/post-stop.log`: apply-update, uninstall, or no-op (user-initiated stop). Previously the bat ran in its own `cmd.exe` process with no trace — the "neither marker" branch was invisible. Log directory created defensively; follows the existing `<dataRoot>/logs/` convention alongside `launcher.log` and `tray.log`. (+1 cargo test: `write_post_stop_bat_logs_each_branch_to_post_stop_log`.)

### Changed

- **Consolidated `operation-server/`, `upgrade-server/`, `post-stop/` under `<dataRoot>/control/`.** All service-lifecycle artifacts (markers, helper binary, legacy dual-write, post-stop bat) now live under one directory. Migration is implicit — next service reinstall writes to new paths; old directories become dead artifacts for Phase 5 dead-code sweep.

Tests: cargo 130/130 (was 129/129; +1 post-stop logging test). vitest 708/708 unchanged.

## [0.1.25-beta.40] - 2026-05-23

### Added

- **Launcher uninstall capability via operation-server (dormant)** — Phase 2 of the operation-server rearchitecture per `docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md`. `--spawn-user-launcher` subcommand wraps existing WTS cross-session spawn (`spawn_in_active_user_session`). post-stop.bat broadened from two-state (apply-update / no-op) to three-state (apply-update / uninstall / no-op) using marker discriminators in `<dataRoot>/control/` — `apply-update-pending` (existing) and `uninstall-pending` (new). Operation-server detects variant at spawn time via `detect_operation_variant` and serves per-variant page text via `render_operation_page` (template-token substitution: `__OPERATION_TITLE__` + `__OPERATION_BODY__` in the HTML asset). **No user-visible behavior change** — no Node-side marker writer for uninstall yet (Phase 4 activates the user-visible flip).

## [0.1.25-beta.39] - 2026-05-23

### Changed

- **Renamed `upgrade-server` → `operation-server` internals** (Phase 1 of the operation-server rearchitecture per `docs/superpowers/specs/2026-05-23-operation-server-rearchitecture-design.md`). Pure mechanical rename + dual-write backwards compat:
  - `launcher/src/upgrade_server.rs` → `launcher/src/operation_server.rs`
  - `launcher/assets/upgrade-server-page.html` → `launcher/assets/operation-server-page.html`
  - CLI flag `--upgrade-server` kept as alias for new `--operation-server`
  - Helper binary dual-written to both `<dataRoot>/operation-server/` and `<dataRoot>/upgrade-server/`
  - Stop marker `operation-server-stop` (canonical) with legacy `upgrade-server-stop` honored at read time
  - post-stop.bat (newly-generated) uses the new flag + path
  - No behavior change for users; existing installs continue to work via the alias + dual-write

## [0.1.25-beta.38] - 2026-05-22

### Changed

- **Diagnostic logging cut — no behavior change beyond extra log lines.** Beta.36's §33 fix landed but the user-visible service-uninstall failure shapes were unchanged in VM smoke (Bug A non-deterministic pre-reboot fail and Bug B deterministic post-restart fail). Only the side-effect (every-10s tray-supervisor spawn churn) was resolved. Beta.38 adds targeted logging to pinpoint where the actual handoff flow is breaking — no speculative code fixes, just observability.
  - **`launcher/src/log.rs` → `common/src/log.rs` promotion.** The file logger module moved from launcher-private into the shared `common` crate so the `tray` crate + `common::control_marker::poll_once` can write to disk. `launcher/src/log.rs` is now a thin `pub use common::log::*;` shim — all existing `crate::log::info(...)` call sites in the launcher continue working unchanged. New `common::log::init(name: &str)` lets each binary set its own log file basename via `OnceLock<String>`; default is `"launcher"` for backward compatibility.
  - **`tray/src/main.rs`** — calls `common::log::init("tray")` at process entry. `<dataRoot>/logs/tray.log` is now populated. Pre-§33-beta.38 the tray's `eprintln!` calls vanished into NUL (release builds run `windows_subsystem = "windows"` — no stderr destination). Added startup state log line capturing pid + cwd + argv + resolved `config_dir`, plus `is_service_mode_at_start` + `show_launcher_balloon` log line for the mode determination. Existing `eprintln!` sites for single-instance-acquire failure + HKCU\Run cleanup error + no-active-session-resolvable now use `common::log::{info,error}`.
  - **`common/src/control_marker.rs::poll_once`** — every non-Idle `PollOutcome` is now logged: `WrongSession` (with `target` vs `own_session`), `Spawned` (with launcher path + args + verb), `SpawnFailed` (with error). `Idle` deliberately not logged (750ms cadence = spam). Lets us distinguish "tray never saw the marker" from "tray saw marker but spawn failed" from "tray spawned launcher but launcher never bound a port."
  - **`launcher/src/elevated_runner.rs::uninstall_service`** — step-by-step logging for the elevated uninstall sequence: `servy-cli stop` invocation + result, `servy-cli uninstall` invocation + result, `unregister_tray_run_key` result, `taskkill` result. Critical for the "ONE servy-cli window then Failed to fetch" symptom — pre-fix, the `stop` result was discarded silently and intermediate steps had no log entries, so we couldn't tell where execution actually stopped.
  - **`src/server/service/discoverServicePort.ts`** — per-iteration progress log (throttled to every 4 iterations on the 250ms cadence). Captures elapsed time + iteration count + port range scanned + match-or-not. Lets us tell "discover never started" from "discover ran the full 30s, scanned 100 ports per iteration, found nothing."
  - **`src/server/api/ServiceApi.ts::handoffUninstallToUserSession`** — 5-second heartbeat log during the `discover()` wait. Marker-write log line extended with the marker file path + tray-poll-cadence hint. Success path log line gained elapsed-time metric.

### Diagnostic capture target

- New file: `<dataRoot>/logs/tray.log` (populated by the tray helper)
- Existing files gain new entries: `<dataRoot>/logs/launcher.log` (control_marker + elevated_runner) and `<dataRoot>/logs/ws-scrcpy-web.log` (handoff heartbeat + discover iterations)
- VM smoke: install beta.38, reproduce the failing uninstall flow (pre-reboot non-deterministic OR post-reboot+idle deterministic), grab all four log files

### Verification

`cargo check --workspace` clean. `cargo test --workspace` clean. `tsc --noEmit` clean. `vitest run` — 695/695 across 61 files unchanged (no test changes; pure observation adds).

## [0.1.25-beta.37] - 2026-05-22

## [0.1.25-beta.36] - 2026-05-22

### Changed

- **Service-mode tray balloon title + body corrected.** The service-mode launcher-spawn balloon previously read `title: "ws-scrcpy-web tray"` / `body: "tray started by launcher. to clear the tray, stop the ws-scrcpy-web service via Settings."` — but Settings only exposes uninstall, not stop, so the body directed users to a UI action that doesn't exist. The tray menu's own exit option is the only intended exit path in both modes.
  - **`tray/src/main.rs`** — tuple grew from 4 to 5 elements to carry a mode-aware `balloon_title` (service: `"ws-scrcpy-web (service) tray"` mirroring the tooltip suffix; local: `"ws-scrcpy-web tray"` unchanged). Service-mode body now matches local-mode body verbatim: `"tray started by launcher. to clear the tray, use the exit option from the tray menu."`. Body literal duplicated across both branches intentionally (preserves if/else symmetry; can diverge later if needed). The "tray menu is the only exit" comment moved from inside the local-mode branch to above the if/else, since the rationale now applies to both modes.
  - **`launcher/src/tray_supervisor.rs`** — user-killed-tray comment block rewritten: dropped the verbatim quote of the old body and the "intrinsic to service-mode" framing, replaced with a mode-neutral description of the respawn-on-death contract + the actual Settings-can-uninstall-but-not-stop reality.

- **Welcome modal "change later" hint made specific.** Below the "run as a service?" yes/no buttons, the hint previously read `"you can change this later in settings."` — `"this"` was ambiguous (port? service decision? scope?). Now reads `"you can install/uninstall the service later in settings."`, which names the actual reversible decision and matches the Settings UI vocabulary. The port-config hint at the top of the modal (line 81) is unchanged.

### Fixed

- **Service uninstall — two distinct bugs, single bundled fix (§33 Bug A + Bug B).** Diagnosed via Hyper-V VM beta.34 smoke 2026-05-22. Both bugs surfaced as "uninstall failed - failed to fetch" but via different mechanisms; same fix consolidates the underlying session-resolution architecture.
  - **Bug A (5s-poll race vs handoff polling thread, NEW in beta.34 / PR #82 Part 5i).** The 5s-poll mode-detection thread in `tray/src/main.rs` called `std::process::exit(0)` on `installMode` change — kills ALL threads in the tray process instantly, including the Theory D handoff polling thread mid-uninstall. `ServiceApi.handleUninstall` flips `installMode` after the elevated `servy-cli uninstall` succeeds but before `result.client.status()` completes its response back to the browser; if the 5s-poll observed the change in that window, the tray died and the response never reached the browser. Non-deterministic; produced "BOTH servy-cli windows fire + Failed to fetch" symptom.
  - **Bug B (`WTSGetActiveConsoleSessionId` session-ID inconsistency, pre-existing).** Two Win32 APIs answer "which session is the user in?" — `WTSGetActiveConsoleSessionId()` returns the *physical console* session ID (unstable on VM / RDP / Hyper-V Enhanced Session / idle), while `WTSEnumerateSessionsW` filtering for `WTSActive` + non-empty username returns the actual interactive session. Pre-fix, the Node-side `--print-active-session` handler in `launcher/src/main.rs:39` AND the tray's `own_session` check in `tray/src/main.rs` both used the former; the launcher's spawn-dispatch in `user_session_spawn.rs` used the latter. Result: Node wrote `targetSessionId=N` into the uninstall handoff marker; tray-spawned-via-WTS-cross-session read a different N from the same API and silently skipped the marker every 750ms for 30 seconds. Server timed out, "Failed to fetch." Deterministic post-restart and post-idle; produced "NO servy-cli windows + Failed to fetch" symptom.
  - **Fix:** new `common/src/session.rs::active_interactive_session()` exposes the canonical `WTSEnumerateSessionsW`-based resolver (with `WTSGetActiveConsoleSessionId` fallback only when enumeration finds nothing). All callers consolidated:
    - `launcher/src/main.rs` `--print-active-session` handler swaps from `WTSGetActiveConsoleSessionId` to the canonical resolver. Empty stdout when no session resolvable — Node-side `active-session.ts` treats non-numeric as ok:false → marker written without session filter ("accepts any tray") as graceful fallback.
    - `launcher/src/user_session_spawn.rs::find_active_user_session_id` deleted; `spawn_in_active_user_session` calls the canonical resolver directly.
    - `launcher/src/tray_supervisor.rs::find_active_user_session` deleted (also was the same enumeration logic, explicitly noted as a duplicate in its doc comment); `ensure_tray_in_active_session` calls the canonical resolver directly.
    - `tray/src/main.rs` Theory D poller setup swaps from `WTSGetActiveConsoleSessionId` to the canonical resolver; on `None` (no interactive session resolvable), logs + skips the poller.
    - `launcher/src/tray_supervisor.rs` Bug A fix: mode-change detection moved from inside `tray.exe` (5s-poll thread, removed) to the supervisor poll loop (10s cadence). Persisted spawn-time mode at `<dataRoot>/control/tray-mode.txt`; supervisor reads on each cycle, compares to current `config.json::installMode`, on mismatch `taskkill` the stale tray so the next cycle's `ensure_tray` spawns fresh with mode-aware text. `start_background` signature gained a `data_root` parameter; `supervisor.rs` call site updated.
  - **Side-effect fix:** the every-10s tray-spawn churn observed in beta.34 logs (visible as repeated `tray-supervisor: spawned tray` entries with successive PIDs, all silently dedup'd by the per-session mutex inside `ws-scrcpy-web-tray.exe`) was caused by the same broken API root cause. `is_tray_running_in_session` lookup is unchanged (uses `WTSEnumerateProcessesExW`, correct), but the session ID it was passed previously came from `find_active_user_session()` which had the same fallback-to-broken-API as the deleted duplicates. Now that all session-ID resolution flows through `common::session`, the false-negative is gone — supervisor logs `AlreadyRunning` after the first spawn instead of repeating the spawn cycle.
  - **Won't auto-write the broader memory yet:** per user direction 2026-05-22, `reference_user_service_install_routine.md` (scope expanded from a narrow `lessons_wtsgetactiveconsolesessionid_footgun.md`) is DEFERRED until post-merge smoke confirms the install/uninstall routine is seamless. Forward-looking design pattern for all future apps offering user/system service options. See todo §33 for the full diagnostic trace.
  - **Verification:** `cargo check --workspace` clean. `cargo clippy --workspace --all-targets -- -D warnings` clean. `vitest run` — 695/695 across 61 files unchanged (no frontend changes; pure Rust refactor).

## [0.1.25-beta.35] - 2026-05-21

## [0.1.25-beta.34] - 2026-05-21

### Fixed

- **Tray text now updates when installMode changes mid-session (§32 Part 5i).** Surfaced by beta.32 smoke 2026-05-21: opting into service mode from a fresh local-mode install left the tray text + balloon copy stuck at the local-mode values ("ws-scrcpy-web" / "Stop the server and quit?") even though the launcher and config.json had transitioned to service mode. Root cause was Part 5h reading `installMode` ONCE at `tray/src/main.rs` startup and baking the text into the static `common::tray::run` call. The URL provider was already mode-tracking (re-reads `config.json` per click), but tooltip + exit prompt + balloon text were frozen at spawn-time.
  - **`tray/src/main.rs`** — new 5s-poll thread watches `config.json::installMode` for changes from the spawn-time value. On change, `std::process::exit(0)`; the launcher's tray-supervisor respawns within ~10s with mode-aware text picked up from the (now-current) config. Decision intentionally co-located with the tray process so the supervisor stays stateless.
  - Brief icon-flicker on mode change (tray exits, supervisor respawns ~10s later) — same UX as the validated "kill tray.exe → 10s respawn" path from §32 Part 5h smoke.

- **Local-mode tray balloon: dropped misleading "or Settings" clause.** Pre-2026-05-21 the local-mode launcher-spawn balloon read `"tray started by launcher. to clear the tray, stop the ws-scrcpy-web server via the tray exit or Settings."` — but local-mode Settings has no "stop server" affordance (only the service install/uninstall buttons). The tray menu's own exit option is the only intended path. Balloon now reads `"tray started by launcher. to clear the tray, use the exit option from the tray menu."`. Service-mode balloon unchanged (Settings DOES expose service stop there).

### Known open issue (logging needed)

- **Service uninstall fails after service-mode goes offline and back up** (reboot, in-app upgrade, any restart that recycles the service process). Pre-restart: 4-for-4 install/uninstall cycles succeed. Post-restart: uninstall fails, service stuck stopped-but-installed, tray doesn't respawn. Manual recovery via launching app → Settings → "stopped — uninstall?" works. Likely difference: tray.exe spawned via WTS cross-session post-restart vs Command::new same-session pre-restart — handoff polling thread / marker access / session token may differ. Triage pending logs from a failing flow.

Vitest 695/695 unchanged. `tsc --noEmit` clean. `cargo check --workspace` clean.

## [0.1.25-beta.33] - 2026-05-21

## [0.1.25-beta.32] - 2026-05-21

### Changed

- **Tray architecture unified across local + service modes (§32 Part 5h).** Pre-Part-5h the tray ran differently per mode: service mode used a standalone `ws-scrcpy-web-tray.exe` process supervised by the launcher's `tray_supervisor.rs` poller (every 10s, cross-session WTS spawn from LocalSystem into the active user session); local mode used an in-process thread inside the launcher (`tray.rs::spawn`). The in-process thread had two failure modes with no recovery: (a) after a service install→uninstall handoff the new local launcher fires with `--local-takeover`, spawns its own tray thread, but a competing standalone tray.exe is still in the process of exiting → mutex/icon-registration collision, in-process thread silently dies, no recovery path; (b) double-clicking the desktop shortcut after the launcher exits and restarts can hit Windows Shell timing such that the tray icon never registers → no recovery. User-reported on beta.31 smoke 2026-05-21.
  - **Local mode now uses the same standalone `ws-scrcpy-web-tray.exe` process as service mode**, supervised by the same `tray_supervisor::start_background` poller. Mode-aware spawn dispatch inside the supervisor: service mode keeps the WTS cross-session spawn (`spawn_in_active_user_session`); local mode uses a simple `Command::new(tray).arg("--launcher-spawn").spawn()` with `DETACHED_PROCESS | CREATE_NO_WINDOW` + null stdio (launcher already in the user session, no privilege elevation needed).
  - **`launcher/src/tray_supervisor.rs`** — `start_background(install_root, is_service_mode)` gained the mode parameter. New `ensure_tray_in_current_session` does the local-mode simple-spawn path. New `current_session_id()` resolves THIS process's WTS session via `ProcessIdToSessionId(GetCurrentProcessId())` for the local-mode "is tray already running in MY session?" check.
  - **`launcher/src/supervisor.rs`** — dropped the `if cfg.is_service_mode()` gate on the tray-supervisor block; runs in both modes now. The `--local-takeover` override (previously in `main.rs`) moved here so the tray-supervisor mode decision sees it at the right scope.
  - **`launcher/src/main.rs`** — removed `mod tray;`, removed `let _tray_handle = tray::spawn(is_service_mode);` and the now-unused `is_service_mode` computation. Tray spawn is entirely owned by the supervisor.
  - **`launcher/src/tray.rs`** — **deleted**. In-process thread tray retired.
  - **`tray/src/main.rs`** — tooltip + exit-confirmation copy is now mode-aware. Service mode: `"ws-scrcpy-web (service)"` / `"Stop the service and quit?"`. Local mode: `"ws-scrcpy-web"` / `"Stop the server and quit?"`. Balloon text adjusted similarly. Mode read from `config.json::installMode` at startup; URL provider re-reads on every click so the tray naturally tracks mode swaps mid-session.

- **Welcome modal: dropped the auto-shift port verbosity.** Pre-2026-05-21 the welcome modal showed `default port 8000 was in use; we auto-picked 8002. change anytime in settings.` in the auto-shifted branch — duplicating the URL already shown in the intro line above. Both branches (auto-shifted and not) now render the same brief `you can change the port anytime in settings.` hint. `src/app/client/WelcomeModal.ts:73-85`.

Vitest 695/695 unchanged (no test count delta). `tsc --noEmit` clean. `cargo check --workspace` clean (cross-compile validated in CI).

## [0.1.25-beta.31] - 2026-05-21

## [0.1.25-beta.30] - 2026-05-21

### Fixed

- **Settings → Install Service / Uninstall Service now works.** Pre-existing bug across many recent versions, surfaced by user-report 2026-05-21 while regression-testing §32 Part 5f: clicking "install service" in the Settings modal opened the "Administrative Privileges Required" confirmation dialog UNDERNEATH the Settings modal (couldn't reach without closing Settings), and clicking Continue did nothing. The Welcome modal's install path was unaffected because it bypasses `AdminConfirmModal` and calls `/api/service/install` directly.
  - **Root cause:** `src/app/client/AdminConfirmModal.ts::confirm()` was calling `document.body.appendChild(dialog)` + `dialog.showModal()` **after** `new AdminConfirmModal(...)` — but the `Modal` base-class constructor (`src/app/ui/Modal.ts:84-85`) already appends + showModals during construction. The second `showModal()` on an already-`open` dialog throws `InvalidStateError` per HTML spec. That throw inside the Promise executor rejected the returned Promise; the user-visible dialog (rendered by the FIRST `showModal()`) appeared but Continue/Cancel handlers' `resolveAndClose()` called `resolve()` on an already-rejected Promise → no-op. Layering glitch was a side effect of the throw perturbing top-layer state.
  - **Fix:** removed the redundant `appendChild` + `showModal` from `confirm()`. The base-class constructor handles both.
  - **Why tests didn't catch it:** `src/app/client/__tests__/AdminConfirmModal.test.ts` stubbed `HTMLDialogElement.prototype.showModal` to just set the `open` attribute without throwing on double-call. Stub was too permissive vs the HTML spec. Updated the stub to throw `InvalidStateError` on already-`open` dialogs (spec-realistic) and added a regression test asserting `confirm()` calls `showModal` exactly once.

Vitest 694/694 → 695/695 (+1 regression test: `calls showModal exactly once (no double-show throw)`). `tsc --noEmit` clean.

## [0.1.25-beta.29] - 2026-05-21

## [0.1.25-beta.28] - 2026-05-21

### Added

- **Local-mode in-app upgrade: "updating, please wait…" page now appears during the upgrade window too.** §32 Part 5f — extends the Part 5e upgrade-server architecture to local mode (when `installMode` is `null`/`'user'`/`'system'`, i.e., no Servy supervision). Part 5e fixed the page for service mode by spawning the upgrade-server from Servy's `--postStopPath` bat; local mode had no equivalent and the browser saw "this site can't be reached" for the ~3-8s Velopack-restart window. Part 5f extends the same dataRoot-helper + wind-down mechanism to local mode by spawning the upgrade-server from the launcher's own supervisor on clean Node exit.
  - **`launcher/src/upgrade_server.rs`** — new `spawn_detached_helper(data_root)` function spawns `<dataRoot>/upgrade-server/ws-scrcpy-web-launcher.exe --upgrade-server` as a detached Windows process (DETACHED_PROCESS | CREATE_NO_WINDOW, stdio null'd). New `apply_update_pending_marker(data_root)` returns the canonical marker path so the supervisor and Node-side `Config.applyUpdatePendingMarkerPath` stay in sync.
  - **`launcher/src/supervisor.rs`** — on Node clean exit (`decide_restart` returns None), if `apply_update_pending_marker` exists AND we're in local mode, delete the marker (so subsequent restart doesn't re-spawn on a stale marker) then call `spawn_detached_helper` before returning. Velopack's `restart=true` then relaunches the launcher; the next supervisor invocation writes the stop marker (now unconditional, was service-mode-only) and the upgrade-server's wind-down + port-shift discovery hands off cleanly. Service mode is gated OUT of this spawn path — the post-stop bat handles that, and racing the two would create bind contention.
  - **`launcher/src/supervisor.rs`** — also drops the `is_service_mode()` gate on `refresh_helper_binary` at startup and on the upgrade-server stop-marker-write + `wait_for_port_free` block. Local mode launcher restart-on-apply needs all three to coordinate with the upgrade-server its previous incarnation spawned.
  - **`src/server/UpdateService.ts::applyUpdate`** — moves `writeApplyUpdatePendingMarker()` out of the `if (isServiceMode)` block. Marker is now written in BOTH modes; it's the discriminator both the launcher supervisor (local) and the post-stop bat (service) use to tell apply-update from user-initiated stop (Ctrl+C, services.msc Stop, etc.).
  - **`src/server/__tests__/UpdateService.test.ts`** — the existing Part 5e `applyUpdate (%s): does NOT spawn anything from Node` `it.each` (4 cases) now also asserts marker is written. Spy on `fs.promises.writeFile` + `mkdir` mocked as no-ops to avoid polluting real ProgramData. Renamed to `writes marker + does NOT spawn anything from Node (§32 Part 5f)`.

Vitest 694/694 unchanged (test counts net zero — same `it.each` 4 cases, just gained additional assertions). `tsc --noEmit` clean. `cargo check --workspace` clean locally (now that VS 2026 Community + C++ workload is installed; Rust auto-detected MSVC via registry probing).

## [0.1.25-beta.27] - 2026-05-21

## [0.1.25-beta.26] - 2026-05-21

### Fixed

- **Service-mode in-app upgrade: "updating, please wait…" page now actually appears in the browser during the upgrade window.** §32 Part 5e — caught by v0.1.25-beta.24 → beta.25 smoke 2026-05-21. The fix for §32 Part 5c (config.json port persistence) confirmed Bug A was solved, but the smoke also revealed Bug B was independent: the launcher's `--upgrade-server` correctly bound `0.0.0.0:8001` at `41.260`, logged ZERO `connection from …` lines, and logged no clean-exit message — Velopack's `Update.exe` terminated it within ~1s of bind because the process loaded `<installRoot>/current/ws-scrcpy-web-launcher.exe` as its image, and Velopack's apply phase needs to swap `current/`.
  - **Architecture change: upgrade-server is now spawned from Servy, not from Node.** Velopack only does the file swap; everything else is Servy's domain (matching the post-stop bat + dataRoot pattern already in use). The pre-exit spawn from `UpdateService.applyUpdate` (introduced in Part 5b to close a 180ms dead window) put the upgrade-server inside Velopack's process tree, where the swap killed it. Part 5e moves the spawn back into the post-stop bat (Servy invokes it `FireAndForget`; Servy does not wrap supervised processes in a Job Object — verified by reading the servy fork source) AND sources the spawn from a launcher copy outside `current/`.
  - **`launcher/src/upgrade_server.rs`** — new `refresh_helper_binary(data_root)` function copies the running launcher binary to `<dataRoot>/upgrade-server/ws-scrcpy-web-launcher.exe`. New `helper_path_for(data_root)` returns the same path without performing the copy. Single source of truth for the helper layout.
  - **`launcher/src/supervisor.rs`** — calls `refresh_helper_binary` on every supervisor startup in service mode, so the helper tracks the currently-installed launcher version. Best-effort; log + continue on failure.
  - **`launcher/src/elevated_runner.rs::write_post_stop_bat`** — restores the `start "" /b "<helper>" --upgrade-server` spawn line inside the apply-update-marker-gated block, pointing at the dataRoot helper path (resolved via `upgrade_server::helper_path_for` at install time). Bat sequence on apply-update path: del marker → `start "" /b <helper> --upgrade-server` (fire-and-forget, bat continues immediately) → `timeout /t 12` (Velopack's Update.exe finishes the swap in parallel) → `sc start`.
  - **`src/server/UpdateService.ts`** — removed `spawnUpgradeServer`, the `SpawnFn`/`SpawnedChild` type exports, the `spawnFn` injection point, and the spawn import. `applyUpdate` in service mode now writes the apply-update-pending marker and calls `waitExitThenApplyUpdate` and nothing else; the post-stop bat owns the upgrade-server lifecycle.
  - **`src/server/__tests__/UpdateService.test.ts`** — replaced two `it.each` blocks (service-mode-spawns, local-mode-doesnt-spawn) with one `it.each` block covering all four installModes asserting applyUpdate spawns nothing from Node. Other applyUpdate tests had no-op `spawnFn` injections dropped.
  - **Trade-off:** the ~25ms close of the dead window that Part 5b's pre-exit spawn provided is restored to ~200ms (launcher exit → Servy fires bat → bat spawns helper → helper binds). The upgrade-server now SURVIVES the entire upgrade window instead of dying after ~1s, so even if the browser misses the initial reconnect, any subsequent retry (browser auto-retry, manual refresh) hits the updating page. The wind-down + port-shift discovery mechanism (already in place since Part 5b) handles the handoff to the new Node.

### Surfaced for follow-up

- **`src/server/UpdateService.ts::preApplyHygiene`** uses `execFileAsync('taskkill', ['/F', '/IM', 'adb.exe', '/T'], ...)` — resolves `taskkill` via the system PATH. Per CLAUDE.md's Local-Dependencies-Only rule, this should be `C:\Windows\System32\taskkill.exe` (the same pattern the post-stop bat uses for `cmd.exe`). Pre-existing; flagging here rather than silently fixing.

Vitest 694/694 unchanged (-4 obsolete service/local spawn tests, +4 combined `it.each` no-spawn tests). `tsc --noEmit` clean. `cargo check` validated in CI (local `link.exe` broken on dev box, per the standing repo note).

## [0.1.25-beta.25] - 2026-05-20

## [0.1.25-beta.24] - 2026-05-20

### Fixed

- **Service-mode opt-in: local Node now syncs its in-memory `webPort` to the actual port the service-Node bound, so subsequent local-Node writes can't clobber `config.json` back to the pre-install port.** §32 Part 5c — caught by v0.1.25-beta.22 → beta.23 smoke 2026-05-21. The user's clean-VM smoke installed beta.22 in local mode (port 8000), opted into service mode, and confirmed the browser correctly redirected to the new service-Node port (8001 after the install-time port shift). Two regressions followed from the same root cause:
  - **Tray icon opened the wrong port.** After install, the tray re-read `config.json` on click (per `tray/src/main.rs:68-72` it does this every invocation) and got `webPort:8000`. Clicking opened `http://localhost:8000` — a dead address now that the service-Node was on 8001.
  - **In-app upgrade "updating, please wait…" page never appeared.** During the apply-update window, the launcher's `--upgrade-server` subcommand (spawned pre-exit by §32 Part 5b) read `config.json` for its bind port (`launcher/src/upgrade_server.rs:107-109`) and got `webPort:8000`. It happily bound 8000 — but the browser was on 8001, so the browser's WebSocket-reconnect attempt hit ECONNREFUSED on 8001 for the entire upgrade window and never landed on the launcher's static page. The 25ms retry-bind loop and wind-down port-shift discovery from Part 5b worked correctly; they just couldn't help when the upgrade-server was bound to the wrong port to begin with.
  - **Root cause: race write back to `config.json` from local Node's stale in-memory state.** During the ~5s window between `ServiceApi.handleInstall`'s redirect response and the scheduled `process.exit(0)`, local Node's `Config` singleton still had the pre-install `webPort:8000` in memory. Service-Node's `reconcileWebPort` had correctly written `webPort:8001` to disk, but any local-Node write during that window (browser-driven PATCH on a stale connection, periodic timer, etc.) used local Node's stale in-memory state and clobbered disk back to 8000.
  - **Fix: `src/server/api/ServiceApi.ts:handleInstall`** now calls `cfg.setActualWebPort(parsedPort)` immediately after `discoverServicePort` returns a non-null URL — parses the port from `new URL(found).port`, validates the integer range [1024, 65535], updates local Node's in-memory `webPort` and writes `config.json` atomically via the existing `setActualWebPort` path. Any subsequent local-Node write now carries the correct port. Parse failures (host-only URL, etc.) log + continue without aborting the install response.

Vitest 692/692 → 694/694 across 61 files (+2 from new `POST /install syncs local in-memory webPort to the service-Node port discovered on handoff (§32 Part 5c)` and `POST /install skips webPort sync when discovered URL has no parseable port` cases in `ServiceApi.test.ts`). `tsc --noEmit` clean.

## [0.1.25-beta.23] - 2026-05-20

## [0.1.25-beta.22] - 2026-05-20

### Fixed

- **Service-mode in-app upgrade: "updating, please wait…" page now actually appears in the browser during the upgrade window, and survives the port-shift case where the new Node lands on a different port than the upgrade-server held.** §32 Part 5b — caught by v0.1.25-beta.20 → beta.21 smoke 2026-05-20. Two intertwined fixes:
  - **Pre-exit spawn closes the dead window.** Part 5 (beta.20) wired the upgrade-server through the post-stop bat — spawn happened AFTER Node exited, leaving a ~180ms gap where the port was unbound. The smoke showed `upgrade-server: bound 0.0.0.0:8001` at 23:08:27.164, 180ms after Node exit at 23:08:26.984. Browser's WebSocket-reconnect attempt hit that gap, got TCP `ECONNREFUSED`, and showed "this site can't be reached" for the entire ~13s upgrade window without retrying. Now: **`src/server/UpdateService.ts:applyUpdate`** spawns `<installRoot>/current/ws-scrcpy-web-launcher.exe --upgrade-server` (detached, stdio:ignore, windowsHide, unref'd) BEFORE the Velopack `waitExitThenApplyUpdate` call. **`launcher/src/upgrade_server.rs`** replaces the single `TcpListener::bind` with a retry loop — tries every 25ms for up to 10s, succeeds within ~25ms of Node releasing the port. Browser falls straight onto the updating page.
  - **Post-stop bat dropped the upgrade-server spawn.** `launcher/src/elevated_runner.rs::write_post_stop_bat` no longer interpolates a `start "" /b "<launcher>" --upgrade-server` line — the pre-exit spawn from UpdateService is now the canonical mechanism. The bat retains the marker-gated `sc start` sequence (recovery of the service is still its job). Existing beta.20 installs keep their old bat for one upgrade cycle; the duplicate post-exit spawn loses the bind race to the pre-exit one and exits cleanly with log noise.
  - **Wind-down port-shift handling.** When upgrade-server detects the supervisor's stop marker, instead of immediately exiting it now enters a 15s wind-down phase. A background probe thread sweeps `localhost:config_port..config_port+10` every 100ms looking for the real Node's `/api/config` response (200 OK without the `X-WsScrcpyWeb-Upgrade-Server` sentinel header). When found, the redirect URL (`http://localhost:<new-port>/`) is published to shared state; subsequent `/api/config` requests from the page poll return 200 + `{"redirect":"<url>"}` (still with sentinel to distinguish from real Node) and the page navigates. Handles the case where Node loses the port race with upgrade-server (because Node's bind fires past supervisor's `wait_for_port_free` timeout) and auto-shifts to e.g. `config_port+1` — without this, the user would stay stuck on the updating page served at the old port while the real app is on a different port.
  - **`launcher/assets/upgrade-server-page.html`** inline JS extended: on `/api/config` 200-with-sentinel responses, parses the body for a `redirect` field and navigates if present. Existing "200 without sentinel → reload" path unchanged.

Vitest 688/688 → 692/692 across 61 files (+4 from new `applyUpdate (user-service|system-service): spawns launcher --upgrade-server pre-exit` and `applyUpdate (user|system): does NOT spawn upgrade-server (local mode)` `it.each` blocks; existing service-mode applyUpdate tests gained a no-op `spawnFn` injection to avoid surfacing real spawn against the fake install root). `tsc --noEmit` clean. cargo check on launcher: validated in CI (local `link.exe` broken on dev box, per the standing repo note).

## [0.1.25-beta.21] - 2026-05-20

## [0.1.25-beta.20] - 2026-05-20

### Changed

- **Tray lifecycle moved to launcher-owned polling.** §32 Part 5 — caught by v0.1.25-beta.18 → beta.19 smoke. Replaces the previous architecture (HKLM\Run auto-start at user logon + post-stop bat respawn flag) with a single owner: the launcher's new `tray_supervisor` background thread polls every 10 seconds, locates the active interactive user session via `WTSEnumerateSessionsW`, checks for `ws-scrcpy-web-tray.exe` in that session via `WTSEnumerateProcessesExW`, and spawns it via `user_session_spawn` if missing. The tray's per-session single-instance mutex handles dedup safely. Spawning passes `--launcher-spawn` argv, which signals the tray to surface a balloon notification on start: **"ws-scrcpy-web tray — tray started by launcher. to clear the tray, stop the ws-scrcpy-web service via Settings."** Sets correct expectation that the tray is intrinsic to service-mode operation.
  - **`launcher/src/elevated_runner.rs::install_service`** no longer registers `HKLM\Software\Microsoft\Windows\CurrentVersion\Run\WsScrcpyWebTray`. On (re)install, it now also deletes any existing entry from beta.18-and-earlier installs.
  - **`launcher/src/supervisor.rs`** drops `try_respawn_tray_after_upgrade` (the Part 4 flag-based mechanism). Replaced by `tray_supervisor::start_background()` which handles post-upgrade, post-logon, and user-killed cases uniformly.
  - **Post-stop bat** drops the `respawn-tray-after-upgrade` flag write — no longer needed.
  - **`common/src/tray.rs::run`** gains a `startup_balloon: Option<(&str, &str)>` parameter that, when Some, fires a `Shell_NotifyIconW(NIM_MODIFY, NIF_INFO)` balloon notification right after the tray icon registration. Reused for the launcher-spawn explanation; could be reused for future contexts.
  - **`tray/src/main.rs`** parses `--launcher-spawn` argv, conditionally passes the balloon to `common::tray::run`.

- **In-app upgrade now serves a static "updating, please wait..." page on the same port during the upgrade window.** §32 Part 5 — replaces the in-browser `ServerReachabilityOverlay` approach which couldn't survive browser auto-navigation on graceful socket close.
  - **New `launcher/src/upgrade_server.rs`** + new `launcher/assets/upgrade-server-page.html`. Subcommand `<launcher> --upgrade-server` reads `<dataRoot>/config.json` for the web port, binds it, serves the embedded HTML on root + 503 JSON on `/api/*` paths (sentinel header `X-WsScrcpyWeb-Upgrade-Server: 1`). Self-exits on `<dataRoot>/control/upgrade-server-stop` marker or 30s safety cap.
  - **Post-stop bat** spawns `<launcher> --upgrade-server` via `start "" /b` BEFORE `timeout` + `sc start`, so the port stays covered the entire upgrade window.
  - **`launcher/src/supervisor.rs`** writes the stop marker + waits for the port to free (`wait_for_port_free`, 5s timeout) before spawning Node, so the new Node binds cleanly without racing the upgrade-server.
  - **Static page** has inline JS that polls `/api/config` every 1s and checks for absence of the sentinel header to detect "real app is back" → reloads the page. Survives refreshes, new tabs, fresh visits during the upgrade window — anything that hits the URL is served the updating page until the real Node binds the port.
  - **Dropped: `src/app/client/ServerReachabilityOverlay.ts` + `src/style/server-reachability.css`** + the registration call from `src/app/index.ts`. The launcher upgrade-server is the canonical mechanism going forward; no browser-side machinery needed.

Vitest 688/688 unchanged (no test count delta; new code is launcher Rust + cross-process behaviors not in unit-test coverage). tsc --noEmit clean.

## [0.1.25-beta.19] - 2026-05-20

## [0.1.25-beta.18] - 2026-05-20

### Added

- **Standalone tray helper now respawns automatically after an in-app upgrade.** Previously, Velopack's swap of `current/` killed the running `ws-scrcpy-web-tray.exe` (file lock on `current/ws-scrcpy-web-tray.exe`) and the tray didn't come back until the user's next logon (HKLM\Run auto-start). Now: the post-stop bat writes `<dataRoot>/control/respawn-tray-after-upgrade` before `sc start`; the newly-spawned supervised launcher reads the flag in `supervisor::run` and uses the existing `user_session_spawn::spawn_in_active_user_session` machinery (the same WTSEnumerateSessions + WTSQueryUserToken + CreateProcessAsUserW dance from the v0.1.8 uninstall handoff) to land a fresh tray exe in the active interactive user's session. Best-effort: if no active user session is found (headless boot before any logon), the flag is left in place so a future launcher restart can retry. If spawn succeeds, the flag is deleted.
- **Browser-side server-reachability overlay during in-app upgrades.** Replaces the OS-level "this site can't be reached" page with a branded "ws-scrcpy-web is updating — reconnecting…" overlay. Polls `/api/config` every 5s normally, every 2s when in recovery mode. Overlay appears after 2 consecutive failures (avoids false positives from network jitter). On recovery, reloads the page so the UI re-evaluates against post-restart state. Lives in `src/app/client/ServerReachabilityOverlay.ts` + `src/style/server-reachability.css`. Bootstrapped from `index.ts` at the end of `window.onload`.

## [0.1.25-beta.17] - 2026-05-20

## [0.1.25-beta.16] - 2026-05-20

### Fixed

- **Service-mode in-app upgrade: post-stop handler relocated from launcher binary (in `current/`) to a bat file in `<dataRoot>/post-stop/`, invoked via `cmd.exe`.** §32 Part 4 — caught by v0.1.25-beta.15 smoke 2026-05-20. Part 3 used `current/ws-scrcpy-web-launcher.exe --post-stop-handler` as the post-stop process, but that binary lives in Velopack's swap zone. When Velopack swapped `current/` during the upgrade window, the running post-stop process was stranded mid-sleep (launcher.log showed `sleeping 12s` at 19:28:32 but no follow-up log lines — confirmed killed/stranded). The recovery never fired, the service stayed Stopped until reboot.
  - **`launcher/src/elevated_runner.rs::install_service`** now writes `<dataRoot>/post-stop/post-stop.bat` at install time with the marker path + service name interpolated. The bat does: `timeout 12 → if exist marker (del marker + sc start) → exit`. Servy registration uses `--postStopPath=C:\Windows\System32\cmd.exe` and `--postStopParams=/c "<bat path>"`. **cmd.exe is at the fixed Windows OS location (never moves), bat file is in `<dataRoot>` (Velopack-untouchable).** Verified `sc qc WsScrcpyWeb` on a beta.14 install — Servy itself is registered at `C:\ProgramData\Servy\Servy.Service.CLI.exe` which is also Velopack-untouchable, so the whole recovery chain runs entirely outside `current/`.
  - **`launcher/src/hooks.rs::on_updated`** now checks for the post-stop bat file. If present → no-op (Servy will fire the bat via --postStopPath). If absent → fire the legacy synchronous `servy-cli restart` bridge as fallback (for upgrades from beta.9-era installs that predate post-stop wiring; same one-time-bumpy behavior we already accepted for the beta.9 → beta.12 bridge). This eliminates the race we observed in beta.15 smoke where the synchronous bridge fired CONCURRENTLY with the post-stop handler, racing each other to nothing.
  - **`launcher/src/post_stop_handler.rs` deleted.** No longer needed — the bat file owns the post-stop logic entirely. Module unregistered from `launcher/src/main.rs` dispatch chain.
  - **`launcher/src/elevated_runner.rs::InstallServiceArgs`** adds `data_root: Option<String>` field. Node side (ServiceApi → ServyClient → elevatedRunner) threads `Config.getInstance().dataRoot` through. Optional with `#[serde(default)]` for backward compatibility — legacy callers without dataRoot just skip post-stop wiring and rely on the bridge.
  - **`src/server/service/ServiceClient.ts::ServiceInstallOptions`** + `src/server/service/elevatedRunner.ts::InstallServiceArgs` mirror the Rust-side `data_root` field as `dataRoot?: string | undefined` (exactOptionalPropertyTypes compatible).
  - **Servy's existing `C:\ProgramData\Servy\` install** verified via `sc qc WsScrcpyWeb` on the beta.14 smoke — `BINARY_PATH_NAME` is `"C:\ProgramData\Servy\Servy.Service.CLI.exe" "WsScrcpyWeb"`, confirming Servy's wrapper lives outside `current/`. The Part 4 architecture leverages this stable location: Servy fires `--postStopPath` (cmd.exe) which runs the bat (in dataRoot) which calls `sc.exe start`. Zero touch on `current/` during recovery.
  - Vitest 688/688 unchanged (no test-count delta; Node-side changes are pass-through threading; the new behavior is exercised at install-service time and not in unit-test coverage). cargo check / cargo test on launcher: validated in CI. tsc --noEmit clean (Node side).

## [0.1.25-beta.15] - 2026-05-20

## [0.1.25-beta.14] - 2026-05-20

### Fixed

- **`servy-cli install` no longer fails with `Option 'post-stop-handler' is unknown` on fresh installs.** §32 Part 3 (in beta.12) added `--postStopParams` followed by `--post-stop-handler` as two separate argv tokens, but Servy's CommandLineParser interprets the leading `--` as a new flag declaration rather than the value for `--postStopParams`. Fresh installs of beta.12 / beta.13 failed at the "Install service" step with `servy-cli install exited with code Some(1)`. The fix uses the `--flag=value` equals form (`--postStopParams=--post-stop-handler`) which keeps the value bound to its flag through the parser. Validated locally with the bundled servy-cli.exe before shipping. **This is the first beta where fresh installs can register the service correctly with the post-stop handler wired** — proper Part 3 smoke validation requires beta.14 (or later) installed FRESH on a clean VM, then upgrading to beta.15+ (or any later version).

## [0.1.25-beta.13] - 2026-05-20

### Notes

- **No code changes vs v0.1.25-beta.12.** This release exists solely as the destination version for the proper §32 Part 3 smoke validation. The beta.9 → beta.12 bridge smoke (2026-05-19 LATE+++) confirmed that the bridge upgrade still requires a reboot — expected migration cost, because beta.9's Servy install lacks `--postStopPath` so beta.12's `--veloapp-updated` hook falls back to the synchronous `servy-cli restart` path (same race that beta.10 hit). beta.13's purpose is the FOLLOW-UP smoke: install v0.1.25-beta.12 MSI first (Servy is now installed WITH `--postStopPath` argument wired), then upgrade to v0.1.25-beta.13. Expected behavior: launcher exits clean post-Velopack-swap → Servy's post-stop handler fires (in Servy's process tree, outside Velopack) → handler sees the apply-update-pending marker → sleeps 12s → `sc.exe start WsScrcpyWeb` → service comes back in <15s, no reboot required, no SCM RestartProcess RecoveryAction involvement.

## [0.1.25-beta.12] - 2026-05-19

### Fixed

- **Service-mode in-app upgrade: replaced the Part 2 hook-side detached spawn (beta.11) with a Servy-native `--postStopPath` post-stop handler.** §32 Part 3 — caught by v0.1.25-beta.9 → v0.1.25-beta.11 manual VM smoke. The deferred-spawn helper from Part 2 was killed by Velopack's Job Object cleanup during its 8-second sleep (launcher.log showed "sleeping 8000ms" but never "invoking servy-cli restart" — confirming kill mid-sleep). And worse than Part 1's behavior, the clean-exit + dead-helper combo meant SCM's `RestartProcess` RecoveryAction never fired (clean exits don't trigger recovery), so the service stayed Stopped indefinitely until reboot. Part 3 routes around the entire process-tree problem by using **Servy's `--postStopPath` mechanism**: a fire-and-forget executable that Servy itself spawns after the supervised process and all its children have exited. The post-stop process is in Servy's process tree (descended from SCM), completely independent of Velopack's Update.exe — no Job Object cleanup can touch it.
  - **New module `launcher/src/post_stop_handler.rs`** (~80 lines + 6 unit tests). Handles the `--post-stop-handler` subcommand. Reads the apply-update-pending marker at `<dataRoot>/control/apply-update-pending`. If absent → user-initiated stop (sc stop, services.msc), exit 0 immediately (do NOT restart). If present → delete the marker, sleep 12s (let Update.exe finish), invoke `sc.exe start WsScrcpyWeb`. Exit 0 on success, 3 on sc.exe spawn failure, 4 on non-zero sc.exe exit. Marker-presence check is the user-vs-Velopack discriminator: ONLY in-app updater writes the marker, so user-initiated stops correctly stay stopped.
  - **Wired into `launcher/src/main.rs`** dispatch chain — registered before `elevated_runner::handle`. Module added to mod list; old `deferred_servy_restart` module removed.
  - **`launcher/src/elevated_runner.rs:install_service` adds 3 args** to the `servy-cli install` invocation: `--postStopPath <launcher-bin-path>`, `--postStopParams "--post-stop-handler"`, `--postStopStartupDir <startup-dir>`. Servy fires the launcher with the `--post-stop-handler` flag every time the supervised launcher exits.
  - **`src/server/UpdateService.ts:applyUpdate` writes the marker** before triggering `process.exit(0)` via Velopack's `waitExitThenApplyUpdate(restart=false)`. Only writes the marker in service mode — local-mode upgrades are unchanged. Write failure is logged + tolerated (worst case: post-stop handler sees no marker → service doesn't auto-restart → user manually starts it from services.msc).
  - **`src/server/Config.ts` adds `applyUpdatePendingMarkerPath` getter** as single source of truth for the marker path on the Node side. Matches `launcher/src/post_stop_handler.rs::marker_path` constant.
  - **`launcher/src/hooks.rs:on_updated` reverted to synchronous `run_servy("restart")`** as the migration bridge. The beta.9 → beta.12 upgrade specifically can't use the post-stop path (beta.9's Servy install doesn't have the `--postStopPath` argument). The synchronous restart triggers SCM's `RestartProcess` RecoveryAction after Velopack kills the first launcher attempt — same one-time-bumpy behavior as beta.10. Upgrades FROM beta.12 onward (when Servy was installed with the `--postStopPath` config) use the clean post-stop path.
  - **`launcher/src/deferred_servy_restart.rs` deleted** — superseded by the post-stop handler architecture; would have been dead code otherwise.
  - **Note:** This is the third architecture attempt for §32. Prior attempts were SOURCE-side fixes (in `applyUpdate` and the `--veloapp-updated` hook) that all lived inside Velopack's process tree. Part 3 moves the recovery mechanism OUTSIDE Velopack's process tree entirely, via Servy → SCM. The bridge upgrade (beta.9 → beta.12) accepts a one-time ~60s recovery window via SCM RestartProcess; future beta.12 → beta.N+ upgrades should restart cleanly within ~12 seconds without any SCM recovery involvement.
  - Vitest 688/688 (no test count change; new `Config.applyUpdatePendingMarkerPath` getter + UpdateService marker-write code are best-effort, surface tested via the existing applyUpdate test suite). New `post_stop_handler` Rust module has 6 unit tests covering argv parsing + marker-path stability. `tsc --noEmit` clean. cargo check / cargo test on launcher: validated in CI (local link.exe broken on dev box).

## [0.1.25-beta.11] - 2026-05-19

### Fixed

- **Service-mode in-app upgrade: `--veloapp-updated` hook no longer synchronously calls `servy-cli restart` — instead spawns a detached `--deferred-servy-restart` subcommand that sleeps 8 seconds before invoking servy.** §32 follow-up fix caught by v0.1.25-beta.9 → v0.1.25-beta.10 manual VM smoke. The previous synchronous-hook design had Servy spawn the new SERVICE LAUNCHER while Update.exe was still alive (Update.exe is the parent of the hook process — it waits for the hook to exit before completing its own cleanup + exit). Update.exe's open file handles on `<installRoot>\current\` killed the new Node child via file-sharing-violation before it could reach even the first Logger init line (`[Config] adbPath=...` was missing from `server.log` for the Servy-spawned Node — confirming the kill happened sub-second after spawn). Servy then waited ~60 seconds for its `--recoveryDelay` to time out, then restarted the launcher — by which point Update.exe was gone and Node could initialize cleanly. Net effect: ~75-second window where the service appeared Stopped + app was unreachable, even though Servy/SCM eventually recovered without a reboot.
  - **New module `launcher/src/deferred_servy_restart.rs`** (~110 lines + 6 unit tests). Implements the `--deferred-servy-restart <delay-ms> <service-name>` subcommand. Parses argv, sleeps for the requested duration, then invokes `<installRoot>/current/servy-cli.exe restart --name <service-name>`. Exit codes: **0** success, **2** malformed argv (missing/non-numeric delay, missing service name), **3** servy-cli.exe absent on disk, **4** servy-cli invocation failed.
  - **Wired into `launcher/src/main.rs`** at the dispatch chain immediately after `unzip_handler::handle` and before `elevated_runner::handle`. The four subcommands (`--request-uac`, `--unzip`, `--deferred-servy-restart`, `--elevate-and-run`) are mutually exclusive (one positional flag each).
  - **`launcher/src/hooks.rs:on_updated` rewritten.** No longer calls `run_servy` synchronously. Instead: (a) checks `servy-cli.exe` presence (early-exit 0 if absent — preserves P2 fault tolerance); (b) spawns the launcher self-invocation with `--deferred-servy-restart 8000 WsScrcpyWeb` via `Command::new(current_exe())` with `stdin/stdout/stderr` redirected to null and `creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)` so the child fully detaches from the hook's process tree + console; (c) drops the child handle without `wait()`-ing so Update.exe sees the hook exit immediately; (d) returns 0. Falls back to synchronous `run_servy` if `current_exe()` resolution or the spawn fails (better than not restarting the service at all).
  - **8-second delay** picked as conservative buffer above observed Update.exe lifetime. v0.1.25-beta.10 smoke A.2 logs showed Update.exe still holding file handles on `current/` ~5 seconds into the hook window. 8s gives Update.exe time to exit + release handles, while keeping the user-visible "applying update" window short. Future tuning is trivial — the delay is a compile-time `const` in `hooks.rs`.
  - **The 6 deferred_servy_restart::tests** cover: flag-absent → None; empty argv → None; missing delay → exit 2; missing service name → exit 2; non-numeric delay → exit 2; flag at any position → dispatched (exits 3 or 4 under cargo test since servy-cli.exe isn't staged). Existing hooks.rs tests (`updated_noop_when_not_service_mode`, `updated_tolerates_absent_servy_in_service_mode`, etc.) unchanged — their assertions on return values still hold because the new code path returns 0 with the absent-servy short-circuit at the same place.
  - **Note:** like the §32 fix itself, this lives in the DESTINATION version's hook (the version being swapped to). So the v0.1.25-beta.9 → v0.1.25-beta.10 upgrade still has the regression (beta.10's hook is unchanged); the fix becomes load-bearing for **v0.1.25-beta.9 → v0.1.25-beta.11** (or any later target) upgrades. Vitest 688/688 (no Node code change). cargo check / cargo test on launcher: green in CI (local link.exe is broken).

## [0.1.25-beta.10] - 2026-05-19

### Notes

- **No code changes vs v0.1.25-beta.9.** This release exists solely as the destination half of the §32 service-mode upgrade smoke verification. The §32 fix (`UpdateService.applyUpdate` passes `restart=false` in service mode) lives in the SOURCE version's `applyUpdate` call, so verifying it requires upgrading FROM a fixed version (v0.1.25-beta.9, the first carrier of the fix) TO any later version. v0.1.25-beta.10 is that "any later version" — no functional delta, just a version bump (`package.json` + `Cargo.toml` + `Cargo.lock` + `CHANGELOG.md`) so the upgrade flow has somewhere to go. The load-bearing test: clean VM → install v0.1.25-beta.9 MSI → service mode → Settings → Apply update → confirm service stays RUNNING in `services.msc`, no ghost LocalSystem launcher process, no "stopped — uninstall?" affordance in Settings, app reachable on the same port, no reboot required.

## [0.1.25-beta.9] - 2026-05-19

### Fixed

- **Service-mode in-app upgrade no longer leaves SCM stuck in Stopped state with a parallel LocalSystem ghost launcher.** `src/server/UpdateService.ts:applyUpdate` now passes `restart=false` to Velopack's `waitExitThenApplyUpdate` when `installMode` is a service mode (`'user-service'` or `'system-service'`); local mode (`null`, `'user'`, `'system'`) continues to pass `restart=true`. The launcher's `--veloapp-updated` hook (`launcher/src/hooks.rs:312`) calls `servy-cli restart` which is the proper SCM-mediated restart path; letting Velopack ALSO relaunch spawns a parallel LocalSystem launcher that inherits the LocalSystem token from `Update.exe`'s parent chain, grabs the single-instance mutex, and starves out Servy's `--recoveryAction=RestartProcess` attempts — SCM ends up reporting the service as Stopped until reboot, even though HTTP is still being served by the ghost LocalSystem launcher. Caught by v0.1.25-beta.8 manual VM smoke A.2 (clean v0.1.24 stable → in-app upgrade to v0.1.25-beta.8). Self-heals on next boot because the Windows service is registered with `startupType=Automatic` and SCM starts a fresh Servy-supervised launcher then; the window of brokenness is between apply-complete and next reboot. **Note:** the fix lives in the SOURCE version's `applyUpdate()`, so the v0.1.24 → v0.1.25-beta.9 upgrade itself still has this regression (v0.1.24's pre-fix code makes the apply call); the fix becomes load-bearing starting with the v0.1.25-beta.9 → v0.1.25-beta.10+ upgrade path. Adds `it.each`-driven unit tests covering all four `InstallMode` variants (`'user-service'`/`'system-service'` → `restart=false`; `'user'`/`'system'` → `restart=true`); the existing default-installMode-null test was relabeled "local mode". Vitest 684/684 → 688/688 (+4 new tests; re-measured pre + post per [[test-count-remeasure-before-recording]]). See §32 in `todo_ws_scrcpy_web.md` for the full diagnostic timeline (logs, hypotheses ruled out, root-cause confirmation via `--veloapp-updated` hook firing at 14:02:38 but LauncherA dying silently between 14:02:40.550 and ~14:02:44 while LauncherB started at 14:02:44.710 outside Servy supervision).

### Security

- **`release.yml` — workflow-level `permissions: contents: read` added (closes OpenSSF Scorecard alert #16, `TokenPermissionsID`).** Mirrors the workflow-level default pattern already in place on `ci.yml` (PR #17) and `node-pty-prebuilds.yml` (PR #20). Per-job blocks unchanged — `build-windows` + `build-linux` still get `id-token: write` + `attestations: write` for Sigstore provenance, `publish` still gets `contents: write` for `softprops/action-gh-release` to push the release. The `prepare` leg, which previously had `contents: read` declared per-job, now inherits the workflow-level default; the per-job declaration is left in place (explicit > implicit for forward-reading clarity).
- **OpenSSF Scorecard alert triage (§31) — 12 of 13 open alerts dismissed with documented rationale; 1 fixed in code (above). Net state on `main` after triage: 0 open Scorecard alerts.** Cleared per the `feedback_tech_debt_triage_detail.md` protocol (per-alert decision = fix / dismiss-with-rationale / accept). Dismissed-with-rationale alerts stay dismissed in code-scanning across re-scans (the dismissal sticks unless the underlying state changes); #21 (RUSTSEC-2024-0388 derivative-unmaintained) and #23 (Maintained 90-day) auto-clear when upstream / time resolves them. Dismissal categories:
  - **Won't fix — required write permission** (#14 + #15, `TokenPermissionsID` on `node-pty-prebuilds.yml:177` publish job and `release.yml:234` publish job): `contents: write` is required for `softprops/action-gh-release` to publish releases. Scoping down breaks publish.
  - **Won't fix — workflow currently disabled** (#17, `PinnedDependenciesID` on `Dockerfile:1`): `FROM node:18-slim` is unpinned AND on EOL Node 18; `docker-publish.yml.disabled` is shelved as Group A SP4 backlog. Re-evaluated when SP4 ships.
  - **False positive — `npmCommand` install-by-name is registry-integrity-checked** (#18 + #19, `PinnedDependenciesID` on `node-pty-prebuilds.yml:117/145`): `npm install <pkg>@<exact-version>` is integrity-verified by npm against the registry tarball hash; the `--integrity=` flag doesn't apply to install-by-name. #19's `node-pty@${UPSTREAM_VER}` is dynamic-at-runtime by workflow design (the workflow's purpose is to track upstream node-pty version drift).
  - **Won't fix — out of scope** (#20, `FuzzingID`; #25, `CIIBestPracticesID`): WebSocket-bridge frontend doesn't fit fuzzing infra; OpenSSF Best Practices badge to be evaluated if/when v0.5.0 ships.
  - **Won't fix — upstream-blocked transitive** (#21, `VulnerabilitiesID`, RUSTSEC-2024-0388): The `derivative` v2.2.0 crate is unmaintained (RustSec INFO classification, no patched version exists). Pulled in transitively by `velopack 0.0.1298` → launcher. Dependabot will catch the next velopack release; any velopack swap to `derive_more`/`derive-where`/`educe` auto-clears this.
  - **Won't fix — solo-owned repo** (#22, `BranchProtectionID`; #24, `CodeReviewID`): Scorecard grades on codeowners-review + required-approvers + last-push-approval + up-to-date-branches — none apply to a solo-owned repo (per `feedback_pr_workflow.md`). The `Protect main` ruleset (id 16554336) covers what matters: `non_fast_forward`, `required_linear_history`, `required_signatures`, `required_status_checks`, `pull_request`.
  - **Won't fix — self-heals** (#23, `MaintainedID`): "Repository was created within the last 90 days" — repo went public 2026-04-17; self-heals around 2026-07-16.
  - **Won't fix — Scorecard feature gap** (#26, `SASTID`): CodeQL is configured via `.github/workflows/codeql.yml` (advanced setup, PR #19); Scorecard's SAST detector can't see advanced-setup configs.

## [0.1.25-beta.8] - 2026-05-19

### Security

- **`DependencyManager.extractZip` — system-PATH `powershell` + `unzip` shellouts replaced with launcher `--unzip` subcommand. CLAUDE.md Local-Dependencies-Only compliance.** §30 scrubbed PowerShell from the service-elevation path but missed the dependency-manager's zip-extraction path: `installNodejs` / `installAdb` on Windows shelled out to `execFileAsync('powershell', ['-NoProfile', '-Command', 'Expand-Archive ...'])`; the Linux branch shelled out to `execFileAsync('unzip', [...])`. Both resolved binaries via system PATH — same compliance violation, different code path. This change replaces both with a single cross-platform `execFileAsync(launcherPath, ['--unzip', src, dest], ...)` call. The launcher binary is SHA-pinned-to-release and ships in `current/` alongside the Node process; same compliance posture the §30 `--request-uac` path established.
  - **New module `launcher/src/unzip_handler.rs`** (~145 lines + 4 unit tests). `handle(args)` parses `--unzip <src-zip> <dest-dir>` argv positionally and dispatches to `unzip_impl` which uses the pure-Rust `zip` crate (v2.x, default-features dropped, only `deflate` enabled — keeps the launcher binary lean since Node + ADB platform-tools both ship plain-deflate zips). Cross-platform extraction with zip-slip defense via `enclosed_name()` (entries with `..` traversal or absolute paths are skipped with a log line, not extracted). Unix executable-bit preservation via `unix_mode()` so the extracted `adb` binary stays runnable on Linux. Exit codes: **0** success, **2** malformed argv, **3** filesystem error (source unreadable, dest uncreatable, per-entry write failed), **4** zip parse error (corrupt archive or unsupported compression).
  - **Wired into `launcher/src/main.rs`** at line 71 — handler dispatch after `uac_requester::handle` and before `elevated_runner::handle`. The three subcommands are mutually exclusive (one positional flag each), so the dispatch order is purely cosmetic.
  - **`src/server/DependencyManager.ts:408-426` rewritten.** `extractZip` no longer branches on `platform` — both win32 and linux paths now call the launcher. Adds an `if (!launcherIsAvailable()) throw` guard so dev runs without a packaged launcher get a clear error pointing at `scripts/fetch-node.mjs` instead of a confusing PATH-resolution failure deep inside `execFileAsync`. Imports `resolveLauncherPath` + `launcherIsAvailable` from `./service/elevatedRunner` (the same module that owns the §30 elevation path's launcher binding).
  - **Workspace `Cargo.toml`** declares `zip = { version = "2", default-features = false, features = ["deflate"] }`. Launcher's `Cargo.toml` references `zip.workspace = true`. `Cargo.lock` updated — adds `zip 2.4.2` for the launcher and `crossbeam-utils 0.8.21` as a zip transitive dep. (The repo's velopack stack uses `zip 3.0.0` separately — Cargo handles the two-version coexistence automatically.)
  - **Stale `launcher/src/elevated_runner.rs:7-9` module-comment fixed** — was still narrating the pre-§30 `PowerShell Start-Process -Verb RunAs` spawn path as the way Node invokes elevated mode. Updated to reflect the §30 reality (Node → launcher `--request-uac` → `ShellExecuteExW(verb="runas")` → elevated `--elevate-and-run`).
  - **Tests:** 4 new Rust unit tests in `unzip_handler::tests` — dispatch returns None when flag absent; returns 2 when positional args missing (no args after flag, or only src given); returns 3 when source path doesn't exist. End-to-end extraction is exercised on-device by the existing `DependencyManager` autoInstall path and validated during the v0.1.25-beta.7 service-mode smoke. Vitest **684/684 across 61 files unchanged** (re-measured pre + post per [[test-count-remeasure-before-recording]]; same count as the `4c49245` v0.1.25-beta.7 baseline). `npx tsc --noEmit` clean.
  - **Why CLAUDE.md flagged this:** §30 was scoped to "PowerShell in service elevation" specifically; the dependency-manager's zip-extraction was a separate code path that fell outside the §30 audit. The pre-edit-local-deps-verify hook only fires on diffs that *introduce* a spawn/exec call — it doesn't audit existing ones. §4a "Local-deps audit (HIGH PRIORITY)" would have surfaced it as part of a broader sweep; user spot-checked and asked for the immediate fix instead.

## [0.1.25-beta.7] - 2026-05-19

### Docs

- **README.md + CONTRIBUTING.md — stripped stale scrcpy-server version pin (`v3.3.4`).** Per user direction during the 2026-05-19 LATE session: "remove versions unless they are explicitly needed." Three pins removed: README "Genymobile's vanilla scrcpy-server v3.3.4" → "scrcpy-server"; README "Vanilla scrcpy-server v3.x" → "Vanilla scrcpy-server"; CONTRIBUTING.md "scrcpy-server v3.3.4" → "scrcpy-server". The v3.3.4 pin was stale (post-§17 we're on the v4.0 wire protocol) AND not actionable for users — the in-app dependency manager handles the version automatically, so the explicit pin in user-facing prose only served to mislead. Same rationale dropped "not supported in v0.1" → "not supported" in the glibc requirement section: the in-version qualifier signals "might change in v0.2+" but we have no plans to add musl support; the cleaner absolute statement is more accurate today and tomorrow. **Kept verbatim:** the historical upgrade-path warnings (v0.1.20-and-earlier PROGRAMDATA migration, v0.1.21/v0.1.22/v0.1.23-beta.{1..6} broken-updater chain) — those target users on specific old versions and are concrete migration help; removing would orphan them.

### Changed

- **§25c-2.5 — `tsconfig.json` `noUncheckedIndexedAccess: true`.** Fifth and final flag in the §25c-2 series — the highest-correctness flag, surfaces every `array[i]` / `obj[key]` / regex `match[N]` access where the index could be out of bounds. 197 violations fixed across 45 files via per-site judgment (NOT mechanical widening — the flag's value is forcing acknowledgment of "what if the index isn't there"). **Three resolution patterns:**
  - **`!` non-null assertion** where the access is bounded by a prior length / regex-match / state check that TS doesn't track: byte parsers walking after `data.length < 4` guards (`av1-utils.ts`, `h264-utils.ts`, `h265-utils.ts`, `WebCodecsPlayer.findNaluOffset`, `AdbHandshakeProbe.adbChecksum`, `BasePlayer.isIFrame`, `BaseCanvasBasedPlayer` validContextNames probe + videoStats/inputBytes shifts gated by `.length`); regex `match[N]` after `if (match)` (`SubnetDetector`'s `defaultRouteRe` walk + linux gateway detector + `cidrM`/`metricMatch`, `DependencyDefinitions.parseNodeMajor`, `MacResolver.parseLinuxIpNeigh`, `wmParsers.parseWmSize/Density`, `Device.listProc`/`updateInterfaces`/`pidsOf` parent-detection, `scrcpyEncoderList` video+audio regex walks, `DependencyApi` update endpoint URL match, `DeviceProbe` encoder regex); test-file mock destructuring after `toHaveLength`/`toHaveBeenCalledTimes` assertions (`SystemdClient.test.ts` ~14 sites — `unitWrites[0]`, `sysCalls[0]`, `loginctlCalls[0]`, `desktopWrites[0]`, `execFileSyncMock.mock.calls[0]`; `startStream.test.ts` 13 sites; `UpdatesApi.test.ts` 2 sites; `UpdateService.test.ts` 4 sites; `ServerShutdownApi.test.ts` 1 site; `adbClient.test.ts` 2 sites; `adbHandshakeProbe.test.ts` 1 site; `networkScanner.test.ts` 6 sites; `ServyClient.test.ts` 5 sites; `scanNetworkModal.test.ts` 1 site); array-index loops with explicit bounds (`UhidInputMessage.createKeyboardReport` 6-byte loop, `DragAndDropHandler` dataTransfer.items/files iteration, `SvgImage.create` titles loop, `BasePlayer.STATE` Record access for the `'PLAYING'`/`'PAUSED'`/`'STOPPED'` literals, `StreamClientScrcpy.CODEC_ENCODER_PATTERN[codec]` for the 3-codec `as const` tuple, `BaseDeviceTracker.getOrCreateTrackerBlock` `el.children[0]` inside `el.children.length` while loop, `ConfigureScrcpy.populateEncoderDropdown` `matching[0]` after `matching.length > 0`, `ConfigureScrcpy.getValueFromSelect` `select.options[select.selectedIndex]`, `ScanNetworkModal.updateUserRow` `this.rows[idx]` after `idx === -1` guard, `Config.buildServers` + `index.ts` `config.servers[0].port` after `length > 0` guard, `ScrcpyConnection.startStreamSession` 3-socket destructure, `ScrcpyConnection.connectLocal` handshake-byte log line, `NodePtyResolver.fetchAndExtract` SHA-line split, `Device.detectViaInterfaces` array `ip.split('.').map(...)[N]` after `parts.length !== 4` reject, `SubnetParser.ipToInt` same).
  - **Explicit null-check + early return / explicit defaulting** where the index access genuinely can be undefined and the fallback is meaningful: `Device.shell` `[serial = '', state = '']`/`[serial = '', local = '', remote = '']` destructure-with-defaults on `line.trim().split()` output (the trim + split contract doesn't guarantee 2/3-element output); `runVersionCommand` regex match collapsed to `match?.[1] ?? null` (skip narrow + accept null result); `SubnetDetector.fromCidrString` `if (!ip || !prefixStr) return null` guard before parseInt; `SubnetDetector.runCommand` default `if (!bin) throw new Error('empty command')` since shell-string-split could in principle return empty array; `Util.parseBooleanEnv`/`parseIntEnv` `input[input.length - 1] ?? ''` post-array-narrow; `NetworkScanner.nextHost` `hostList[cursor++] ?? null` to preserve the function's `string | null` return contract; `InteractionHandler.mapTypeToAction` `EVENT_ACTION_MAP[type] ?? 0` since the dictionary doesn't cover every event-type string callers might pass.
  - **Inline narrowing block** where multiple subsequent accesses share the same precondition: `AdbClient.getProperties` `if (match[1] !== undefined && match[2] !== undefined) { props[match[1]] = match[2]; }` (TS2538 — `undefined` can't index a Record); `DeviceProbe.listEncodersViaDumpsys` `if (name === undefined) continue` once at the top of the regex-walk body so both downstream `name.includes` checks type as `string`.
  - **Real bug found and fixed:** `AdbClient.parseMdnsOutput`'s `const [name, service, addressPort] = parts;` was assigning a `string | undefined` triple to three locals all later used as `string`. The `if (parts.length < 3) continue;` line above guarantees 3+ elements, but EOP doesn't model the length contract — so I tightened with `as [string, string, string]` cast. Same pattern (length check + 3-tuple destructure) carries the same TS gap, and after the `as` cast this is now explicit-typed at the destructure site.
  - **No code-shape regressions.** Pure type-system tightening, runtime behavior identical at every site.
  - **Vitest 684/684 across 61 files unchanged** (re-measured pre + post per [[test-count-remeasure-before-recording]]; same count as the `326533b` post-§25c-2.4 baseline). `npx tsc --noEmit` clean.

- **§25c-2.4 — `tsconfig.json` `exactOptionalPropertyTypes: true`.** Fourth flag in the §25c-2 series. 86 violations fixed via consistent type widening — every `?: T` declaration that legitimately receives an explicit `undefined` (state-reset assignments, optional-then-cleared fields, conditionally-built object literals, public-API param surfaces) widened to `?: T | undefined`. Two DOM call sites needed conditional inclusion instead because `CloseEventInit` is a built-in browser type that can't be widened. **Touched surfaces:**
  - **Shared types — public API + internal contracts widened together:** `ParamsBase`, `ParamsStreamScrcpy`, `StreamParamsInput`, `VideoSettingsInput`, `StartStreamOptions` (public `ws-scrcpy.d.ts` surface — `?: T | undefined` is a strict supertype of `?: T`, so no external-consumer break), `HostItem`, `HostsItem`, `DependencyInfo`, `UpdateResult`, `UpdateServiceState`, `ServiceStatusResponse`, `ServiceClientFactoryResult`, `ServiceInstallOptions.scope`, `DetectedSubnet.interfaceName`, `AdbHandshakeResult.model`, `ElevatedResult.errorMessage`, `Modal.ModalOptions.onClose`, `VideoSettings` (`Settings` interface + class `crop`/`bounds`/`codecOptions`/`encoderName` fields), `CommandControlMessage.pushFileCommandFromData` return-type.
  - **Class fields cleared to `undefined` — widened in place:** `AudioPlayer.configData`, `ManagerClient.action`, `NetworkDiscoveryPanel.{chip, scanWs}`, `ConfigureScrcpy.deviceKind`, `ConnectModal.handle`, `ShellModal.{term, fitAddon, ws, resizeObserver}`, `ListFilesModal.{multiplexer, filePushHandler, fsChannel, reloadTimeout}`, `StreamClientScrcpy.{controlButtons, touchHandler, uhidManager, uhidKeyboard, uhidMouse, player, fitToScreen, demuxer, audioPlayer, stopFn, onMetadataReceived, onErrorReceived}`, `InteractionHandler.{touchPointImage, centerPointImage, multiTouchCenter, lastPosition}`, `BaseCanvasBasedPlayer.{animationFrameId, canvas}`, `BasePlayer.{screenInfo, parentElement, perSecondQualityStats, momentumQualityStats, sessionVideoCodec, sessionAudioCodec, sessionEncoder, qualityAnimationId}`, `WebCodecsPlayer.configData`, `FrameReader.{frameCallback, endCallback}`, `Device.{properties, updateTimeoutId, throttleTimeoutId}`, `FilePushReader.writeStream`, `ControlCenter.{instance, pollIntervalId}`, `Config.instance`, `DeviceLabelStore.instance`.
  - **Inline param-types widened to match the now-widened sources:** `BaseDeviceTracker.buildUrl({…pathname?: string | undefined})`, `ListFilesModal` constructor `params` (and matching class-field shape), `ShellModal` constructor `params` (and matching class-field shape), `detectBestCodecAndEncoder({hostname?, port?, secure?} all `| undefined`)`, `DeviceTracker.updateLink({…deviceKind?: '...' | undefined})`, `FilePushHandler.processData({value?: Uint8Array | undefined})`. These are call-site receivers of the widened source types; without widening here, `tsc --noEmit` rejects the narrower receiver.
  - **Two DOM-type call sites — conditional inclusion (carve-out from the widening strategy):** `Multiplexer.close()` and `Message.toCloseEvent()` previously built `CloseEventInit` literals with explicit `code: number | undefined` / `reason: string | undefined`. `CloseEventInit` is a `lib.dom` type with `?: number` / `?: string` that we can't widen. Both now construct `CloseEventInit` incrementally — `if (code !== undefined) init.code = code` — so when the values are undefined, the keys stay absent. Runtime CloseEvent behavior identical to before (DOM defaults `code=0`, `reason=''` when the keys are absent; same observable behavior).
  - **Semantic stance for the widening direction.** With `exactOptionalPropertyTypes: true`, `{ foo?: T }` and `{ foo?: T | undefined }` become distinct types — the former means "may be missing", the latter means "may be missing OR explicitly undefined". Almost every EOP-rejected site in this codebase legitimately passes `undefined` to indicate "cleared" / "no value yet" / "not provided". The two alternatives both fail: (a) `delete obj.field` changes runtime shape (`'field' in obj` flips from `true` to `false`), breaking iteration / `hasOwnProperty` consumers; (b) conditional spread bloats every call site for no semantic gain. Widening preserves runtime semantics exactly, keeps the type signatures honest about what callers actually pass, and matches what the TS team explicitly recommends for the "cleared field" idiom.
  - **Vitest 684/684 across 61 files unchanged** (re-measured pre + post per [[test-count-remeasure-before-recording]]; same count as `[[d83154a]]` HEAD baseline). `npx tsc --noEmit` clean.

- **§25c-2.3 — `tsconfig.json` `noPropertyAccessFromIndexSignature: true`.** Third flag in the §25c-2 series. 52 violations fixed across 8 files, all mechanical `obj.key` → `obj['key']` rewrites where `obj`'s static type is an index signature (`Record<string, unknown>`, `DOMStringMap`, `process.env`, runtime-shaped objects via `as Record<...>` casts, etc.). The flag enforces visual distinction between known compile-time properties (dot-access, type-checked) and string-keyed lookups into open-ended dictionaries (bracket-access, runtime-checked). Touched files:
  - **`AudioSettingsStore.ts` (5)** — `v.enabled/source/codec` on the `Record<string, unknown>` validation type-guard
  - **`DeviceTracker.ts` (4)** — `sleepBtn.dataset['awake']` (DOMStringMap is canonical index-signature)
  - **`StreamClientScrcpy.ts` (2)** — `STATE['PAUSED']`/`STATE['PLAYING']` (BasePlayer's STATE enum is typed via index signature)
  - **`GoogToolBox.ts` (1)** — `element.optional['code']`
  - **`BaseCanvasBasedPlayer.ts` (2)** — `STATE['PLAYING']`
  - **`BasePlayer.ts` (5)** — `STATE['STOPPED']` ×2, `STATE['PLAYING']` ×2, `STATE['PAUSED']`
  - **`UpdatesApi.ts` (8)** — `raw['autoUpdate']/['channel']/['githubOwner']/['updateCheckIntervalMinutes']` on `Record<string, unknown>` validation
  - **`server/index.ts` (8)** — diagnostic walk of arbitrary `Record<string, unknown>` handle objects: `handle['address']/['fd']/['spawnfile']/['path']/['_idleTimeout']`
  - **Test files (17)** — `__tests__/ServiceApi.test.ts` (3), `__tests__/UpdatesApi.test.ts` (2), `__tests__/UpdateService.test.ts` (8 + 2)
  - Vitest 684/684 unchanged. tsc clean. No behavioral change — pure access-syntax tightening.

- **§25c-2.2 — `tsconfig.json` `noUnusedLocals: true`.** Second flag in the §25c-2 series. 19 violations fixed, falling into three categories:
  - **Stale class fields (write-only or fully dead) — deletions:** `WelcomeModal.platform` (assigned from status fetch, never read), `WelcomeModal.scopeUserRadio` (assigned from radio el, never read; sibling `scopeSystemRadio` is the live one), `ConfigureScrcpy.resetSettingsButton` + `loadSettingsButton` (the `(this.X = document.createElement(...))` write-then-store-locally idiom was redundant; reverted to plain `const X = document.createElement(...)`), `ListFilesModal.requireClean` + `requestedPath` (initial value, no assignments anywhere). Total: 6 deleted fields + 4 cleaned-up DOM assignments.
  - **Dead test-file imports — deletions:** `modal.test.ts: ModalOptions`, `dependencyTypes.test.ts: DependencyStatus`, `adbClient.test.ts: afterAll + beforeAll`, `discoverServicePort.test.ts: beforeEach`, `libcDetect.test.ts: beforeEach`, `ConfigApi.ts: path`, `StreamClientScrcpy.ts: HostTracker + CommandControlMessage`. Total: 9 dead import-binding deletions.
  - **Dead method + destructured-but-unused locals — surgical removals:** `ScrcpyConnection.connectLocalRetry` method (declared private, zero callers anywhere) deleted entirely; `DeviceTracker.updateLink` destructured `name` removed (interface keeps it); `StreamClientScrcpy.onConfigureStreamClick` `const fullName = button.getAttribute(...)` removed (unused); `StreamClientScrcpy` constructor `private readonly deviceKind` → plain parameter (`deviceKind` was used in body but `this.deviceKind` field never read).
  - Vitest 684/684 unchanged. tsc clean.

- **§25c-2.1 — `tsconfig.json` `noUnusedParameters: true`.** First flag in the §25c-2 series (5 more candidate flags surfaced by the §25c-1.3 ship review: `noUnusedParameters` 6 viols, `noUnusedLocals` 19, `noPropertyAccessFromIndexSignature` 52, `exactOptionalPropertyTypes` 86, `noUncheckedIndexedAccess` 194 — series shipped ascending by volume). 6 violations fixed by renaming params to `_`-prefix (TypeScript's intentional-unused convention) at sites where the param is kept for API-contract / forward-compat reasons: `AudioDefaults.audioEnabledDefault(_kind)` + `defaultAudioSourceForSdk(_sdkInt)` (the `// eslint-disable-next-line @typescript-eslint/no-unused-vars` comments are now redundant and removed), `DependencyManager.install(_def, …)` + `installNodejs(_, _version, …)`, `ServyClient.restart(_name)` + `stop(_name)` (both throw "not yet wired" today; `name` preserved for the API surface). Vitest 684/684 unchanged. tsc clean.

- **§25c-1.3 — `tsconfig.json` `noImplicitOverride: true` (third + final flag in the §25c series).** Unlike PRs #28 + #29 (zero violations on flag enable), this one surfaced **~100 sites across 38 files** where class methods/properties override a base class member without the explicit `override` keyword. All converted mechanically — prepend `override` after access modifier + before method/field name. Three TypeScript error codes covered: `TS4114` (regular method/property override), `TS4115` (parameter property override, e.g., `public override readonly cause?: unknown` on `AdbExecError extends Error`), `TS4116` (abstract method override, e.g., `getPreferredVideoSetting` in `BaseCanvasBasedPlayer extends BasePlayer`). Touched inheritance chains: `Modal` subclasses (8 sites), `Mw` subclasses (server-side middleware, 6 files / 16 sites), `ControlMessage` subclasses (8 controlMessage types / 22 sites), `BaseDeviceTracker`/`ManagerClient` hierarchy (frontend, 6 sites), `BasePlayer`/`BaseCanvasBasedPlayer`/`WebCodecsPlayer` chain (17 sites), `TypedEmitter` on `Multiplexer`, `Readable` on `ReadStream`, `Error.cause` on `AdbExecError`. Vitest **684/684 across 61 files** (re-measured at branch HEAD, unchanged). `npx tsc --noEmit` clean. Going forward, every new class method that overrides a base class member must carry the `override` keyword — silent overrides (renames in base class with stale subclass copies) are now compile errors.

- **§25c-1.2 — `tsconfig.json` `noImplicitReturns: true`.** Second flag in the §25c series. Zero violations on `src/` as-written — every function in the codebase either has a single return path or has explicit return on every branch. tsc clean. vitest 684/684 unchanged. Guards against future PRs accidentally writing functions where some control-flow paths exit without returning a value (a subtle bug where callers silently get `undefined`).

- **§25c-1.1 — `tsconfig.json` `noFallthroughCasesInSwitch: true`.** First flag in the §25c series of additional TS strict-mode flags evaluated as part of TS6's broader compliance scope (the §25 mandate focused on `using` declarations; §25c picks up the audit-type-only-patterns sub-bullet). Zero violations on `src/` as-written — every existing `switch` statement already terminates each case with explicit `break` / `return` / `throw`. tsc clean. vitest 684/684 unchanged. Cheap signal-to-noise win — guards against future PRs accidentally introducing fallthrough bugs (a hard-to-catch class of error where execution silently bleeds into the next case).

### Security

- **`.github/workflows/scorecard.yml` — OpenSSF Scorecard supply-chain security workflow added.** Cross-repo carryover from control-menu (PR #14 + #15). Ws-scrcpy-web previously had CodeQL advanced setup with Rust scanning but no Scorecard visibility for the broader supply-chain check suite (Branch-Protection, Code-Review, Dangerous-Workflow, Dependency-Update-Tool, Maintained, Pinned-Dependencies, SAST, Security-Policy, Signed-Releases, Token-Permissions, etc.). Triggers: weekly cron (Monday 13:00 UTC), `branch_protection_rule` (catches ruleset regressions automatically), `push` to main (current-score reflects latest commit), `pull_request` to main (so the check can become a required-status check later without blocking merges forever). Workflow-level `permissions: read-all`; job-level explicit `security-events: write + id-token: write + contents: read + actions: read`. All actions SHA-pinned with commit SHAs (not tag-object SHAs — `ossf/scorecard-action@4eaacf0543bb3f2c246792bd56e8cdeffafb205a # v2.4.3` was dereferenced from annotated tag `f25eda87...` via `gh api .../git/tags/<tag-obj-sha>` per [[action-sha-pin-commit-not-tag-object]]; same SOP that control-menu PR #15 was the canonical incident for) and precise patch-level comments per [[dependabot-precise-version-comment]]. Repo `actions/permissions/selected-actions/patterns_allowed` extended via API to include `ossf/scorecard-action@*` before merge (else CI rejects under `sha_pinning_required: true`). `publish_results: ${{ github.event_name == 'push' }}` — gated to push events to avoid the OpenSSF webapp verifier's "imposter commit" rejection on PR branch SHAs.

- **`.github/workflows/codeql.yml` — `github/codeql-action` v3.35.5 → v4.35.5 cross-repo carryover.** Driven by Node 20 deprecation in the v3 line (CodeQL Action's v3 runtime EOL'd December 2026 per the deprecation warning surfaced during §27's first run). Bumps both pin sites (`init` line 85, `analyze` line 92) from SHA `458d36d7d4f47d0dd16ca424c1d3cda0060f1360` to `9e0d7b8d25671d64c341c19c0152d693099fb5ba`. Same dereferenced commit SHA control-menu PR #16 shipped 2026-05-19. Both SOPs applied at pin time: precise version comment `# v4.35.5` per [[dependabot-precise-version-comment]]; commit SHA (not annotated-tag-object SHA `f25eda876ebb741d872b63b9f2c6dfdd77f14b83`) per [[action-sha-pin-commit-not-tag-object]] — `gh api repos/github/codeql-action/git/ref/tags/v4.35.5` returns `{object.type: "tag"}`, dereferenced via `gh api repos/github/codeql-action/git/tags/<tag-obj-sha>` to the commit. CodeQL Action v4 uses Node 24 runtime; same query suites, same analysis behavior — no workflow logic changes needed.

- **§30 — Rust UAC in launcher replaces `powershell.exe` for service install/uninstall elevation. CLAUDE.md Local-Dependencies-Only compliance.** Pre-§30 the Node side invoked `powershell.exe Start-Process -Verb RunAs` (via `execFileAsync('powershell.exe', [...])`) to fire the UAC prompt for service install/uninstall — `powershell.exe` resolved via system PATH, a strict violation of CLAUDE.md's Local-Dependencies-Only rule (PowerShell 5.1 is OS-bundled but the rule doesn't carve out OS-bundled binaries). §30 replaces the PowerShell elevation layer entirely with a new `--request-uac` subcommand on the launcher that calls Win32 `ShellExecuteExW(verb="runas")` directly on the launcher binary itself (resolved via `std::env::current_exe()` — local-deps-compliant by definition).
  - **New module `launcher/src/uac_requester.rs`** — Windows-only via `#[cfg(windows)]` with a non-Windows stub returning exit 99. `handle(args)` parses `--request-uac <command> <args-path> <result-path>` argv positionally (same shape `--elevate-and-run` uses), builds a quoted parameters string `--elevate-and-run "..." "..." "..."` (defends against spaces in temp-dir paths), and calls `ShellExecuteExW(SHELLEXECUTEINFOW { lpVerb: "runas", lpFile: current_exe, lpParameters: ..., nShow: SW_HIDE })`. Exit codes:
    - **0** = UAC accepted; elevated launcher is spawning in the background. Node continues with result-file polling.
    - **1223** = UAC declined by user (Windows `ERROR_CANCELLED`, surfaced via `ShellExecuteExW` returning `Err` with HRESULT `0x800704C7`). Node maps this to "user declined elevation" — same user-facing message the PowerShell decline path produced.
    - **3** = unexpected `ShellExecuteExW` failure (admin policy disabled, missing current_exe, etc.).
    - **99** = invoked on non-Windows host.
  - **Wired into `launcher/src/main.rs`** at line 64 — handler dispatch BEFORE `elevated_runner::handle` (request-uac is the non-elevated entry point; elevate-and-run is the elevated-side handler — they're mutually exclusive). Same `Some(code) → std::process::exit(code)` shape as the existing dispatch branches.
  - **Reuses the existing `Win32_UI_Shell` workspace-level feature flag** on the `windows` crate (already enabled for `install_acl.rs`'s `ShellExecuteExW` use). No new dependencies.
  - **`src/server/service/elevatedRunner.ts:194-237` rewritten** to spawn the launcher with `--request-uac` instead of PowerShell. The surrounding result-file-polling flow is unchanged — `pollForResultFile(resultPath, ELEVATION_TIMEOUT_MS)` still reads the elevated launcher's JSON result the same way it did pre-§30. Removed `buildPsRunAsCommand` + `PsRunAsParams` (37 lines + helper) — no longer used; replaced by `execFileAsync(launcherPath, ['--request-uac', command, argsPath, resultPath])` whose argv is passed as a JS string array (no shell escaping concerns).
  - **Tests:** Dropped the 4 `buildPsRunAsCommand` unit tests (Start-Process structure, argv list, single-quote escape defense, ErrorActionPreference Stop) — they tested the PowerShell-shell-string-construction layer that no longer exists. Replacement coverage: exit-code mapping (0 vs 1223 vs other) is exercised end-to-end on Windows via the existing service install/uninstall flows; pure-unit coverage would require mocking the launcher subprocess, which would test the mock not the integration. New Rust unit tests in `uac_requester::tests`: `handle_returns_none_when_flag_absent`, `handle_returns_none_when_flag_absent_no_args`, `handle_returns_none_when_args_missing_after_flag` (3 sub-cases for argv with too few positionals); a `#[cfg(not(windows))]` test for the exit-99 non-Windows stub. Vitest: **684/684** across 61 files (down from 688 baseline by exactly the 4 buildPsRunAsCommand tests — re-measured per [[test-count-remeasure-before-recording]]). `npx tsc --noEmit` clean.
  - **Cross-repo precedent:** the local-deps-OK launcher binary (already SHA-pinned to release, lives in `<install>/current/`) was previously already used by Node for the `spawn-user-launcher` direct-spawn path (service-mode handoff). §30 brings the install/uninstall-service paths under the same architecture — Node always spawns the launcher (never PowerShell), and the launcher handles all Windows-API concerns (elevation, cross-session, registry, ACLs). One less moving part.

- **`.github/workflows/codeql.yml` — bare-major `# v3` SHA-pin comments on `github/codeql-action/init` + `/analyze` → precise `# v3.35.5`.** Cross-repo SOP audit ([[dependabot-precise-version-comment]] landed during this session via control-menu PR #14's `actions/upload-artifact` Dependabot blind-spot incident) flagged two bare-major comments in this repo. Bare `# v3` is interpreted by Dependabot as a "track v3 line" range pin — silently skipping major-bump PRs even when v4+ ships. The current SHA `458d36d7d4f47d0dd16ca424c1d3cda0060f1360` already resolves to v3.35.5 (released 2026-05-15); fix is comment-only, no SHA bump. Re-enables Dependabot bump discovery on the next weekly run. Audit also verified rule [[action-sha-pin-commit-not-tag-object]] across all 14 unique action pins in `ws-scrcpy-web/.github/workflows/` — every pin is a commit SHA (not annotated-tag-object SHA), including `actions/github-script@v9.0.0` which uses an annotated tag and was already correctly pinned to the commit. No SHA-type violations to fix.

### Changed

- **§25b — TS6 `using` adoption across `src/app/*` (frontend follow-up to §25).** Converts the 10 remaining `try/finally` cleanup sites carved out of §25 server-side because the frontend "DOM lifecycle is its own beast." On re-inspection per-site, these turned out to be cleaner than expected: every one is a button-state-restore pattern + `clearTimeout` + `window.parent` property restore for tests. All 10 converted with inline-Disposable literals — no shared helper needed (each captures different local DOM elements / instance fields / closure variables). `src/app/client/DependencyPanel.ts` ×2 (refreshDeps button + busy flag, updateDep busy flag), `src/app/client/NetworkDiscoveryPanel.ts` (manual-connect button), `src/app/client/SettingsModal.ts` ×4 (server-save button, update-check button with conditional re-enable, install-service button, uninstall-service button with `clearTimeout` for the 5s "still waiting" toast), `src/app/googDevice/client/DeviceTracker.ts` (sleep-wake button), `src/app/public/__tests__/themeEmbed.test.ts` ×2 (`window.parent` Object.defineProperty restore in two parallel tests). Vitest baseline unchanged (688/688 across 61 files — §25b doesn't add helpers or contract tests; the existing tests cover the cleanup paths). `tsc --noEmit` clean. With this PR, every `try/finally` cleanup site across `src/` is now TS6 `using`-style — `grep -rn "finally" src/` returns only the §25 explanatory comment in `WebsocketMultiplexer.ts` documenting the removal of a degenerate empty wrapper.

- **§25 — TS6 `using` / `await using` adoption across `src/server/` + `src/packages/multiplexer/` (release-readiness gate).** Replaces every `try { … } finally { /* cleanup */ }` pattern in the server-side codebase with TC39 Stage 3 Explicit Resource Management (native in TypeScript 6, ES2026). User direction 2026-05-18 was MUST-CONVERT across `src/`, with frontend `src/app/*` allowed slower-paced. 13 conversion sites this pass; 10 frontend `src/app/*` sites carved out for a follow-up.
  - **New helper module `src/server/util/disposable.ts` + tests `src/server/util/__tests__/disposable.test.ts`** (4 new tests, all passing). Exports one helper: `tempDir(prefix?: string): TempDirHandle` — `Disposable` wrapper around `fs.mkdtempSync` + `fs.rmSync` (recursive + force). Used at three sites where the pattern repeats verbatim; other cleanup shapes are kept as inline-Disposable literals at the call site to avoid over-extraction. Tests cover: directory exists during scope + removed after dispose, prefix is honored, default prefix is `ws-scrcpy-`, dispose is idempotent on already-removed dirs.
  - **6 production server sites converted:**
    - `src/server/DependencyManager.ts:130` — bespoke nested temp-dir path (`os.tmpdir()/ws-scrcpy-web/update-${name}-${Date.now()}`) → inline `using _tmpDirCleanup = { [Symbol.dispose]() { fs.rmSync(...) } }` (not extracted because the path layout is intentionally specific for debuggability of in-flight updates).
    - `src/server/service/elevatedRunner.ts:148` — `fs.mkdtempSync(os.tmpdir() + 'ws-scrcpy-elev-')` → `using td = tempDir('ws-scrcpy-elev-')`; entire outer try/finally body de-indented one level and the `finally` block removed (its rmSync now lives in the helper's dispose).
    - `src/server/AdbDaemonManager.ts:90` — `setTimeout` timer + `try { Promise.race } finally { clearTimeout(timer) }` → inline `using _timerCleanup = { [Symbol.dispose]() { if (timer) clearTimeout(timer); } }` declared after the Promise executor populates `timer`.
    - `src/server/network/NetworkScanner.ts:96` — instance state restore (`this.state = 'idle'; this.cancelFlag = false`) → inline `using _scanStateReset` declared at function entry so the invariant is restored on every exit path including the early-return on adb-not-ready.
    - `src/server/goog-device/filePush/FilePushReader.ts:157` — `this.cleanupTempFile()` cleanup → inline `using _tempFileCleanup` wrapped in a block scope so dispose fires before the unrelated `this.release()` call below it (same ordering as the prior finally).
    - `src/server/mw/WebsocketMultiplexer.ts:52` — **REMOVED** the empty `try { … } finally { }` wrapper. No cleanup was happening (the body was commented-out future-feature placeholder code). Wrapping nothing in a `Symbol.dispose() { /* nothing */ }` would just dress up the dead syntax — clearer to remove the wrapper. User confirmed this carve-out 2026-05-19.
  - **2 sites in `src/packages/multiplexer/Multiplexer.ts`** (vendored upstream multiplexer code from NetrisTV/ws-scrcpy origin): channel-CLOSING→CLOSED state transition (line 144) + class-level CLOSING→CLOSED transition in `close()` (line 240) → both converted to inline `using _closingState`. User confirmed 2026-05-19 that the fork is product-line, not slated for upstream PR, so TS6 stylistic conversions into vendored files are in-scope rather than carved out.
  - **5 test sites converted:**
    - `src/server/__tests__/adbClient.test.ts:113` — temp dir cleanup → `using td = tempDir('adb-test-')`.
    - `src/server/__tests__/dependencyDefinitions.test.ts:192` — `NODE_LTS_ABI` global mutation restore → inline `using _restoreNodeLtsAbi`.
    - `src/server/__tests__/adbHandshakeProbe.test.ts:202, 224, 238` — three TCP-server + sockets cleanup sites → three `await using _server = { [Symbol.asyncDispose]: () => closeServer(server, sockets) }` declarations (the only `await using` conversions in this pass; the rest are sync `using`).
  - **Test baseline:** **vitest 688/688** across 61 files (was 684/684 across 60 files at session start; delta is +4 tests / +1 file from the new `disposable.test.ts`). `npx tsc --noEmit` clean. Lint debt pre-dating this PR is unchanged (135 errors / 255 warnings on `main` — CI doesn't run Biome lint; pre-existing import-sort + deprecated-Buffer-slice noise across `src/`; §25 PR scope is TS6 idioms, not lint cleanup).
  - **Sites carved out for a follow-up §25b:** `src/app/googDevice/client/DeviceTracker.ts`, `src/app/client/DependencyPanel.ts` ×2, `src/app/client/NetworkDiscoveryPanel.ts`, `src/app/client/SettingsModal.ts` ×4, `src/app/public/__tests__/themeEmbed.test.ts` ×2 — 10 frontend sites where the cleanup is DOM lifecycle (modal scroll-lock, event-listener removal, counter decrement) rather than classic resource cleanup. The §25 scope text explicitly allowed `src/app/client/` to be slower-paced; converting these requires per-site DOM-lifecycle judgment that doesn't benefit from a mechanical sweep.

- **§26 — Biome 2.4.15 TS6 support verified, no bump needed (release-readiness gate prerequisite for §25).** Probe-file approach: created a one-file `__ts6_using_probe.ts` containing minimal `Disposable` + `AsyncDisposable` implementations and `using` + `await using` declarations, ran `npx @biomejs/biome check` against it — clean (no parse errors, no diagnostics). Also confirmed `npx tsc --noEmit` parses the same syntax cleanly under the project's existing `target: ES2022` + `moduleResolution: bundler` config. Probe file deleted post-verification. §26 closes as "verified, no bump needed" — the §25 conversion proceeds on Biome 2.4.15 without action.

### Security

- **§29(a) — SHA-pinned five remaining moving-tag action references across `.github/workflows/`.** Prerequisite to enabling repo-level `sha_pinning_required` enforcement to match Control Menu's hardening baseline.
  - **`dtolnay/rust-toolchain@stable` → `@29eef336d9b2848a0b548edc03f92a220660cdb8 # stable`** at three sites: `ci.yml:21` (build-and-test, `with: components: clippy`), `release.yml:61` (build-windows), `release.yml:172` (build-linux, `with: targets: x86_64-unknown-linux-musl`). The `stable` branch on `dtolnay/rust-toolchain` advances every Rust release; Dependabot keys on the trailing `# stable` comment for branch-tracking (parallel convention to `# v1.2.3` semver tracking for tagged actions — both supported by the `github-actions` ecosystem entry in `.github/dependabot.yml`).
  - **`docker/login-action@v3` → `@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3.7.0`** at `docker-publish.yml.disabled:15`. Latest v3 release (2026-01-28); a newer v4 major exists (v4.1.0) but the workflow is currently disabled — preserve the existing v3 semantic for now, let Dependabot propose a major bump if/when the workflow is re-enabled.
  - **`docker/build-push-action@v5` → `@ca052bb54ab0790a636c9b5f226502c73d547a25 # v5.4.0`** at `docker-publish.yml.disabled:21`. Latest v5 release (2024-06-10); v7.1.0 is the current major but again, disabled workflow → preserve v5 semantic.
  - Verification: `grep -r "uses:" .github/workflows/` returns every action reference now ending with either `# vX.Y.Z` (semver) or `# stable` (branch) — zero moving-tag refs remain.

### Added

- **`.github/workflows/node-pty-prebuilds.yml` — paired `close-issue-on-success` job that auto-closes stale `prebuild-failure` issues when a subsequent matrix run completes successfully end-to-end.** Symmetric to the existing `open-issue-on-failure` job (which files an issue with labels `prebuild-failure` + `ci` whenever the matrix or publish fails — issue #6 was the first real-world firing, fired on the 2026-05-18 scheduled main run that hit the VS 2026 / node-gyp regression on the windows-latest x64 prior leg, and was closed manually after `d42de9e0` shipped the npm 11.14.1 fix). With this job in place, future failure → fix cycles self-heal on the next green run rather than leaving behind a manually-curated trail of resolved bot issues.
  - **Gate:** `needs.precheck.outputs.changed == 'true' && needs.build.result == 'success' && needs.publish.result == 'success'`. Explicit success on both build + publish (not just `success()`) so "no version delta, build skipped" runs don't false-trigger closure — those runs carry no signal about whether the prebuild path actually works.
  - **Mechanism:** `actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0` (same SHA pin the open job uses, Dependabot-tracked via the `github-actions` ecosystem entry in `dependabot.yml`). Paginates open issues filtered by `labels: 'prebuild-failure'` via `github.paginate(github.rest.issues.listForRepo, …)` — paginates because the GitHub list-issues endpoint returns max 100 per page and a long-running CI history could accumulate >100 stale issues if auto-close ever lags. Skips entries where `issue.pull_request` is set (the `listForRepo` endpoint returns both issues and PRs in a single list — filtering is the documented practice). For each remaining issue: adds a comment linking to the closing run URL, then `issues.update` with `state: 'closed', state_reason: 'completed'`.
  - **Permission scope:** per-job `permissions: issues: write` — same minimum write the open-issue job declares. Workflow-level default remains `contents: read`.
  - **Failure-mode notes.** (a) If a different failure recurs after the close, the next failed run opens a fresh issue via the existing open-issue job — no need to track reopens. (b) If `gh issue close` is invoked manually on an issue before the next successful run (as happened with #6 today), the close-issue-on-success job simply finds no open issues with the label on its next firing — idempotent no-op. (c) The job cannot misfire on the bot's *own* commenting/closing actions because `actions/github-script`'s default token is `GITHUB_TOKEN` (not a PAT) and issue-comment + issue-update events from that token don't re-trigger workflow runs by GitHub Actions design.

### Security

- **CodeQL §28 triage — 3 fixes + 6 dismissals to clear all 9 pre-existing alerts surfaced by the advanced-setup migration.** All 9 alerts had been visible in the Security tab during the default-setup era; the §27 migration put them back in front of us. Per user direction *"Today, EVERYTHING needs a solid security baseline"*, all 9 were triaged in this commit pair.
  - **`src/server/goog-device/Device.ts:255` — `.replace('\r', '')` → `.replaceAll('\r', '')`.** Fixes CodeQL alert #12 (`js/incomplete-sanitization`, high). Intent was to strip ALL trailing CRs from adb command output; the single `.replace` only stripped the first. Downstream is a `list.includes(parentPid)` check; impact was low (incorrect false-negative on PPID match against the `pidof init` output) but a real correctness bug.
  - **`.github/workflows/node-pty-prebuilds.yml` — added workflow-level `permissions: contents: read`.** Closes CodeQL alerts #3 (precheck job) + #5 (build job). The `publish` (line 176) and `open-issue-on-failure` (line 273) per-job overrides from the Tier 1 hardening pass are unaffected — they declare their own writes-needed scopes (contents:write / issues:write) and inherit nothing problematic from the new workflow-level default.
  - **6 alerts dismissed via API with documented rationale** (state=dismissed, dismissed_reason + dismissed_comment recorded on each):
    - **Alerts #7, #8 (`js/request-forgery`, critical, `src/app/client/ManagerClient.ts:41,58`):** dismissed as `won't fix`. The flagged `new WebSocket(url)` calls take a URL built from query parameters (`hostname`, `port`, `pathname`) that are by-design user-controlled — the entire product premise is "specify a remote ws-scrcpy-web server via URL params." Restricting these would break the product. CodeQL's `js/request-forgery` is server-side-SSRF-tuned; misfires for client-side WS-to-user-specified-URL. Rationale recorded in the alert metadata.
    - **Alerts #9, #10, #11 (`js/tainted-format-string`, high, `src/app/googDevice/client/ConfigureScrcpy.ts:272,275,340`):** dismissed as `false positive`. The flagged lines pass JS template literals to `console.log`/`console.error`; template literals are JS-native interpolation, not printf-style format strings. `console.log` does NOT `%s`-substitute the interpolated values. Alert #340's "format string" has no interpolation at all (`\`Display id from VideoSettings and DisplayInfo don't match\``). The rule is over-eager for JS.
    - **Alert #13 (`js/incomplete-url-substring-sanitization`, high, `src/server/__tests__/dependencyManager.update.test.ts:29`):** dismissed as `used in tests`. The flagged `url.includes('api.github.com')` is in a test stub for `global.fetch` that returns a mock GitHub-API response. Substring match is intentional — the stub needs to cover any URL format the dependency manager might construct for GitHub API calls. Strict host parsing would defeat the test's purpose.
  - **Net post-§28 state:** 0 open CodeQL alerts on `main`. The 3 fixed alerts closed automatically when CodeQL re-scanned after PR merge; the 6 dismissed alerts are recorded as `dismissed` with their rationale preserved in alert metadata + GitHub Security tab.

- **CodeQL — migrated from default setup to advanced setup; gain Rust coverage on both Linux and Windows.** Default setup is GitHub-managed and supports a fixed language list (`actions, c-cpp, csharp, go, java-kotlin, javascript-typescript, python, ruby, swift`) that does NOT include Rust — verified directly today (`PATCH ... languages[]=rust` returns `422 Invalid request: rust is not a possible value`). Advanced setup means we own a `.github/workflows/codeql.yml` workflow file and pick the languages + build modes + triggers + schedule explicitly; in exchange Rust analysis is available. User direction: "Today, EVERYTHING needs a solid security baseline, so not evaluating the code with the automated runners is a no-op." Migration ships in this commit. New file `.github/workflows/codeql.yml`:
  - **Languages + matrix:** `actions` + `javascript-typescript` + `rust` (×2). Rust runs on **both** `ubuntu-latest` AND `windows-latest` runners because the launcher + tray code is heavily `cfg(windows)`-gated (14 `cfg(windows)` blocks in `launcher/src` across `main.rs`, `hooks.rs`, `paths.rs`, `single_instance.rs`, `elevated_runner.rs`; the `tray` crate's `windows` dep is unconditional in the dep tree but only meaningful on Windows targets). Single-OS Rust scanning would miss the bulk of the security-relevant code.
  - **Build mode:** `none` for all four matrix entries. Empirically verified during PR #19 first push that Rust does NOT support `autobuild` in CodeQL 2.25.4 — the error is explicit: *"Rust does not support the autobuild build mode. Please try using one of the following build modes instead: none."* (Source-only extraction; CodeQL reads `.rs` files directly without invoking `cargo build`.) Faster than autobuild would have been + zero toolchain setup needed. Implication for the two-OS Rust matrix: with `build-mode: none`, both OS legs technically extract the same source files (cfg gates don't filter at source-extraction time). We keep both for now because future CodeQL versions may add per-target extraction, and extraction-only cost is small. Revisit when CodeQL ships proper Rust autobuild + target-platform support.
  - **SHA pinning:** `github/codeql-action/init@458d36d7d4f47d0dd16ca424c1d3cda0060f1360 # v3` and `analyze@458d36d7d4f47d0dd16ca424c1d3cda0060f1360 # v3`. Dependabot's `github-actions` ecosystem covers future bumps.
  - **Triggers:** `push` to `main`, `pull_request` to `main`, weekly cron Monday 09:00 ET (13:00 UTC during DST) — matches `dependabot.yml`'s cadence.
  - **Permissions:** workflow-level `contents: read`; per-job `security-events: write` (SARIF upload) + `packages: read` + `actions: read` + `contents: read`.
  - **Category labels:** `/language:actions`, `/language:javascript-typescript`, `/language:rust-linux`, `/language:rust-windows` — distinct labels for the two Rust runs so SARIF results are aggregated correctly.
  - **Default-setup disable (applied via API after merge, not in this commit):** `DELETE /repos/.../code-scanning/default-setup` to stop the old GitHub-managed scans. Brief overlap during the PR window is acceptable (just duplicate analyses, not a correctness issue).
  - **Cost accepted:** CI minutes (Rust autobuild on both platforms adds ~5-10 min per push/PR/cron run) + owning the workflow config + adopting future CodeQL features manually rather than getting them automatically via default setup. Per user direction, security posture takes precedence over CI latency.
  - **`feedback_do_that_thing.md` tweak (filed separately in `~/.claude` repo):** the "do that thing" SOP gains a new step-1 sub-bullet: in any Rust-containing repo with advanced-setup CodeQL, the SOP must verify the `codeql.yml` SHA pins are current and the most recent CodeQL run on `main` succeeded. This is the maintenance discipline the advanced-setup choice requires.

## [0.1.25-beta.6] - 2026-05-18

### Security

- **Tier 4 hardening — workflow least-privilege + Sigstore build attestations.** Audited ws-scrcpy-web's lockdown against the Control Menu repo (which today represents the canonical hardening baseline across my projects) and closed four concrete gaps in the GitHub Actions workflows:
  - **`.github/workflows/ci.yml`** — added workflow-level `permissions: contents: read`. Previously inherited the repo default; making it explicit follows the same least-privilege pattern the other workflows use and removes ambiguity for new jobs added later.
  - **`.github/workflows/release.yml`** — added per-job `permissions:` blocks to `prepare`, `build-windows`, and `build-linux` (the `publish` job already had one). `prepare` gets `contents: read`; both build jobs get `contents: read` + `id-token: write` + `attestations: write`. The id-token + attestations permissions are required for the Sigstore step in the next bullet — they live on the build jobs (not workflow-level) so other jobs in the workflow can't accidentally call attestation endpoints.
  - **`.github/workflows/release.yml`** — added `actions/attest-build-provenance@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v4.1.0` steps to both build jobs. `build-windows` attests the MSI + Portable.zip + nupkg (the three Windows release artifacts); `build-linux` attests the AppImage. Attestations link each artifact to the workflow run + commit + actor and are Sigstore-signed using a workflow OIDC token. Downstream consumers can verify via `gh attestation verify <artifact> --repo bilbospocketses/ws-scrcpy-web`. Mirrors Control Menu's identical pattern at the same SHA pin. When a code-signing path (Authenticode for Windows; the unselected Linux signer slot for AppImage) is wired in, the attestation will then cover the signed artifact rather than the unsigned one — attestation subject is the file content at step-evaluation time.
  - **Branch protection ruleset additions (applied via API after merge, not in this commit)**: `pull_request` rule added to `Protect main` ruleset (formal PR-required gate, complementing the existing `required_status_checks`-driven de-facto PR workflow); new `Protect release tags` ruleset created targeting `refs/tags/v*` with `deletion` + `non_fast_forward` rules, preventing release-tag deletion or rewrite. Both mirror Control Menu's ruleset shape.
- **CodeQL Rust coverage gap surfaced.** Investigation of today's claim that CodeQL was scanning `[actions, javascript-typescript, rust]` revealed that (a) the actual default-setup config has never included Rust (today's PATCH attempting to add it returned `422 Invalid request: rust is not a possible value`), and (b) the CodeQL default-setup supported-language list is `{actions, c-cpp, csharp, go, java-kotlin, javascript-typescript, python, ruby, swift}` — Rust is NOT in it. Adding Rust scanning would require migrating from default-setup to advanced-setup (custom `codeql.yml` workflow). The CHANGELOG entry from earlier today overstated the Rust coverage; reality is the launcher / tray Rust code (~few hundred lines each, ~mostly bindings into Node-side IPC) is unscanned by CodeQL. Clippy with `-D warnings` runs in `ci.yml` for lint-grade signal; CodeQL-grade taint analysis is the gap. Logged as a follow-up TODO; decision pending whether the surface justifies the migration cost.

## [0.1.25-beta.5] - 2026-05-18

### Changed

- **`.github/workflows/release.yml` — `actions/setup-dotnet` v4.3.1 → v5.2.0 (SHA-pinned) + `dotnet-version` 9.x → 10.x in both `build-windows` and `build-linux` jobs.** Two motivations: (1) brings the action up to its current major (only breaking change in v5.0.0 is the action's internal Node 24 runtime, which GitHub-hosted runners already satisfy); (2) bumps the SDK from .NET 9 (STS, end-of-life Nov 2026) to .NET 10 (current LTS, end-of-life Nov 2028) — consistent with Control Menu's same upgrade landed 2026-05-09. `vpk` (Velopack 0.0.1589-ga2c5a97) is a global tool installed via `dotnet tool install -g`; it runs on the SDK's runtime support stack, and .NET 10 SDK ships runtimes for older TFMs. **Supersedes Dependabot PR #11** which only proposed the setup-dotnet bump in isolation. Validation: signed commit on a feature branch → PR with `build-and-test` green → squash-merge → fresh beta tag fires `release.yml` end-to-end exercising both Windows and Linux build legs.

### Security

- **Repo hardening — Tier 3: CodeQL, required CI on main, SSH signed commits, Dependabot triage.** Continuation of the multi-tier hardening pass.
  - **CodeQL code scanning enabled** via API default setup (`PATCH /code-scanning/default-setup`, `query_suite: default`). Auto-detected languages: actions, javascript-typescript, rust. All three Analyze jobs (`Analyze (javascript-typescript)`, `Analyze (actions)`, `Analyze (rust)`) ran on the latest main commit with conclusion `success` — first scan baseline clean. Free for public repos; no workflow file authored (default setup is GitHub-managed).
  - **`build-and-test` (from `ci.yml`) added as a required status check on `main`** via PUT `/rulesets/16554336`. The "Protect main" ruleset now has 4 rules: `deletion`, `non_fast_forward`, `required_linear_history`, `required_status_checks`. Direct pushes to main are now blocked when CI hasn't completed successfully on the head commit — effectively requires PR workflow for code changes.
  - **PR workflow adopted for ws-scrcpy-web** as a consequence of the previous bullet. Enabled `allow_auto_merge` at repo level so `gh pr merge --auto` queues PRs for merge once required checks pass. Workflow change vs. solo-no-PR default: every code change goes through a branch → PR → CI green → merge cycle. Direct push to main is still possible for admin-bypass-able emergencies but blocked by default.
  - **SSH commit signing configured locally** with a dedicated ed25519 keypair (`~/.ssh/id_ed25519_signing`, no passphrase — disk-encryption-at-rest provides equivalent protection on this single-user machine). Git globals set: `gpg.format=ssh`, `user.signingkey=<path-to-pub-key>`, `commit.gpgsign=true`, `tag.gpgsign=true`. Public key registered on GitHub as a *Signing Key* (NOT an Authentication Key — separate list under Settings → SSH and GPG keys). This commit is the first signing-flow test. `require_signatures` rule deferred until first signed commit lands successfully — added in a follow-up.
  - **Dependabot triage** of the 7 PRs that fired on Dependabot's first scheduled scan after `.github/dependabot.yml` landed:
    - **Merged via `gh pr merge --rebase --auto`**: PR #8 (ws 8.20.0→8.20.1, patch), PR #9 (jsdom 29.0.2→29.1.1, minor), PR #10 (@biomejs/biome 2.4.12→2.4.15, patch), PR #12 (actions/github-script SHA bump on the v9.0.x line — Dependabot detected upstream tag movement, exactly the SHA-pin maintenance loop working as designed), PR #13 (vitest 4.1.4→4.1.6, patch). All 5 had `build-and-test` ✓ before merge.
    - **Closed**: PR #7 (@types/node 24.12.2→25.9.0 major bump). CI failed (tsc errors expected from a major @types bump); held for separate validation when we adopt Node 25 LTS as a target.
    - **Held open with comment**: PR #11 (actions/setup-dotnet 4.3.1→5.2.0 major bump). CI passes, but `ci.yml` doesn't exercise `release.yml` (only triggers on tag push), so passing CI doesn't validate the major action bump's behavior in the actual Windows + Linux release build jobs. Will pick up at the next release tag.

### Security

- **Repo hardening — branch protection, secret scanning, SHA-pinned GitHub Actions, Dependabot version updates, per-job least-privilege `permissions:` on `node-pty-prebuilds.yml`.** Surfaced from the GitHub UI banner *"Your main branch isn't protected"*. Five-part hardening:
  - **Branch protection ruleset on `main`** (ruleset ID 16554336, "Protect main"): blocks force-push (`non_fast_forward`), branch deletion (`deletion`), and merge commits (`required_linear_history` — codifies our existing FF-only practice). No required status checks gating — kept solo workflow friction zero.
  - **Secret Scanning + Push Protection enabled** at repo level. Free for public repos. Push Protection blocks `git push` from leaving the local machine when it detects a secret pattern.
  - **GITHUB_TOKEN permissions scoped per-job in `node-pty-prebuilds.yml`.** Workflow-level `contents: write` + `issues: write` block removed; `publish` job now gets `contents: write` only (for `softprops/action-gh-release` + the state-file commit push), `open-issue-on-failure` gets `issues: write` only (for failure-issue creation), and `precheck` + `build` matrix legs inherit the repo default `read`. `release.yml` already scoped this way (publish job only); `ci.yml` is read-only.
  - **All GitHub Actions SHA-pinned** across `ci.yml` (2 refs), `release.yml` (9 refs across 6 actions), `node-pty-prebuilds.yml` (10 refs across 6 actions), `docker-publish.yml.disabled` (1 ref). Format: `actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2`. Protects against a compromised action maintainer retagging a major (e.g., `v6`) to point at malicious code — a real supply-chain attack vector for the write-permission workflows. `dtolnay/rust-toolchain@stable` deliberately left as a rolling reference (upstream maintains it as a rolling alias).
  - **`.github/dependabot.yml` added** to track both `npm` and `github-actions` ecosystems weekly. Pairs with the SHA-pin step above — Dependabot keys on the `# vX.Y.Z` trailing comment to detect upstream tag movement and auto-PRs a SHA bump, solving the SHA-pin maintenance pain.

### Changed

- **GitHub Actions Node 24 migration — bumped all deprecated-Node-20 action pins ahead of the 2026-06-02 hard deadline.** Every workflow run since at least 2026-05-15 has emitted the deprecation banner: *"Actions will be forced to run with Node.js 24 by default starting June 2nd, 2026. Node.js 20 will be removed from the runner on September 16th, 2026."* Bumped pins across all three active workflow files (and the disabled docker-publish placeholder for consistency): `actions/checkout@v4` → `@v6` (latest stable v6.0.2; Node 24 default), `actions/setup-node@v4` → `@v6` (latest stable v6.4.0; Node 24 default), `actions/upload-artifact@v4` → `@v7` (latest stable v7.0.1; v7 made Node 24 the default), `actions/download-artifact@v4` → `@v8` (latest stable v8.0.1; v7 made Node 24 the default), `actions/github-script@v7` → `@v9` (latest stable v9.0.0; verified our inline `await github.rest.issues.create(...)` usage is unaffected by v9's ESM-only + `getOctokit` factory breaking changes — those only impact scripts that `require('@actions/github')` directly or redeclare `getOctokit` as a const/let), `softprops/action-gh-release@v2` → `@v3` (latest stable v3.0.0; v3 explicitly retargets the Node 24 Actions runtime). Total: 27 active references across `ci.yml`, `release.yml`, `node-pty-prebuilds.yml` plus 1 in `docker-publish.yml.disabled`. Untouched (not in deprecation banner): `actions/setup-dotnet@v4`, `dtolnay/rust-toolchain@stable`, `docker/login-action@v3`, `docker/build-push-action@v5`. Verified via post-merge CI run.

### Security

- **fast-uri bumped to 3.1.2 via package.json `overrides` — closes two Dependabot high-severity alerts on main.** Alerts: GHSA-q3j6-qgpj-74h6 (path traversal via percent-encoded dot segments, ≤3.1.0, fix in 3.1.1) and GHSA-v39h-62p7-jpjc (host confusion via percent-encoded authority delimiters, ≤3.1.1, fix in 3.1.2). fast-uri is a deeply nested transitive devDep (`mini-css-extract-plugin → schema-utils → ajv@8.18.0 → fast-uri@3.1.0`) — no direct dep to bump. Solution: top-level `overrides: { "fast-uri": "3.1.2" }` in package.json forces the nested ajv to resolve fast-uri to the patched version. ajv's `^3.0.0` range allows it. `npm ls fast-uri --all` confirms `fast-uri@3.1.2 overridden`; `npm audit` reports 0 vulnerabilities; vitest 684/684 + tsc clean.

### Fixed

- **node-pty prebuilds CI — VS 2026 detection on Windows x64 prior-LTS leg.** This morning's scheduled run (2026-05-18 12:33 UTC, workflow run 26033714786) failed at the `build (windows-latest, x64, prior)` matrix leg with `gyp ERR! find VS could not find a version of Visual Studio 2017 or newer to use`, blocking the entire publish job (other 9 legs passed). Auto-filed issue #5. Root cause: the `windows-latest` runner image was redirected to `windows-2025-vs2026` (MS-side migration, full cutover 2026-06-15) which ships VS 2026 (internal version 18) exclusively; Node 22 LTS ships npm 10.9.8 which bundles `node-gyp@11.5.0`, which only knows VS 2017/2019/2022 by hardcoded version mapping and rejects VS 2026 as `unknown version "undefined"`. **First fix attempt** (test run 26050335489, force-pushed away) installed `node-gyp@12.3.0` globally + set `npm_config_node_gyp` — failed identically because node-pty's install script is `node scripts/prebuild.js || node-gyp rebuild`, and `prebuild.js` does `require('node-gyp')` which resolves via Node module resolution to npm's BUNDLED node-gyp at `<npm-prefix>/node_modules/npm/node_modules/node-gyp` — globally-installed packages and `npm_config_node_gyp` are both bypassed by third-party scripts. **Working fix:** upgrade npm itself to `11.14.1` on Windows non-Alpine legs before the build step; npm 11.14.1 bundles `node-gyp@12.3.0` (added VS 2026 support in 12.1.0, 2025-11-12). Upgrading npm replaces the bundled node-gyp in place, so `require('node-gyp')` in third-party install scripts picks up the new version. Gating to all four Windows legs (x64 current+prior, arm64 current+prior) future-proofs the ARM runners against the same image migration whenever MS gets to them. Linux matrix legs use gcc/g++ via PATH and are unaffected.

## [0.1.25-beta.4] - 2026-05-15

### Fixed

- **scrcpy v4.0 wire-protocol port — device mirroring works again after the v4 dep update broke it.** Symptom: every device connection accepted, scrcpy-server started on device, log showed `Session ready: <Device> 2147483648x1920` (garbage width, height = the actual width). Canvas never sized correctly, persistent black screen, repeated `ECONNREFUSED 127.0.0.1:NNNNN` from browser retries. Confirmed by user that rolling the dep panel back to scrcpy-server 3.34 instantly restored mirroring. Root cause: scrcpy v4 added a 12-byte "session packet" wrapper between the codec ID and the width/height fields in the video socket header, AND shifted the media-packet flag bits down by one to make room for a new session-packet flag at MSB (verified against `scrcpy v4.0 Streamer.java`: `PACKET_FLAG_SESSION = 1L << 63`, `PACKET_FLAG_CONFIG = 1L << 62`, `PACKET_FLAG_KEY_FRAME = 1L << 61` — was `1L << 63 / 1L << 62` in v3). Our v3-era parser read 76 bytes, treated the session-packet flag word (`0x80000000`) as width and the actual width as height — exact match for the user's symptom. Two-file fix: `ScrcpyConnection.parseMetadata` now reads 80 bytes and pulls width @72 / height @76 with a sanity check on the session-packet flag MSB; `FrameReader` shifts CONFIG to bit 62 / KEY_FRAME to bit 61 / PTS mask to bits 0–60 and skips in-stream session packets (rotate/resize events the device sends — we don't expose rotation downstream today, deferred until requested). Fix-forward per the §17 binding decision: no version-branch backcompat for scrcpy 3.x; anyone who manually rolls back via dep panel after this lands will get a clear `expected session-packet flag MSB` error from `parseMetadata` rather than silent garbage.

- **Deliberate 2000ms hold before final event-loop drain on Ctrl+C** so PowerShell's prompt-redraw doesn't interleave with the shutdown log output. Real-shutdown now finishes in 10s of ms, which is faster than `npm.cmd`'s Ctrl+C acknowledgment to PowerShell — PS would redraw its prompt mid-output. A ref'd 2000ms `setTimeout` no-op in `exit()` holds the loop alive long enough for the prompt-redraw to settle on top of completed output. No correctness cost — the 10s watchdog backstops any real hang. Per user direction.

- **All `Stopping X` log lines now reach both console AND log file on Ctrl+C — child process is no longer killed mid-shutdown.** Real root cause finally pinned: `dev-supervisor.mjs` was calling `currentChild.kill(sig)` on receiving SIGINT, and per Node docs on Windows `subprocess.kill('SIGINT')` is `TerminateProcess` — equivalent to SIGKILL, not a graceful signal. The child was being nuked mid-`exit()` body. Evidence: even `fs.appendFileSync` writes to `ws-scrcpy-web.log` (synchronous!) didn't land — the log file showed nothing after `[AdbClient] daemon pre-warmed at startup` even though the console showed `[Server] Received signal SIGINT`. Console only got that one line because PowerShell's Ctrl+C had ALREADY broadcast CTRL_C_EVENT to the entire console process group, so the child's `process.on('SIGINT')` handler started running cleanly — TerminateProcess from the parallel supervisor.kill landed during the second log call. Fix: skip `currentChild.kill(sig)` on win32 in `dev-supervisor.mjs`. The console-group propagation already reaches the child gracefully; the supervisor's kill was both redundant (signal already delivered) AND destructive (it overrode the graceful handler mid-execution). POSIX path keeps `currentChild.kill(sig)` unchanged — real POSIX signals work properly. The 10s force-kill grace timer is unchanged on both platforms as the genuine-hang backstop. Earlier diagnostic instrumentation (active-handles dump from `36be51e`) + `setBlocking(true)` defensive layer (from `ef1abfc`) both stay, but the actual bug was upstream of where I was looking.

- **Server now exits cleanly within milliseconds on Ctrl+C — the 10s exit watchdog no longer fires.** Since b0dead3 (the 4-minute hang fix) the watchdog had been firing on EVERY shutdown, forcing `process.exit(0)` at the 10-second mark even on bare `npm start` with no browser, no devices, no interaction. Diagnosed by adding `process._getActiveHandles()` + `_getActiveRequests()` dump inside the watchdog `setTimeout` (which stays as permanent self-diagnosis for any future regression): every shutdown showed exactly 3 lingering handles — `ReadStream fd=0` (stdin) plus benign WriteStreams for fd=1/2. Root cause: the win32 `readline.createInterface({ input: process.stdin, output: process.stdout })` block in `index.ts` was a legacy workaround from pre-Node-10 days when `process.on('SIGINT')` didn't fire on Windows Ctrl+C. The `readline.createInterface()` call attaches keypress event listeners to `process.stdin`, putting it in flowing mode and ref'ing the ReadStream to the event loop — which prevented natural drain on `exit()` even after every service released cleanly. Modern Node (≥10, definitely 24.x) emits `process.on('SIGINT')` natively on Windows, so the readline workaround has been both unnecessary AND harmful. Removed: the `readline` import and the entire win32 `if` block. `process.on('SIGINT'/'SIGTERM')` (already registered two lines below the deleted block) is now the sole signal handler, and Ctrl+C still produces the expected `Received signal SIGINT` log line. Net: `Stopping...` lines fire, services release, event loop drains, process exits — typically within 50-100ms post-SIGINT instead of 10s.

- **adb daemon now has a single owner across the whole server — the multi-instance race that survived the detached-spawn fix is gone.** Detached spawn solved "the daemon dies when its parent's job object closes," but smoke against a fresh `npm start` still surfaced `could not read ok from ADB Server / failed to start daemon`. Watcher capture (`C:\Temp\watch-adb.ps1`) showed TWO `adb.exe` invocations 200 ms apart — one from the background pre-warm IIFE, one from `ControlCenter.init()`'s initial `adb devices` call — both forking fork-server children that fought for port 5037 and both lost. Root cause was architectural: seven `new AdbClient(...)` instances scattered across `src/server/` (scanAdb in `index.ts`, `ControlCenter`, `DeviceProbe`, `DeviceDiscoveryApi`, `Device`, `FilePushReader`, `AdbUtils`) each independently raced the daemon spawn, and the cross-module `adbReady.ts` coordination we added a day earlier was whack-a-mole — every new code path touching adb had to remember to `await whenAdbReady()`. New `src/server/AdbDaemonManager.ts` is a per-adbPath singleton that owns the daemon's full lifecycle: idle → starting → ready → killed state machine, single-flight `ensureReady()` (10 concurrent callers = 1 spawn), per-call `{ waitMs }` opt for scan-time short-circuit, `kill()` for clean shutdown, and a transparent delegation in `AdbClient` — every public method (`devices`, `shell`, `push`, `mdnsServices`, `connect`, `disconnect`, `forward`, etc.) awaits `daemon.ensureReady()` at the top before invoking adb. `AdbClient.startServer()` and `killServer()` become one-line delegates. `adbReady.ts` deleted; `ControlCenter.init()` no longer awaits `whenAdbReady()` because `adbClient.devices()` self-coordinates; `NetworkScanner`'s scan-time pre-warm dep is wired to `manager.ensureReady({ waitMs: 5_000 })` so a cold-install scan still gets the clean 5 s short-circuit instead of blocking for the manager's full 5 min budget. Net: future code paths that touch adb get daemon coordination for free; the multi-spawn race is impossible by construction.

- **adb daemon now actually survives our start-server call (Node job-object kill-on-close was murdering the daemon).** Visible since the parity branch landed: `[AdbClient] startup pre-warm failed: ... could not read ok from ADB Server / failed to start daemon` on every `npm start`, and `ControlCenter`'s 5 s poll continuously re-spawning `adb devices` only for both the parent and its would-be daemon child to die at the same millisecond every cycle (verified via `C:\Temp\watch-adb.ps1`). Root cause: Node's promisified-execFile on Windows places the spawned process in a job object with kill-on-job-close. When the parent `adb start-server` returns (or our 5 s timeout fires), the OS terminates every descendant in the job — including the `adb fork-server server` daemon child that's *supposed* to detach and survive. Manual `adb start-server` from PowerShell works fine because PowerShell doesn't use a job object. Fix: new `AdbClient.spawnDetachedDaemon()` replaces the promisified-execFile pathway for the start-server invocation only. Uses `spawn(adb, ['start-server'], { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })`. `detached: true` on Windows applies `CREATE_NEW_PROCESS_GROUP` which excludes the spawned process from Node's job, matching the PowerShell behavior. 30 s safety timeout (configurable via opts) replaces the old 5 s. `child.unref()` after exit so the daemon's stdio pipes don't pin our event loop.

- **Clean shutdown now tears down our adb daemon.** Server's `exit()` handler (SIGINT / SIGTERM path) calls `adbClient.killServer()` before service teardown. Fire-and-forget so the kill-server hang can't extend shutdown past the watchdog. The exit-75 restart path bypasses `exit()` entirely, so supervisor-driven restarts (Velopack apply, port change, dep update) still inherit a warm daemon as designed. Net: user-initiated quit owns the daemon's full lifecycle; restart-for-update keeps the existing handoff semantics.

- **`ControlCenter`'s initial device enumeration no longer races the startup adb daemon pre-warm.** On first page load against a cold daemon, `ControlCenter.init()`'s `adb devices` call fired ~2 s before the background `adbClient.startServer()` completed. Both adb invocations tried to spawn the daemon concurrently, neither won, and the user saw an empty device list followed by `[ControlCenter] ERROR Failed to list initial devices` in logs. The next 5 s poll cycle picked up devices cleanly (daemon was up by then), so the bug was a UX glitch rather than a functional break, but the noise in logs was real. New `src/server/adbReady.ts` module exposes a `whenAdbReady()` singleton promise; `index.ts` publishes the background pre-warm's outcome to it; `ControlCenter.init()` awaits it before the first adb call. Same class of race as the Quick Scan fix earlier today — different code path that wasn't covered.

- **Shutdown completes in seconds instead of minutes, and grandchildren get reaped.** Ctrl+C on `npm start` with a browser tab open produced a 4+ minute "Stopping..." hang followed by orphan Node processes surviving even a force-exit. Four layered fixes: (1) `WebSocketServer.release()` now `terminate()`s every open client after `wss.close()` — the `ws` library has no built-in timeout on close-handshake acknowledgement, so a single live browser tab pinned the server alive indefinitely. (2) `HttpServer.release()` now calls `server.closeAllConnections()` after `server.close()` — drops HTTP keepalive sockets immediately. (3) Server `exit()` handler gained a 10 s `setTimeout` watchdog that force-calls `process.exit(0)` if anything still pins the event loop. (4) Dev supervisor's signal handler races a 10 s grace period against `currentChild.kill(sig)`; if the child hasn't exited by then, `taskkill /T /F` (Windows) or `process.kill(-pid, 'SIGKILL')` (Linux) nukes the entire process tree including any orphaned node-pty workers or scrcpy helpers. A second Ctrl+C during the grace window fast-tracks straight to the force-kill. Also fixed the long-standing "Received signal undefined" log line — readline's SIGINT event doesn't pass the signal name to the handler; the registration is now wrapped to pass it literally.

- **`.restart` marker now lands where the launcher reads it (latent restart-mechanism bug, predates Phase 1).** Server-side `DependencyManager.requestRestart` and `ConfigApi`'s port-change handler both wrote the marker to `<depsPath>/.restart`, while the launcher's supervisor (`paths.rs:70`) read from `<dataRoot>/.restart`. The two paths never matched — the marker mechanism was silently dead code in install (and dev). Today exit-code-75 alone carries the restart signal via `supervisor.rs:36-45 decide_restart`'s OR semantics, masking the bug. Latent failure mode (now fixed): a server crash that committed `.restart` mid-config-write but didn't exit cleanly with 75 — launcher would never see the marker, no restart, manual recovery only. Fix: new `Config.dataRoot` + `Config.restartMarkerPath` getters; `DependencyManager` constructor takes an optional `{ restartMarkerPath }` opts arg; production wiring in `index.ts` routes the marker write through `Config.restartMarkerPath` so server and launcher agree.

- **Dev-mode port change in Settings now actually restarts the server, matching install behavior.** Previously, `npm start` was a bare `node dist/index.js` — when the server emitted `process.exit(75)` to request a restart (port change, dependency update, etc.), Node died, the browser redirect landed on a dead port, and you had to re-run `npm start` manually. New `scripts/dev-supervisor.mjs` mirrors `launcher/src/supervisor.rs:36-45`'s `decide_restart` semantics (marker-OR-exit-75) and respawns the server child. Crash-loop protection bails on >3 respawns in 10 s. SIGINT/SIGTERM forward to the child cleanly. `npm start` now invokes the supervisor; `npm run start:no-supervisor` is an escape hatch for debugging the server directly.

- **Dev-mode Node now resolves through `<repo>/seed/node/` (sha256-pinned v24.15.0) instead of the user's system Node.** The `prestart` chain invokes `scripts/fetch-node.mjs` to guarantee `seed/node/node.exe` exists, and the new dev supervisor follows `launcher/src/spawn.rs::resolve_node_with` priority exactly: `<dataRoot>/dependencies/node/node.exe` first, `<repo>/seed/node/node.exe` second, no system-Node fallback. Closes a Local-Dependencies-Only gap in dev that was supposed to have been cleaned up earlier this year but had no enforcement; the `pre-edit-local-deps-verify` hook caught this branch's initial draft re-introducing `process.execPath` as a fallback, exactly the safety-net behavior the hook was added for.

- **adb daemon-init race on Quick Scan against a cold daemon.** Symptom: clicking Quick Scan immediately after a fresh server start spawned multiple `adb.exe` processes which then all disappeared from Task Manager, leaving errors like `protocol fault: (couldn't read status): connection reset` and `daemon not running; starting now at tcp:5037 — timeout`. Root cause: `NetworkScanner` fires `concurrency` (default 16) parallel workers, each of which immediately invokes `adb devices`. With no daemon on port 5037, all N clients race to spawn one — losers report connection-reset, winning clients' daemon children get orphaned, no daemon survives, next scan repeats the race. Race only surfaced after the 2026-05-14 dev/install layout parity work because a wiped ProgramData was the first time anyone hit Quick Scan with no warm daemon already present. Fix: new `AdbClient.startServer()` with bounded wait-for-binary; called once at server startup (5-minute budget for cold first-install autoInstall) and again as a scan-time pre-warm (5-second budget for transient races) before `NetworkScanner` dispatches workers. Pre-warm failure surfaces as a single `scan.error` with a clear "wait for first-run setup to finish" message instead of N parallel spawn failures.

- **scrcpy-server "Update available" loop — clicking Update appeared to succeed but the row flipped back to "Update available" on the next "check for updates" click, forever.** Root cause: `DependencyDefinitions.scrcpy-server.checkInstalled` returned the bundled `SERVER_VERSION` constant (`'3.3.4'`) whenever the JAR existed on disk, regardless of what version the JAR actually was. The updater download did succeed end-to-end and replaced the on-disk binary; the "Update available" UI was a version-detection lie, not a failed install. New `src/server/scrcpyServerVersion.ts` persists the installed version to `<deps>/scrcpy-server/.version` after each updater install; `checkInstalled` reads from the marker, falling back to `SERVER_VERSION` only for legacy seed installs that predate the marker. `DependencyManager.update` now re-runs `checkInstalled` after install so in-memory state is always sourced from disk — no more drift between the post-update and post-check code paths. **Recovery for users currently in the broken state:** the UI will show "Update available" once after this hotfix lands; clicking Update once more will write the marker and the loop will not return.
- **scrcpy-server wire-protocol arg now matches the actual installed version.** `DeviceProbe.ts` and `ScrcpyConnection.ts` previously passed the bundled `SERVER_VERSION` constant to `app_process / com.genymobile.scrcpy.Server <version>` on every device connection. After an updater download, the constant no longer matched the on-disk JAR, and scrcpy's device-side version check would silently reject the handshake. Both call sites now resolve the version from the same on-disk marker that drives the dep-panel display, so the host's version arg always matches the JAR pushed to the device. (Note: this exposes scrcpy v3 → v4 wire-protocol differences if any exist; we'll deal with porting work if and when device connections actually break.)
- **Shell button greyed out when running from source via `npm start`.** Dev mode (`npm run build && node dist/index.js`) skipped the seed-staging step that `scripts/stage-publish.mjs` performs in CI, so `seed/node-pty-pkg/node_modules/` never got created. `NodePtyResolver.readSeedNodePtyVersion()` returned `null`, the resolver short-circuited with `reason: 'no-seed-package'`, `/api/capabilities` reported `shell: false`, and `DeviceTracker.applyShellCapability` dimmed the link with the (misleading) "no node-pty prebuilt matches your Node version" tooltip. Packaged installs were unaffected because CI runs `stage-publish.mjs` before `vpk pack`. New `scripts/stage-seed-node-pty.mjs` idempotently copies `node_modules/{node-pty,node-addon-api}` into `seed/node-pty-pkg/node_modules/`; wired into `npm start` via a `prestart` hook so `npm start` now stages the seed before launching the server.

### Changed

- `resolveDependenciesPath` now returns `<dataRoot>/dependencies/` on Windows regardless of dev-tell, matching `launcher/src/paths.rs` and the MSI install layout. Dev mode (`npm start` from repo) now reads/writes the same ProgramData state an installed app does. Linux dev unchanged. ([design spec](docs/superpowers/specs/2026-05-14-dev-install-layout-parity-design.md))
- `prestart` chain now also stages `assets/scrcpy-server` into `seed/scrcpy-server/` so `DependencyManager.promoteSeedScrcpyServer` works identically in dev and install — no first-launch network fetch for scrcpy-server when running from repo.
- **Code-signing path: SignPath Foundation declined the application.** SignPath cited project-awareness criteria — the OSS program looks for visible community engagement (GitHub stars, Reddit mentions, and similar signals) before issuing certificates, and ws-scrcpy-web didn't clear that bar. All SignPath references have been removed from public-facing docs (`README.md`, `PRIVACY.md`, `docs/RELEASING.md`, `RELEASE_NOTES.md`), and the auto-prepended SignPath credit has been stripped from CI-generated release notes (`scripts/extract-changelog.mjs`). The dormant `signpath/github-action-submit-signing-request@v2` steps in `.github/workflows/release.yml` have been commented out and left as scaffolding for a future signer; the `prepare` job's signing-mode gate now keys on a generic `SIGNING_API_TOKEN` secret so wiring a successor in won't require renaming. Historical design docs (`docs/plans/sp3-p6-contracts.md`, `docs/specs/2026-04-26-sp3-velopack-installer.md`, `docs/superpowers/plans/2026-04-28-program-files-migration.md`) carry top-of-file retraction headers pointing readers here; their bodies are otherwise preserved as point-in-time snapshots. Existing GitHub Releases bodies (v0.1.4 → v0.1.25-beta.3) had their SignPath credit + review-pending notice replaced with the same disclosure. Release artifacts remain **unsigned** for now — an alternative code-signing path is under evaluation. Integrity continues to be verifiable via the `SHA256SUMS` file shipped with each release; the `--unsigned` warning block in release notes has been rephrased to drop the SignPath name.

### Removed

- Pre-Phase-1 orphan `<repo>/config.json` (never read on Windows since dataRoot migration).

### Repository

- **Git history rewritten on `main`** to remove `Co-Authored-By: ... <noreply@anthropic.com>` trailers from 14 commits across the v0.1.20 → v0.1.21 packaging arc. The trailers were causing GitHub to credit Anthropic's noreply account as a project contributor. All commit SHAs from `be1b4f5` (v0.1.20) forward have changed; tags v0.1.20 through v0.1.25-beta.3 inclusive were re-pointed and force-pushed. Tags v0.1.10–v0.1.19 and `node-pty-prebuilds-*` are unchanged. Existing clones must `git fetch --tags` and `git reset --hard origin/main` (or re-clone) — `git pull` will not work from any clone whose `main` is at a pre-rewrite SHA.

## [0.1.25-beta.3] - 2026-04-30

### Added

- Admin-confirmation modal before clicking Install Service / Uninstall Service in the Settings panel. Sets the expectation that a Windows UAC prompt is coming and gives a clean cancel path before the OS dialog fires.

### Fixed

- **Service uninstall no longer silently fails for non-admin users.** Previously the backend's LocalSystem context would fall through to a direct `runElevated` call after the user-session handoff failed, but PowerShell `Start-Process -Verb RunAs` from LocalSystem has no interactive desktop to show the UAC prompt — the elevation silently never happened and the frontend's "uninstalling…" button hung. Backend now returns a clear 503 + actionable error instead.
- Service-mode failure responses now carry a `reason` discriminator and the frontend maps each variant to a specific actionable message (e.g., "Couldn't reach the user session. Make sure ws-scrcpy-web is running for your user, then try again.") instead of surfacing raw error strings.
- The "uninstalling…" button on the Settings modal now swaps to "still waiting for user session…" after 5 seconds so the user can tell the long handoff path is still working, not frozen.
- Tightened the gap between the home-page top-right controls and the connected-devices section's outer top border (page-container `padding-top` 64px → 56px).

## [0.1.25-beta.2] - 2026-04-30

### Fixed

- **HKLM\Run tray migration now works on upgrade from v0.1.24** — v0.1.25-beta.1's HKLM-Run write only fired from the live "install service" UI path; the Velopack `--veloapp-updated` hook just restarted the service without touching tray registration, so v0.1.24 → v0.1.25-beta.1 upgrades left HKLM unwritten and non-admin users got no tray icon at logon. The launcher now self-heals HKLM idempotently on every service start (LocalSystem context, no UAC), so the first service restart after upgrade completes the migration automatically.
- **No more duplicate tray icons in admin's session post-migration** — added a per-session single-instance mutex (`Local\WsScrcpyWebTray-SingleInstance`) to the standalone tray helper. The mutex winner also best-effort deletes the stale HKCU\Run\WsScrcpyWebTray value left over from v0.1.24, so subsequent logons spawn exactly one tray.

### Changed

- `scripts/bump-version.mjs` now correctly relocates `[Unreleased]` body content into the new `[<version>] - DATE` section (instead of leaving it under `[Unreleased]` with an empty new-version header), and strips leading blank lines to avoid a doubled blank between the heading and the first body line.
- `launcher` registry-cleanup helpers (`unregister_tray_run_key`, `cleanup_stale_hkcu_tray_run_key`) now use `reg.exe` exit-code parsing (locale-stable) instead of English-only stderr substring matching. Non-English Windows installs no longer silently fail the cleanup path.
- Home-page top padding (`64px`) so the fixed-position controls cluster (settings/theme/update) doesn't visually crowd the connected-devices section.

### Removed

- Dead `ARGS_STRING` export from `src/common/Constants.ts` (no callers since SP2 scrcpy-server v3 rewrite). `SERVER_PORT` retained — still used as a sentinel by `DeviceTracker` and `StreamClientScrcpy`.

## [0.1.25-beta.1] - 2026-04-30

### Fixed

- **Service-mode tray helper now registers under `HKLM\...\Run` instead of `HKCU\...\Run`**, so every user logging into the machine receives a tray icon at logon — not only the installing admin. Upgrades from v0.1.24 also clean up the stale HKCU value for the installing admin to avoid a one-time double-spawn at next admin logon.

## [0.1.24] - 2026-04-30

First stable v0.1.24 cut, rolling up the eight-beta investigation. Headline fix: **Theory D** — the service-uninstall flow no longer fails with `ERROR_ACCESS_DENIED`. After three layered Win32 attempts (privilege flips, session enumeration, primary-token forcing) all failed across betas 1–3, beta.8 dropped the cross-session WTS spawn entirely in favor of file-marker IPC: the LocalSystem service-Node writes a JSON marker under `<dataRoot>/control/`, and a polling thread inside the user-session tray helper detects it and natively spawns the launcher in its own session. Both v0.1.23 known-issues bug 1 (failed handoff) and bug B (Path B no-tray-after-fallback) are closed by this architectural change, end-to-end VM-verified. Also closed: the tray-icon-click went to a stale port after mode swaps — the tray now re-reads `config.json::webPort` on every click via a closure-injected URL provider.

Other v0.1.24 work folded into this stable: Settings modal layout overhaul (fixed-width 20rem labels + 16rem controls tracks, no reflow on dynamic content), four shorter user-facing strings to fit the new tracks, iframe theme bridge (`window.WsScrcpy.*` postMessage API for embedding hosts), MutationObserver-based theme toggle button visual sync, logs consolidation round 2 (`ws-scrcpy-web.log` and `service.log` joined `launcher.log` + `server.log` under `<dataRoot>/logs/`).

**Migration:** v0.1.23 stable users and v0.1.24-beta.{1..8} users can in-app update to v0.1.24 normally — no fresh-install required. The Theory D handoff path activates automatically on the first service uninstall attempt after upgrading. Old `<dataRoot>/dependencies/service.log` and `<dataRoot>/ws-scrcpy-web.log` files (pre-beta.7 paths) may linger; safe to delete by hand.

### Known issues (carried into v0.1.25)

- **Multi-user port drift in service mode (§1c bug 2).** User A flips to service on port 8004, logs out, User B logs in → tray-click opens a dead port because the actual service moved to 8005 and `config.json` wasn't re-persisted. Still deferred — needs a focused multi-user-VM diagnostic session with `handle.exe` / Procmon to answer "why does the service-Node restart on User B login at all?" Static code reading can't reach the root cause.
- **Theory D fallback retains the v0.1.23 broken-uninstall UX in the no-tray-helper edge case.** If the user has explicitly killed the standalone tray helper (or it never started), the marker write succeeds but no consumer picks it up; ServiceApi falls through to direct uninstall after the 30s discover timeout, browser sees "couldn't reach server." Same UX as v0.1.23, just much rarer to hit. Not tracked separately.
- **Cosmetic node-pty `AttachConsole failed` errors in server.log when opening shell sessions.** Functionally harmless — actual shell I/O works; these come from node-pty's internal `conpty_console_list_agent.js` helper failing to attach to our hidden-subsystem parent process. Tracked as todo §9a for a future seed-patch or upstream fix.

## [0.1.24-beta.8] - 2026-04-30

### Fixed

- **Service uninstall handoff — file-marker IPC replaces the broken cross-session WTS spawn (Theory D).** v0.1.24-beta.{1,2,3} attempted three layered fixes for the WTS handoff (privilege flips, session enumeration, primary-token forcing) and all failed with `ERROR_ACCESS_DENIED` when invoking `CreateProcessAsUserW` from the LocalSystem service-Node. Theory D drops the cross-session spawn entirely. The service-Node now writes a JSON marker at `<dataRoot>/control/uninstall-handoff.json`; a polling thread inside the user-session tray helper detects it and natively spawns the launcher in its own session — no `WTSQueryUserToken`, no `CreateProcessAsUserW`, no privilege hunting. End-to-end VM-verified on 2026-04-30: install → uninstall → install → uninstall completes smoothly with the correct tray icon at every step.
- **Tray icon URL no longer goes stale across mode swaps.** Pre-fix, the tray helper read `config.json::webPort` once at startup and cached the resulting URL; clicking the tray after a service-uninstall handoff opened the dead service port instead of the new local port. The tray now re-reads `config.json` on every click via a closure-injected URL provider, so `localhost:<port>` always points at whichever launcher is currently bound. Same fix in the launcher's in-process tray (local mode) and the standalone tray helper (service mode).

### Changed

- **Settings modal layout — fixed-width tracks so dynamic content never reflows the controls column.** Modal width restored to the original 640px cap. Labels track is now a fixed 20rem (down from 1fr greedy) and the controls track is widened to 16rem (up from 200px) so the longest steady-state button text ("not installed — install?") fits without wrapping. Column gap is 1rem with a small whitespace track on the right of the controls — the controls column now sits a touch left of the modal's right edge instead of hugging it. Result: changing button states (install ↔ uninstall, status messages, version strings) no longer shift the column horizontally.
- **Settings modal — shortened a handful of long strings** that were overflowing the new fixed-width tracks: the post-port-change save status `server restarting on new port. redirecting in a moment…` is now `restarting → redirecting…`; the apply-update button drops the redundant word ("apply update vX.Y.Z" → "apply vX.Y.Z"); the install/uninstall transition states adopt a parens style ("switching to service mode…" → "→ service mode (install)…", same shape for the user-mode-uninstall variant).

## [0.1.24-beta.7] - 2026-04-29

### Changed

- **Logs consolidation, round 2 — `ws-scrcpy-web.log` and `service.log` join the others under `<dataRoot>/logs/`.** v0.1.24-beta.3 moved `launcher.log` and `server.log` to `<dataRoot>/logs/` but missed two more log files: the Node app Logger's output (`ws-scrcpy-web.log`, formerly at `<dataRoot>/`) and Servy's service-mode stdio capture (`service.log`, formerly at `<dataRoot>/dependencies/`). Both now live in `<dataRoot>/logs/` alongside the others. `Logger.ts::resolveLogFilePath` updated to return `<dataRoot>/logs/ws-scrcpy-web.log`; `ServiceApi.ts` builds `<dataRoot>/logs/service.log` and `mkdirSync`s the directory before passing the path to Servy. Single source of truth for "where do logs live": `C:\ProgramData\WsScrcpyWeb\logs\`. Existing installs may have stale files at the old paths — safe to delete by hand.
- **Settings modal controls column trimmed 260px → 200px.** Visual feedback on v0.1.24-beta.3 showed ~60px of unused space at the right edge of the controls column. The widest button ("running — uninstall?", ~190px) now sits ~10–20px from the right edge with comfortable slack for future text growth, while the labels column gains the freed pixels for less wrapping.

## [0.1.24-beta.6] - 2026-04-29

### Fixed

- The in-app theme toggle button's icon and tooltip now stay in sync
  with the current theme regardless of how it changed. Previously the
  button only updated its own visual state when clicked directly, so
  it went stale when the theme was set via the iframe theme bridge or
  via `WsScrcpy.setTheme(...)`. Implemented via a `MutationObserver`
  on `<html data-theme>` with self-disconnect when the button is
  removed from the DOM (e.g., modal close).

## [0.1.24-beta.5] - 2026-04-29

> v0.1.24-beta.4 was a failed re-cut (release CI rejected the tag because
> `Cargo.toml` wasn't bumped alongside `package.json`). v0.1.24-beta.5 is
> the actual release of this content.

### Added

- **Iframe theme bridge** — public theme-embed API on `window.WsScrcpy.*`:
  `getTheme`, `setTheme`, `installThemeEmbedListener`, `notifyThemeReady`,
  `notifyThemeChanged`. Lets a host page embedding ws-scrcpy-web in an iframe
  sync dark/light theme via origin-validated `postMessage` (namespaced
  `ws-scrcpy-web:`). Auto-installed on page load; standalone usage is a no-op.
- README: new *Embedding: theme bridge* section documenting the protocol,
  host integration, race-condition mitigations, and `allowedOrigins` security.

### Changed

- `ThemeToggle` now uses the shared theme-embed helpers (single source of
  truth) and posts `theme-changed` to the parent on click. Standalone
  behavior unchanged.
- **Logs consolidated under `<dataRoot>/logs/`.** Both `launcher.log` and `server.log` now live in `C:\ProgramData\WsScrcpyWeb\logs\`. Pre-beta.3, `launcher.log` lived directly in dataRoot (`<dataRoot>\ws-scrcpy-web-launcher.log`) and `server.log` was tucked under `<dataRoot>\dependencies\server.log` — annoying for navigation and unintuitive. The launcher now creates `<dataRoot>\logs\` as needed and writes both files there. `spawn::spawn_server` signature gained a `data_root` parameter so it can resolve the new server.log path. Old log files at the legacy paths can be deleted by hand on existing installs; they're not auto-migrated. Velopack's own update logs continue to land where Velopack puts them (install root) — `vpk` doesn't expose a redirect.
- **Settings modal copy tightened.** Four label rewrites to fit cleanly in the v0.1.24-beta.1 widened label column without redundant words: "installs/uninstalls the server as an always-on service" → "installs/uninstalls server service"; "saving will restart the server and redirect to the new port" → "save restarts & redirects to new port"; "last checked Nm ago — up to date (vX.Y.Z)" → "up to date: vX.Y.Z" (drops the relative-timestamp prefix and parenthesized version); "vX.Y.Z ready to apply" → "update: vX.Y.Z". Removed the now-unused `formatRelative` helper.
- **Update-status text turns green when an update is ready.** New `.settings-status-ready` CSS class (#4caf50, mirrors the `.settings-btn-ready` button outline color) toggled on the status `<p>` when `s.status === 'ready'`. Pairs the description text color with the action button — green "update: vX.Y.Z" beside green "apply update" button, default muted "up to date: vX.Y.Z" beside blue "check for updates now". Mirrors how `.settings-status-error` already toggles red.

### Fixed

- **Service uninstall — `CreateProcessAsUserW` privileges + window station (§1c bug 1, layer 3).** v0.1.24-beta.2 fixed the session lookup (`WTSEnumerateSessions` correctly resolved testdude → session 1) and `WTSQueryUserToken` then succeeded, but `CreateProcessAsUserW` failed with `ERROR_ACCESS_DENIED` (HRESULT 0x80070005). Two root causes: (a) `CreateProcessAsUserW` requires `SE_ASSIGNPRIMARYTOKEN_NAME` and `SE_INCREASE_QUOTA_NAME` to be ENABLED on the caller's token (LocalSystem holds both but Servy hosts them disabled, same pattern as `SE_TCB_NAME` in beta.1); (b) the spawned process needs an explicit `lpDesktop = "winsta0\\default"` in `STARTUPINFOW`, otherwise it inherits the service's session-0 window station which the user's token has no access to. Refactored the privilege-enable code into a generic `enable_privilege` helper + `enable_cross_session_spawn_privileges` that flips all three privileges in one shot. Added the `lpDesktop` assignment.
- **Service uninstall WTS handoff — Hyper-V Enhanced Session / RDP regression (§1c bug 1, layer 2).** v0.1.24-beta.1 added `SE_TCB_NAME` enable-before-`WTSQueryUserToken` thinking the privilege was the issue. VM smoke test on v0.1.24-beta.1 proved otherwise: privilege flip succeeded but `WTSQueryUserToken` still failed with `ERROR_NO_TOKEN` (HRESULT 0x800703F0). Root cause: `WTSGetActiveConsoleSessionId()` returns the **physical console** session, not the user's interactive session. On Hyper-V Enhanced Session Mode (RDP-like VM access), real RDP, or any VDI scenario, the physical console is empty (`Conn` state, no logged-on user) while the user is in a different session. `qwinsta` on the VM confirmed: testdude was in session 1 but `WTSGetActiveConsoleSessionId` returned 3 (the empty console). Fix: replaced `WTSGetActiveConsoleSessionId` with a `WTSEnumerateSessionsW` walk that filters by `State == WTSActive` AND non-empty `WTSUserName`, returning the first matching session. Falls back to `WTSGetActiveConsoleSessionId` only if enumeration finds nothing (preserves existing behavior on bare-metal single-user installs). The SE_TCB_NAME enable from beta.1 is kept — still required, just not sufficient.

## [0.1.24-beta.3] - 2026-04-29

## [0.1.24-beta.2] - 2026-04-29

## [0.1.24-beta.1] - 2026-04-29

### Fixed

- **Service uninstall WTS handoff (§1c bug 1, first attempt — superseded by [Unreleased] / beta.2).** `spawn_in_active_user_session` now explicitly enables `SE_TCB_NAME` ("Act as part of the operating system") on the launcher's process token via `AdjustTokenPrivileges` before calling `WTSQueryUserToken`. Hypothesis was that Servy's service token had the privilege present-but-disabled. **The privilege flip succeeded on the VM but the WTS call still failed** — the actual root cause was different (see [Unreleased] / beta.2). The privilege enable is still kept since it's required for Servy hardening, just not sufficient on its own.

### Changed

- **Settings modal label column widened.** Grid layout changed from `[labels] 40% [controls] 1fr` to `[labels] 1fr [controls] 260px`. The 260px controls column reserves space for the widest button ("not installed — install?", ~210px) plus ~50px of slack for future button-text growth. Frees up ~90px for the labels column at the modal's max width, reducing description wrapping. All other modals untouched.

## [0.1.23] - 2026-04-29

First stable v0.1.23 cut, rolling up everything from the 26-beta investigation. Eight architectural fixes in the in-app updater chain (install-root ACL via UAC, Job Object kill-on-close release, Rust SDK auto-apply disable, adb pre-apply hygiene + cwd anchoring, node-pty Local-Dependencies-Only restructure with `process.getBuiltinModule` runtime require, Logger to dataRoot, UI uninstall-flow modal race code path), Settings modal redesign (label-control grid layout, dual-purpose apply-update button), CI prerelease flag drop, and migration documentation. See per-beta entries below for the diagnosis chain.

**Migration:** users on v0.1.21 / v0.1.22 / v0.1.23-beta.{1..6} must fresh-install the v0.1.23 MSI — the in-app updater on those builds is broken at varying severity and won't reach v0.1.23 by clicking apply. v0.1.23-beta.7+ users can in-app update normally. See `docs/PROGRAMDATA-MIGRATION.md` for the per-bug fix-version table.

### Known issues (carried into v0.1.24)

- **Service uninstall flow doesn't redirect cleanly back to local mode.** Clicking "uninstall service" from the service-mode Settings UI shows "couldn't reach server" with a retry button rather than redirecting to the local launcher. The service WILL still uninstall correctly. Root cause traced to the WTS handoff (`spawn_user_launcher_command`) failing with exit code 4 in ~1ms — likely `WTSQueryUserToken` returning `ERROR_PRIVILEGE_NOT_HELD` because Servy hosts the service without `SE_TCB_NAME` explicitly enabled in the process token. Fix direction: `AdjustTokenPrivileges` before `WTSQueryUserToken` in `launcher/src/user_session_spawn.rs`.
- **Local tray doesn't restore after a service uninstall.** Even after the service is fully uninstalled (via the Settings → "stopped — uninstall?" button after a failed first attempt), the local-mode tray icon doesn't appear. Workaround: close `ws-scrcpy-web-launcher.exe` from Task Manager and relaunch via the Start menu shortcut. Root cause: launcher's `is_service_mode` decision is made once at startup; the in-launcher tray thread doesn't spawn dynamically when `installMode` flips post-uninstall.
- **Multi-user port drift in service mode (§1c bug 2).** User A flips to service on port 8004, logs out, User B logs in → tray-click opens a dead port because the actual service moved to 8005 and `config.json` wasn't re-persisted. Needs a focused multi-user-VM diagnostic session with `handle.exe` / Procmon to root-cause the unexpected service restart at User B login. Hypothesis: launcher's port-collision auto-shift fires during a User-B-login-time service restart, `Config.reconcileWebPort` updates in-memory but doesn't persist.
- **Cosmetic node-pty `AttachConsole failed` errors in server.log when opening shell sessions.** Functionally harmless — actual shell I/O works; these come from node-pty's internal `conpty_console_list_agent.js` helper failing to attach to our hidden-subsystem parent process. Tracked as todo §9a for a future seed-patch or upstream fix.

## [0.1.23-beta.26] - 2026-04-29

### Fixed

- **Service uninstall flow no longer leaves user stranded with the wrong modal + no tray (item 6 §1c bug 1).** Three sub-fixes:
  - **(1.a)** `maybeShowWelcomeModal` early-returns when `?resume=uninstall-service` is in the URL. Pre-fix it raced against the in-flight uninstall, fetching `/api/config` while installMode still showed the OUTGOING service mode, mounting `ServiceFirstRunModal`, native `<dialog>` stacking covered the uninstall progress overlay.
  - **(1.b)** `maybeResumeUninstall` reloads the page on success rather than just removing the overlay. The reload re-runs `maybeShowWelcomeModal` cleanly against the now-canonical `installMode='user'` and picks the right modal.
  - **(1.c)** `ServiceApi.handoffUninstallToUserSession` passes `['--local-takeover']` to the WTS-spawned user-session launcher. `main.rs` detects the flag and forces `is_service_mode=false` even though `config.json` still reads `'user-service'` at spawn time (the resume flow flips it AFTER the uninstall completes). New launcher boots with local tray as expected — pre-fix the user was left with no tray + an orphan browser tab they didn't click into.

### Notes

- **Item 6 §1c bug 3 (HKCU vs HKLM Run-key) resolved as no-code-change.** Audit confirmed `HKCU\...\Run\WsScrcpyWebTray` is the only Run-key write site and HKLM was never wired in any layer (no MSI customization, no Velopack hook, no Servy autostart). Per-user HKCU is the correct design — User A installed the service for themselves; their tray represents their UI affordance. Other users who launch via the Public desktop shortcut (Velopack default) get their own tray spawned for their session.
- **Item 6 §1c bug 2 (multi-user port drift) deferred to a future multi-user-VM diagnostic session.** Root cause requires live observation with `handle.exe` / Procmon at User B login time. Static code reading can't answer "why does the service-Node restart on User B login at all?" — fixing without that risks treating a symptom (port drift) without addressing the cause.

## [0.1.23-beta.25] - 2026-04-29

### Fixed

- **`ws-scrcpy-web.log` now lives at `<dataRoot>/ws-scrcpy-web.log` instead of `<installRoot>/current/ws-scrcpy-web.log`.** The previous location was inside the Velopack-swappable image, so every in-app update wiped accumulated logs (and made post-update troubleshooting harder). Path now resolves via `path.dirname(DEPS_PATH)` — the launcher already sets `DEPS_PATH=<dataRoot>/dependencies/`, so dataRoot derivation is consistent with everything else. Logger also adds an idempotent `mkdirSync` for the log directory so first-launch races don't lose lines.

### Known issues

- **Cosmetic node-pty AttachConsole errors in server.log when opening a shell session.** Originate from node-pty's internal `conpty_console_list_agent.js` helper which `fork()`s a Node child to enumerate processes attached to the conpty session and fails because our parent Node process runs without a console window (Windows hidden subsystem launcher). The error dumps to the agent's stderr which bubbles into server.log. **Functionally harmless** — actual shell I/O goes through a different node-pty path that works fine; commands like `dumpsys` execute correctly. Fixing requires either a node-pty patch or stripping the agent from the seed; deferred until we either expose a "list processes" feature or upstream fixes it.

## [0.1.23-beta.24] - 2026-04-29

No code changes. In-app update target for beta.23 — verifies node-pty actually loads from the dataRoot package across the upgrade boundary, not just at fresh install. Shell button on connected devices should be functional in both beta.23 and beta.24 (was disabled in beta.19–beta.22 due to the `(void 0)` resolver bug).

## [0.1.23-beta.23] - 2026-04-29

### Fixed

- **node-pty resolver actually loads (item 5 fix).** beta.19's Local-Dependencies-Only restructure shipped with a webpack-mangled require call: `import { createRequire } from 'module'` got tree-shaken to `void 0` and the bundled output had `(void 0)('node-pty')`. Resolver always failed with `(void 0) is not a function`, the shell button stayed disabled across a clean install + upgrade. Switched to `process.getBuiltinModule('module').createRequire(marker)('node-pty')` — webpack does not analyze `process.*` expressions, so the chain survives bundling untouched. `process.getBuiltinModule` is Node 22+, available in our shipped Node 24. Bare `require(absolutePath)` was also tried but webpack rewrote it into `__webpack_require__(<id>)` for a context-bundle and returned the wrong module; the process.getBuiltinModule path is the only escape that stays clean.

## [0.1.23-beta.22] - 2026-04-29

No code changes. In-app update target for beta.21 so the round-3 Settings modal layout (label-control rows everywhere, no centered footers) can be exercised via the in-app updater.

## [0.1.23-beta.21] - 2026-04-29

### Changed

- **Settings modal — every section unified as label-control rows.** Per UX feedback round 3: dropped the centered-footer pattern (buttons drifted to a different x-axis than the inputs above them). Every setting is now one row: description on the left (wraps as needed), control on the right (left-aligned in the right column). Updates section's status text rides along as the action row's label; Server section's redirect-explainer is the save-row label; Service section restored the informational blurb "installs/uninstalls the server as an always-on service" as label with the state-aware action button as control. Service install button now uses the green `.settings-btn-ready` styling to mirror the apply-update affordance; uninstall stays red.

## [0.1.23-beta.20] - 2026-04-29

No code changes. In-app update target for beta.19 — verifies the new node-pty Local-Dependencies-Only flow holds across an in-app upgrade: beta.19's runtime should already be loading from `<dataRoot>/dependencies/node-pty/`; applying beta.20 should leave that dataRoot package untouched (Velopack swaps `current/` only) and node-pty should continue to load cleanly post-upgrade.

## [0.1.23-beta.19] - 2026-04-29

### Changed

- **node-pty now loaded from `<dataRoot>/dependencies/node-pty/` exclusively (item 5 / Approach C).** Architectural compliance with Local-Dependencies-Only: the bundled image no longer ships node-pty in `<installRoot>/current/node_modules/`. At build time, `stage-publish.mjs` relocates node-pty + node-addon-api from `publish/node_modules/` to `publish/seed/node-pty-pkg/node_modules/`. At runtime, `NodePtyResolver.copySeedToDataRoot()` stages the seed to `<dataRoot>/dependencies/node-pty/v<version>-<host>/` on first launch, and all loads go through `createRequire(<dataRoot>/.../_marker)('node-pty')` — bypassing Node's default resolution that would otherwise look at the install image. Cache-miss path (Node ABI changes after auto-update) downloads the matching prebuilt tarball and overlays `pty.node` into the existing dataRoot package without writing to the install root. Pre-Approach-C, beta.7's icacls grant masked the architectural violation (the runtime copy could succeed by writing to install root); now the install root is genuinely read-only at runtime.

## [0.1.23-beta.18] - 2026-04-29

No code changes. In-app update target for beta.17 so the redesigned Settings → Updates UI can exercise its "apply update" button end-to-end with the green-when-ready state.

## [0.1.23-beta.17] - 2026-04-29

### Changed

- **Settings modal polish round 2.** Section reorder (Updates → Server → Service → App), equal row heights across all sections (fixes the squeezed channel row in the Updates list), section footers switched from right-aligned to a centered vertical stack so status text can wrap above the action button without forcing the modal wide. New inline footer variant (Server: `[save]` + always-visible note "saving will restart the server and redirect to the new port"). Service section absorbed status into the action button text — single centered button reads "not installed — install?" or "<status> — uninstall?" instead of a 2-row status + footer pairing. Updates section's action button gets green outline + text when status === 'ready', mirroring the home-page UpdateButton chip.

## [0.1.23-beta.16] - 2026-04-29

No code changes. Cut as an in-app update target so v0.1.23-beta.15 fresh installs can exercise the redesigned Settings modal's "apply update" button end-to-end via the in-app updater (gear icon → Updates section → "apply update v0.1.23-beta.16").

## [0.1.23-beta.15] - 2026-04-29

### Changed

- **Settings modal redesigned to a clean two-column grid (description left, control right).** Every section — Server, Updates, Service, App — now uses the same `.settings-section-body` CSS grid (`[labels] 40% [controls] 1fr`) so labels and controls align vertically across rows AND across sections. Inputs are no longer nested inside their labels (the previous pattern made input X-position drift with label-text length). Action buttons (save / install / uninstall / check-for-updates / apply-update) moved to dedicated `.settings-section-footer` rows that span both columns and right-align. Mirrors the ConfigureScrcpy modal aesthetic. Files: `src/app/client/SettingsModal.ts` (~530 lines rewritten), `src/style/modal.css` (settings-modal block).
- **Settings → Updates "apply update" path.** The action button is now dual-purpose: it shows "check for updates now" when there's nothing to apply, and flips to "apply update v0.1.X" (with an apply-and-reload click handler) when status === 'ready'. Same UX as the home-page chip but accessible from anywhere via the gear icon. Status text live-updates through "applying update… → server restarting to apply update — page will reload…" during the apply window.
- **CI: dropped `prerelease: true` flag from beta tag releases.** GitHub's `/releases/latest` API endpoint excludes prereleases, and Velopack's GithubSource queries that endpoint to find the latest release in the configured channel — flagging beta tags as prereleases broke in-app updater discovery for beta-channel users. Channel separation is already handled by Velopack's per-channel `releases.<channel>.json` feed file, so the prerelease flag was redundant gating that broke discovery. Live workaround was applied 7 times during the v0.1.23-beta.{2..14} test cycle (`gh release edit --prerelease=false`); now permanent. File: `.github/workflows/release.yml`.

## [0.1.23-beta.14] - 2026-04-29

No code changes. Cut as an in-app update target so v0.1.23-beta.13 fresh installs can exercise the post-hygiene swap path. Pairs with the beta.9 Job Object kill-on-close release fix (Update.exe survives launcher exit), beta.11 Rust auto-apply disable (no post-apply Update.exe loop), and beta.13 pre-apply hygiene (adb daemon doesn't lock install root). This should be the first end-to-end-clean apply: Update.exe spawns, parent exits, daemon is killed, swap renames `current\` successfully, hooks fire, beta.14 launcher boots automatically with no manual intervention required.

## [0.1.23-beta.13] - 2026-04-29

### Fixed

- **In-app updater can now actually swap `current\` (adb daemon CWD-lock fix).** v0.1.23-beta.11 → beta.12 VM testing surfaced the third in-app-updater failure mode: Velopack downloaded the package, ran `--veloapp-obsolete` cleanly, then failed to rename `current\` to a backup folder with "The process cannot access the file because it is being used by another process," retried 10×1s, and gave up with `Apply error: Unable to start the update, because one or more running processes prevented it.` Sysinternals `handle.exe` showed `adb.exe` (the long-lived `adb start-server` daemon) holding `C:\Program Files\WsScrcpyWeb\current` as a file handle across multiple apply attempts. Daemon inherited cwd from Node, which inherited from the launcher running from `current\`. Two fixes:
  - **Pre-apply hygiene** in `UpdateService.applyUpdate` (now async): runs `adb kill-server` via the bundled adb client, then Windows-only `taskkill /F /IM adb.exe /T` belt-and-braces, then a 250ms settle delay before `waitExitThenApplyUpdate`. All steps failure-tolerant — apply still proceeds if hygiene partially fails. `UpdatesApi.handleApply` now `await`s `applyUpdate` so the deferred `process.exit` timer doesn't fire before Velopack actually has Update.exe spawned.
  - **Architectural cwd fix** in `AdbClient`: spawned adb processes now use `path.dirname(adbPath)` as their cwd (which lives at `<dataRoot>\dependencies\adb\` per Local-Dependencies-Only) instead of inheriting the launcher's working directory. Even if `kill-server` fails or the daemon respawns, its cwd-lock no longer falls inside the install root and can't block a future swap. Applied to all three adb spawn paths: `exec` wrapper, `shell`, and `shellSpawn`.

## [0.1.23-beta.12] - 2026-04-29

No code changes. Cut as an in-app update target so v0.1.23-beta.11 fresh installs can exercise the post-apply auto-relaunch path now that the Rust-SDK auto-apply default is disabled. Pairs with the beta.9 Job Object kill-on-close release fix as the second half of the in-app updater story: beta.9 lets `Update.exe` survive launcher exit; beta.11 stops the post-swap launcher from re-firing `Update.exe` in a loop.

## [0.1.23-beta.11] - 2026-04-29

### Fixed

- **Update.exe loop after successful apply (Gotcha 1 redux on the Rust SDK).** v0.1.23-beta.9 → beta.10 VM testing surfaced this: clicking Apply ran Update.exe, swap completed, launcher relaunched as beta.10 — and then the SAME pending package re-fired Update.exe, looping. Root cause: v0.1.23-beta.3 disabled `setAutoApplyOnStartup` on the Node-side Velopack SDK (`src/server/index.ts`) but the parallel Rust `VelopackApp` (velopack crate 0.0.1298) defaults `auto_apply: true` and does the exact same `manager.get_update_pending_restart()` → auto-fire-Update.exe check from `launcher/src/main.rs:114`. Fix: explicit `.set_auto_apply_on_startup(false)` on the Rust SDK call too. Apply now fires ONLY on explicit user click via `UpdateService.applyUpdate`. Stuck users on beta.9/beta.10 can recover by deleting the staged `.nupkg` from `C:\Program Files\WsScrcpyWeb\packages\WsScrcpyWeb-*-beta-full.nupkg` before next launch (or fresh-installing beta.11 over the loop).

## [0.1.23-beta.10] - 2026-04-29

No code changes. Cut as an in-app update target so v0.1.23-beta.9 fresh installs can exercise the auto-relaunch path now that the Job Object kill-on-close release is in place. This is the first release that should let `Update.exe` survive past launcher exit and complete the swap + relaunch automatically — no manual relaunch required.

## [0.1.23-beta.9] - 2026-04-29

### Fixed

- **In-app updater no longer killed mid-extract by our own Job Object.** v0.1.23-beta.7 → beta.8 VM testing showed the auto-relaunch failing — clicking "apply update" shut down the app cleanly but never relaunched the new version; only a manual relaunch completed the swap. Velopack log cut off mid-line at `Extracting 393 app files...`, the classic `TerminateProcess` signature. Root cause: the v0.1.22 Job Object (`KILL_ON_JOB_CLOSE`) added to clean up Node + `node-pty` descendants on launcher exit was inheriting `Update.exe` (a grandchild via Node) into the same job. When the launcher exited gracefully after `applyUpdate()`, our last handle to the job closed and the kernel terminated `Update.exe` mid-extract, leaving the install in a half-state. Fix: `launcher/src/job_object.rs::release()` clears the kill-on-close flag before the launcher's last handle drops, so the job dissolves quietly without killing remaining members. Hard-kill paths (Servy stop, Task Manager, crash) bypass this cleanup, so the v0.1.22 safety net still fires on abnormal termination as intended.
- **`Update.exe`'s "Failed to wait for process … (Access is denied)"** still appears in `velopack_WsScrcpyWeb.log` because of an integrity-level mismatch on `OpenProcess` from the post-UAC launcher chain. Velopack continues anyway via its `Continuing...` fallback, and with the Job Object fix above the apply now completes successfully. The warning is cosmetic at this point but tracked separately.

## [0.1.23-beta.8] - 2026-04-29

No code changes. Cut as an in-app update target so v0.1.23-beta.7 fresh installs can exercise the fully-automatic update path: UAC prompt for icacls at first launch (one-time), subsequent updates apply silently with no further UAC.

## [0.1.23-beta.7] - 2026-04-29

### Fixed

- **Install-root ACL grant now survives MSI install (Fix 2 follow-up).** The `--veloapp-install` hook's `icacls` grant on `C:\Program Files\WsScrcpyWeb\` was getting stripped by MSI's component-permission step (~3 seconds after our hook ran). v0.1.23-beta.7 adds a deferred grant: at first non-hook launcher start, if the install root isn't user-writable, `ShellExecuteExW(verb="runas")` invokes `icacls.exe` elevated to apply the grant — single one-time UAC prompt per install. Once granted, all subsequent launches find the install root writable and skip the elevation entirely. Also fixes migrations from v0.1.21 / v0.1.22 / v0.1.23-beta.{1..6} → beta.7+ (those installs lack the grant; first launch under beta.7 catches them). UAC dismissal is logged and swallowed — the app keeps running with degraded auto-update; user can manually retry by relaunching.
- **`--veloapp-obsolete` promoted to a proper handler.** v0.1.23-beta.5 → beta.6 VM testing surfaced this previously-unknown velopack lifecycle flag, which beta.1's catch-all caught and exited cleanly. beta.7 now recognizes it as `HookKind::Obsolete` with a named handler so it stops appearing as `[ERROR] hook: unknown velopack flag` in the launcher log; the runtime behavior is unchanged (log + exit 0 to allow Update.exe to swap `current\`).

### Notes

- v0.1.23-beta.7 is the first build with the fully-automatic in-app updater path. Fresh-install via the MSI; on first launch, accept the UAC prompt for icacls; subsequent updates apply silently with no further UAC prompts.
- Migrations from v0.1.21 / v0.1.22 / v0.1.23-beta.{1..6}: the in-app updater on those builds is broken at varying levels. To get to beta.7, uninstall via Add/Remove Programs and fresh-install the v0.1.23-beta.7 MSI. From beta.7 forward, the updater is fully automatic.

## [0.1.23-beta.6] - 2026-04-28

No code changes. Cut as an in-app update target so v0.1.23-beta.5 fresh installs can exercise the explicit-Apply path now that the install root is user-writable. Tests whether Velopack's swap actually completes when no elevation step is required.

## [0.1.23-beta.5] - 2026-04-28

### Fixed

- **In-app updater swap actually completes (Fix 2 of v0.1.22 yank investigation).** The `--veloapp-install` hook now grants `Authenticated Users:Modify (OI)(CI)` on the install root (`C:\Program Files\WsScrcpyWeb\`), in addition to the existing grant on the data root (`C:\ProgramData\WsScrcpyWeb\`). Velopack's writability self-test on the install root now passes for the running user, which short-circuits the elevated-`Update.exe` re-launch pathway that was silently failing in v0.1.23-beta.3 → beta.4 testing ("Re-launching as administrator" log line followed by zero further log entries from the elevated process). The swap becomes a regular file rename the running user can do directly — no UAC prompt during update apply, no LocalAppData fallback. Trade-off: any logged-in user can modify the binaries at `C:\Program Files\WsScrcpyWeb\`. For a personal-tooling app this is acceptable; multi-tenant deployments may want to revisit (the deferred Phase 6 ACL-tightening item is the natural lever).

### Notes

- v0.1.21 / v0.1.22 / v0.1.23-beta.{1..4} → v0.1.23-beta.5 in-app update is still subject to the older Velopack architecture and will likely fail (their existing Update.exe doesn't have the new ACL). To get to beta.5: uninstall via Add/Remove Programs and fresh-install the v0.1.23-beta.5 MSI. From beta.5 forward, the in-app updater should be functional.

## [0.1.23-beta.4] - 2026-04-28

No code changes. Cut as an in-app update target so v0.1.23-beta.3 fresh installs can exercise the explicit-Apply path now that autoApply is disabled. Tests whether the underlying Update.exe swap actually completes when the user explicitly clicks Apply (vs the loop-on-startup behavior beta.1 → beta.2 surfaced).

## [0.1.23-beta.3] - 2026-04-28

### Fixed

- **In-app updater spawn-loop after failed apply (root cause of v0.1.22 yank).** The Velopack JS SDK's `VelopackApp` defaults `_autoApply = true`, so every Node startup auto-detected a previously-staged nupkg in `<localappdata>\WsScrcpyWeb\packages\` and auto-fired `Update.exe apply`, then exited the Node process. After any failed apply (lock contention, UAC dismissed, or other Update.exe failure), the staged package stayed, and every subsequent app launch re-fired the loop — visible as "UAC prompt for updater that closes silently with the app never coming back." Fix: `VelopackApp.build().setAutoApplyOnStartup(false).run()` in `src/server/index.ts`. Apply now fires ONLY on explicit `UpdateService.applyUpdate` user click. Users with a stuck staged package can recover by closing the app instead of being trapped.

### Notes

- Updating from v0.1.23-beta.1 to this beta is still subject to the underlying Update.exe swap failure (separate root-cause investigation). Use a fresh MSI install of beta.3 instead. To clear a stuck staged package without uninstall, delete `%LocalAppData%\WsScrcpyWeb\packages\*.nupkg`.

## [0.1.23-beta.2] - 2026-04-28

No code changes. Cut as an in-app update target so v0.1.23-beta.1 fresh installs can exercise the in-app updater path under the new argv-logging diagnostic + unknown-flag catch-all from beta.1. The launcher.log entry for the post-Update.exe respawn will reveal which velopack lifecycle flag was tripping `VelopackApp::build().run()` to silent-exit, which feeds the proper handler in v0.1.23 (final).

## [0.1.23-beta.1] - 2026-04-28

Diagnostic-only beta cut. Targets the v0.1.22 in-app updater spawn-loop investigation. Fresh-install only — the in-app updater from v0.1.21 / v0.1.22 to this beta is the same broken Update.exe and will hang/loop the same way.

### Added

- **Argv logging in launcher startup.** `launcher/src/main.rs` now logs `argv: [...]` immediately after collecting args, on every launcher invocation. v0.1.22's Update.exe spawn-loop bug couldn't be diagnosed because we had no record of which velopack lifecycle flag Update.exe was passing on respawn. With this in place, the next failed update flow leaves a per-spawn argv trace in `<dataRoot>\ws-scrcpy-web-launcher.log`.
- **Catch-all handler for unknown `--veloapp-*` flags.** `launcher/src/hooks.rs` now matches any `--veloapp-*` flag not in our explicit `{install, updated, uninstall}` set, logs it via `log::error` (so it stands out), and exits 0. Without this, `VelopackApp::build().run()` silently consumed the unknown flag and exited the process before our supervisor branch fired, which `Update.exe` interpreted as launcher failure and retried indefinitely. The catch-all converts the infinite respawn loop into a single clean exit, so `Update.exe` either completes the swap or surfaces a definitive error instead of hanging.

## [0.1.22] - 2026-04-28 [YANKED]

**This release was yanked on 2026-04-28** after VM testing showed the in-app updater never completes the v0.1.21 → v0.1.22 swap. The fresh-MSI install of v0.1.22 itself works correctly; only the auto-update path is broken across the v0.1.21 → v0.1.22 boundary.

### Known issues (why this was yanked)

- **In-app updater hangs (service mode) or silently fails (local mode).** velopack.log confirms the JS SDK downloads the v0.1.22 nupkg into `<installRoot>\packages\` correctly and hands off to `Update.exe apply --waitPid <pid> --silent --root <installRoot>`. `Update.exe` then enters a retry loop respawning the launcher every ~13 s, and the launcher exits silently without reaching its supervisor, so `current\` is never swapped. Service mode shows `Update.exe` running indefinitely with the service stopped; local mode appears to "succeed" but the post-update launcher reports `v0.1.21` again. Root cause is being investigated in v0.1.23 — likely an unhandled velopack lifecycle flag the launcher exits silently on.
- **To upgrade from v0.1.21 to a future v0.1.23+:** uninstall ws-scrcpy-web via Add/Remove Programs and fresh-install the new MSI. The in-app updater will not work across this version boundary; the v0.1.21 binary's `Update.exe` is the same broken `Update.exe` shipped in v0.1.22, so only a clean reinstall escapes it.

### Added

- **Job Object on Node spawn (Windows).** The launcher adopts the supervised Node child into a process-wide kill-on-close Windows Job Object. When the launcher exits — graceful, killed by Servy stop, or torn down by MSI uninstall — the OS automatically terminates Node and every descendant (node-pty, scrcpy.exe, etc.). Fixes orphaned `node.exe` after service uninstall, and the cosmetic `pty.node` MSI-rename-to-`.rbf` residual observed in v0.1.21 (the running Node held the `.node` loaded; killing it on launcher exit means the file is no longer locked when the MSI scheduler runs). No-op on non-Windows. Failure to create or assign the job is logged and swallowed — the launcher continues with v0.1.21 behavior.

### Removed

- **Setup.exe artifact.** The PerMachine MSI is the only Windows install path from v0.1.22 forward. Setup.exe was kept through v0.1.21 as a per-user fallback during the migration window; the multi-user / service-mode / Velopack-under-SYSTEM trade-offs make it no longer worth shipping. CI release workflow drops the Setup.exe sign + upload steps and the windows-final + GitHub-Release artifact patterns. README, RELEASING.md, and PROGRAMDATA-MIGRATION.md updated.
- **v0.1.20 service-install env-var passthrough.** `ServiceApi.handleInstall` no longer freezes the installing user's `LOCALAPPDATA`/`APPDATA`/`USERPROFILE` into the service-Node's env block. The Phase-2 `VelopackLocatorConfig` override (v0.1.21) makes the service-Node's `UpdateManager` work under SYSTEM at root cause; the env-var workaround was kept only as belt-and-braces during the migration window.
- **v0.1.20→v0.1.21 legacy-config migration shim** (`launcher/src/migrate.rs`). The one-shot copy from `%LocalAppData%\WsScrcpyWeb\config.json` to `<dataRoot>\config.json` was only meaningful during the in-place upgrade window. v0.1.22+ ships exclusively as a fresh PerMachine MSI install, so the shim is dead code on every install path.

### Fixed

- Pre-existing clippy regressions surfaced by the rust-clippy 1.95 toolchain bump (doc list overindent in `common/src/tray.rs`, field-reassign-with-default in `launcher/src/user_session_spawn.rs`) so `cargo clippy --workspace -- -D warnings` stays green.

## [0.1.21] - 2026-04-28

### Changed

- **Install layout migrated to per-machine** (Windows). Binaries now live at `C:\Program Files\WsScrcpyWeb\` (Velopack-managed); writable runtime state (`config.json`, `dependencies\`, logs) lives at `C:\ProgramData\WsScrcpyWeb\` with `Authenticated Users:Modify (OI)(CI)` granted at MSI install time. **Existing v0.1.x users must uninstall + reinstall** — Velopack auto-update cannot migrate across install locations. Detailed upgrade instructions in `docs/PROGRAMDATA-MIGRATION.md`. The Setup.exe artifact still ships through v0.1.21 as a fallback for users who prefer per-user installs without UAC on every update; v0.1.22 will drop Setup.exe.
- **Service-mode + multi-user state is now coherent.** All users (and the Local System service-Node) share `C:\ProgramData\WsScrcpyWeb\config.json` and the downloaded `dependencies\` tree. Settings changed in any context are visible to all others. Bob's first login after Alice installs the service automatically picks up the existing service URL via the shared config — no second WelcomeModal, no orphaned per-user instances.
- **Updates require UAC every apply** (consequence of per-machine install). Velopack's `Update.exe` writes to Program Files which non-admin users cannot modify. The signed Update.exe triggers a single UAC prompt per update. Documented in PROGRAMDATA-MIGRATION.md.
- **Tray menu** — left-click now opens the app in the default browser (the most common action becomes the cheapest gesture). Right-click shows a popup menu with "Open ws-scrcpy-web" + "Exit". Pre-v0.1.21 left-click was the exit-confirm dialog only; that path moved to the right-click menu's "Exit" item. Both the user-mode launcher tray and the standalone service-mode tray helper share the new menu.

### Added

- **Two-root path resolution** under the hood. `installRoot` (binaries, Velopack-managed) and `dataRoot` (writable state) are now distinct concepts in both the TS server (`resolveDataRoot` + `Config.dataRoot`) and the Rust launcher (`Paths::data_root`). `dataRoot` defaults to `%PROGRAMDATA%\WsScrcpyWeb` on Windows and collapses to `installRoot` on non-Windows hosts (Linux AppImage layout unchanged).
- **VelopackLocator runtime override.** `UpdateService.init()` builds a `VelopackLocatorConfig` from `installRoot` and passes it to `new UpdateManager(...)`. Velopack no longer relies on `%LOCALAPPDATA%`-walking auto-locate, fixing the v0.1.20 service-mode failure ("Could not auto-locate app manifest. Treating as dev mode.") at root cause. The v0.1.20 `LOCALAPPDATA`/`APPDATA`/`USERPROFILE` env-var passthrough in `ServiceApi.handleInstall` remains in place as belt-and-braces; v0.1.22 will remove it.
- **One-shot legacy-config migration shim** (`launcher/src/migrate.rs`). When v0.1.21+ runs over a v0.1.20 install (i.e. Setup.exe → MSI upgrade where the user retained `%LocalAppData%\WsScrcpyWeb\config.json`), the launcher copies the legacy config to `<dataRoot>` on first start so settings carry over. Idempotent; no-op once `<dataRoot>\config.json` exists.
- `docs/PROGRAMDATA-MIGRATION.md` — full upgrade guide for existing v0.1.x users.

### Fixed

- **Service-mode auto-update silently bailed.** Per-machine install resolves Velopack auto-locate cleanly without env-var hackery; the service-Node (Local System) and user-mode launcher both see the same install root via the explicit `VelopackLocatorConfig`. UI Settings → Updates now reports the live version + channel in service mode instead of dev-mode copy.
- **Settings → Updates section blanked out on every PATCH** (toggling `autoUpdate`, changing `githubOwner` / channel / interval). The frontend's response-shape "tolerate either flat or wrapped" type-narrowing was always-true because `UpdatesStatusResponse` itself has a `status: UpdateState` string field, so the response was unwrapped to the literal status string and `syncControlsToStatus` painted every control with `undefined`. Pre-existing bug across the entire v0.1.x line; surfaced during v0.1.21 manual validation. Drop the wrapping check; read the flat shape directly.
- **MSI uninstall left the Windows service registered.** The Velopack `on_uninstall` hook invoked `servy-cli stop WsScrcpyWeb` and `servy-cli uninstall WsScrcpyWeb` with positional args; Servy 8.2's CLI requires `--name <NAME>` for service-targeting commands. The v0.1.5 Servy-8.2 flag migration updated `elevated_runner.rs` (in-app "uninstall service" button) but missed `hooks.rs::run_servy`. Result: servy-cli ran but the SCM entry survived MSI uninstall + reboot. Three call sites fixed (stop / uninstall / restart).
- **MSI uninstall left the tray helper resident + HKCU Run key behind.** After the Servy fix removed the SCM entry cleanly, the standalone `ws-scrcpy-web-tray.exe` helper kept running (its on-disk exe MSI-renamed to `C:\Config.Msi\<id>.rbf` and scheduled for delete-on-reboot). The `HKCU\...\Run\WsScrcpyWebTray` entry pointed at the deleted path. Both cleanups exist in `elevated_runner::uninstall_service` (the in-app "uninstall service" path) but were absent from the Velopack `on_uninstall` hook. Mirrors the in-app uninstall: `taskkill /F /IM ws-scrcpy-web-tray.exe` + `unregister_tray_run_key`.

## [0.1.20] - 2026-04-28

### Fixed

- **First-run dependency UI didn't auto-refresh.** The `FirstRunBanner` (top-of-page "missing dependency" warning) and `DependencyPanel` (Settings dependency table) were both one-shot — they only refreshed on user action (Retry click / "check for updates" button). When the background dep manager finished installing Node/ADB/scrcpy-server, the UI kept showing stale "Not installed / Unknown" until a full page reload. Both now poll `/api/dependencies` every 15 s. The banner stops polling and hides itself once `pendingDeps.length === 0`. The panel skips a poll tick while the user's own check/update/restart action is in flight (a `busy` flag) so an in-progress "Updating…" button never gets clobbered mid-action.
- **Service install redirect landed on Welcome modal instead of Service first-run modal.** `ServiceApi.handleInstall` persisted `installMode = '*-service'` to `config.json` *after* Servy had already started the service. The new service-Node loaded `Config.getInstance()` synchronously at startup, before the local instance had committed the new mode to disk, and served `/api/config` from its stale in-memory copy showing the old `installMode`. The post-redirect page then routed to `WelcomeModal` instead of `ServiceFirstRunModal` because `installMode` didn't match `'user-service' | 'system-service'`. `installMode` now writes to disk *before* the Servy install fires; install failures revert it.

### Added

- **Service-mode Velopack support (experimental).** When the service-Node runs as Local System, Velopack's `UpdateManager` constructor previously failed with "Could not auto-locate app manifest" because `%LOCALAPPDATA%`, `%APPDATA%`, and `%USERPROFILE%` resolve to the system profile (`C:\Windows\system32\config\systemprofile\…`) where no Velopack state exists, and the Settings → Updates section showed dev-mode copy. `ServiceApi.handleInstall` now freezes the installing user's `LOCALAPPDATA`/`APPDATA`/`USERPROFILE` into the service's env block via Servy's `--envVars`. Both the service-launcher (Velopack init in Rust) and the supervised Node (UpdateService init) see real user paths instead of the system profile. **Risk:** if Velopack stages an update from service mode, files staged into the user's `LOCALAPPDATA` will be SYSTEM-owned; a later user-mode launcher may trip on ACLs. Watch during real update tests.

## [0.1.19] - 2026-04-28

### Notes

- Updater validation — no code changes. Cut to give v0.1.18 a target to detect on a fresh install (local + service mode end-to-end).

## [0.1.18] - 2026-04-28

### Fixed

- **Updater "check failed: 404" against GitHub Releases.** `buildFeedUrl` returned `https://github.com/<owner>/<repo>/releases/latest/download/` — that's GitHub's browser-friendly redirect alias for asset URLs. Velopack doesn't recognize it as a GitHub source, so it fell through to its static-URL HTTP client which can't navigate the 302→302→`release-assets.githubusercontent.com` chain GitHub serves and surfaced "404." Now returns the bare repo URL (`https://github.com/<owner>/<repo>`); Velopack detects it as a GitHub source and queries `api.github.com/repos/<owner>/<repo>/releases` directly — no redirect chain.

## [0.1.17] - 2026-04-28

### Fixed

- **In-app updater detection used the wrong marker file.** v0.1.0–v0.1.16 looked for `sq.version` (Squirrel.Windows naming, Velopack's predecessor) at the install root. Velopack actually drops `Update.exe` there. Combined with the v0.1.15 `installRoot` fix, this was the second of two stacked wrong assumptions keeping the updater in permanent dev mode. Now checks `Update.exe` on Windows; Linux AppImage continues to be treated as dev mode.
- **`server.log` had no timestamps.** `Logger` already wrote ISO timestamps to its own `ws-scrcpy-web.log` file, but the `console.log/warn/error` output that the launcher captures into `server.log` was bare `[tag] message`. `console.*` calls now include the timestamp prefix too, so `server.log` and `launcher.log` align side-by-side.

### Added

- **Current app version surfaced in Settings → Updates section.** Both production and dev mode now show `current: vX.Y.Z` at the top of the Updates panel — makes it obvious what build is on disk even when the updater can't run. New `getAppVersion()` helper reads `package.json` directly (replaces the `npm_package_version` env-var path which only worked under `npm start`).
- **First-run dependency-warning note in `WelcomeModal`.** Amber callout warning users that the dep manager fetches Node, ADB, and scrcpy-server in the background on first launch — up to ~3 minutes on slower networks — and that any "missing dependency" warnings during that window clear themselves automatically. Stops users from clicking around assuming something's wrong.

## [0.1.16] - 2026-04-28

### Notes

- Update-flow validation — no code changes. Cut to exercise the in-app updater end-to-end against a v0.1.15 install (local instance + service instance).

## [0.1.15] - 2026-04-28

### Fixed

- **In-app updater never noticed new releases.** `UpdateService` derived its install root from `path.dirname(process.execPath)`, which under our launcher resolves to `<base>\seed\node\` or `<base>\dependencies\node\` — neither contains the Velopack `sq.version` marker, which lives at `<base>\` alongside `current/`. The service silently fell into "dev mode" on every startup and skipped its check. Anchoring at `__dirname` (the webpack bundle's location, always `<base>\current\dist\`) and walking two levels up reliably hits the install root. Same pattern as the v0.1.10 scrcpy-server seed-path fix.

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
- ~~Code signing via [SignPath Foundation](https://signpath.org)'s free OSS program — application is in review. Once approved, the next release will be the first signed release. Until then, integrity is verifiable via the `SHA256SUMS` file shipped with each release.~~ *(Retracted 2026-05-07: SignPath Foundation declined the application — see docs/RELEASING.md "Future signer setup".)*

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
- ~~Code signing via [SignPath Foundation](https://signpath.org)'s free OSS program — application is in review. Once approved, the next release will be the first signed release. Until then, integrity is verifiable via the `SHA256SUMS` file shipped with each release.~~ *(Retracted 2026-05-07: SignPath Foundation declined the application — see docs/RELEASING.md "Future signer setup".)*

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
- ~~Code signing via [SignPath Foundation](https://signpath.org)'s free OSS program — application is in review at v0.1.0 release. Once approved, **v0.1.1** will be the first signed release. Until then, integrity is verifiable via the `SHA256SUMS` file shipped with the release.~~ *(Retracted 2026-05-07: SignPath Foundation declined the application — see docs/RELEASING.md "Future signer setup".)*

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
