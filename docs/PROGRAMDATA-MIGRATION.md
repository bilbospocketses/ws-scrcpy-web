# v0.1.20 → v0.1.21 install layout migration

ws-scrcpy-web v0.1.21 changes how the application is installed on Windows.
This affects every existing v0.1.x install. Read once before upgrading.

## What changed

| Concern | v0.1.20 (and earlier) | v0.1.21 |
|---|---|---|
| Installer artifact | Setup.exe (per-user) | MSI (per-machine) |
| Install location (binaries) | `%LocalAppData%\WsScrcpyWeb\` (per user) | `C:\Program Files\WsScrcpyWeb\` (machine-wide) |
| Writable state location | `%LocalAppData%\WsScrcpyWeb\config.json` + `dependencies\` | `C:\ProgramData\WsScrcpyWeb\config.json` + `dependencies\` |
| Updates require UAC | No | **Yes**, every update apply prompts for elevation |
| Multi-user state | Each user had a separate install + config | One install on the machine; all users share `config.json` and downloaded deps |

## Why

Two problems with the v0.1.20 layout:

1. **Service mode + Velopack updater were incompatible.** When the app was
   installed as a Windows Service (Local System), Velopack's auto-update
   couldn't find the install ("Could not auto-locate app manifest"). Local
   System's environment doesn't see `%LocalAppData%`-based Velopack state.
   Settings → Updates rendered dev-mode copy in service mode.
2. **Multi-user friction.** A second user logging in had no way to share the
   first user's install — they'd hit first-run setup again, download Node /
   ADB / scrcpy-server independently, and run their own local-mode instance.
   Service mode and local mode also stored separate state, leading to
   surprising mismatches when changing settings in one place.

v0.1.21 puts binaries under Program Files (where Velopack and service mode
both behave correctly) and writable state under ProgramData (where all users
+ Local System see the same files).

## How to upgrade from v0.1.20

The Velopack auto-updater **cannot** migrate across install locations. Existing
users must manually uninstall the old version and install the new one:

1. **If you have ws-scrcpy-web installed as a service**, uninstall the service
   first. Either:
   - Open the app → Settings → Uninstall service, OR
   - Run from elevated PowerShell: `sc stop WsScrcpyWeb; sc delete WsScrcpyWeb`
2. **Uninstall ws-scrcpy-web** via Settings → Apps → Installed apps →
   ws-scrcpy-web → Uninstall. This removes the v0.1.20 install root at
   `%LocalAppData%\WsScrcpyWeb\` and the ARP entry.
3. **Run the new installer**: `WsScrcpyWeb-0.1.21.msi`. UAC prompt fires once;
   accept. Install completes and the app is ready under
   `C:\Program Files\WsScrcpyWeb\`.
4. **First-run setup runs again.** Reconfigure install mode (local or service)
   the same way you did originally.

v0.1.21 included a one-shot legacy-config migration shim that copied the
v0.1.20 `%LocalAppData%\WsScrcpyWeb\config.json` to the new ProgramData
location on first launch. v0.1.22 dropped the shim — fresh-install behavior
is identical regardless. If you upgraded through v0.1.21 your settings
already carry. If you skipped v0.1.21 and are upgrading directly from
v0.1.20 to v0.1.22, do step 4 (first-run setup) by hand. Downloaded
dependencies (`Node`, `ADB`, `scrcpy-server`) re-download once on first
launch — they're never migrated.

## What to expect on every future update

Because the MSI installs to Program Files, every Velopack update apply
triggers a UAC prompt. This is unavoidable for system-wide installs and is
the cost of the architectural simplification. The prompt is from Velopack's
`Update.exe` (signed) writing to a privileged directory.

## Verification after install

After the MSI install completes, verify:

- `C:\Program Files\WsScrcpyWeb\` contains `current\`, `Update.exe`,
  `packages\`, and `velopack.log`.
- `C:\ProgramData\WsScrcpyWeb\` exists and is writable by your user.
  Check via:
  ```cmd
  icacls "C:\ProgramData\WsScrcpyWeb"
  ```
  Expected: `NT AUTHORITY\Authenticated Users:(OI)(CI)(M)` among the ACEs.
- The Start menu entry "ws-scrcpy-web" launches the tray icon. Right-click
  the tray → "Open ws-scrcpy-web" should open `http://localhost:8000` in
  your default browser.

## Reporting issues

If something is broken after migrating, the most useful diagnostics are:

- `C:\ProgramData\WsScrcpyWeb\dependencies\server.log` (thin crash-catcher: raw Node crashes/native failures; pre-beta.3 path)
- `C:\ProgramData\WsScrcpyWeb\ws-scrcpy-web-launcher.log` (Rust launcher log)
- `C:\ProgramData\WsScrcpyWeb\ws-scrcpy-web.log` (canonical Node app log — `Logger` output, v0.1.23+)
- `C:\Program Files\WsScrcpyWeb\velopack.log` (Velopack lifecycle log)

Open an issue on https://github.com/bilbospocketses/ws-scrcpy-web with the
last ~100 lines of each, plus a description of what you did.

---

# v0.1.21 / v0.1.22 / v0.1.23-beta.{1..6} → v0.1.23 stable migration

If you're already on the v0.1.21+ Program Files / ProgramData layout and
trying to update via the in-app updater, **you must do a fresh MSI install
to reach v0.1.23 stable.** The in-app updater across v0.1.21 / v0.1.22 /
v0.1.23-beta.{1..6} is broken in multiple compounding ways and won't
complete the upgrade no matter how many times you click apply.

## What's broken (and where the fix arrives)

| Bug | Symptom | First fixed in |
|---|---|---|
| Velopack writability test → LocalAppData fallback | `velopack.log` says `Root directory ... writable: false` and stages updates to `%LocalAppData%\WsScrcpyWeb\packages\` instead of the install root. Update.exe later fails to write the swap. | v0.1.23-beta.5 (install hook grants `Authenticated Users:Modify` on install root) |
| MSI's component-permission step strips the install-time icacls grant | beta.5's grant disappears within ~3 s of install, breaking the next update apply. | v0.1.23-beta.7 (deferred grant via UAC at first non-hook launcher start) |
| `--veloapp-obsolete` lifecycle flag unhandled → Update.exe spawn-loop | Apply triggers a 13-second loop where the launcher respawns indefinitely. | v0.1.23-beta.1 (catch-all in hook dispatcher) + beta.7 (named handler) |
| Velopack `_autoApply = true` defaults on BOTH Node + Rust SDKs | Every launcher boot re-fires Update.exe; UAC prompts cascade after any failed apply. | v0.1.23-beta.3 (Node) + beta.11 (Rust) — both must be disabled |
| Job Object `KILL_ON_JOB_CLOSE` reaps `Update.exe` mid-extract | velopack.log cuts off at "Extracting NNN app files"; `current\` swap never happens. Manual relaunch needed. | v0.1.23-beta.9 (`job_object::release()` clears the kill flag on graceful exit) |
| Long-lived `adb start-server` daemon's CWD-lock on `current\` blocks Velopack swap rename | Update.exe gives up with "Unable to start the update, because one or more running processes prevented it." | v0.1.23-beta.13 (pre-apply `adb kill-server` + AdbClient cwd anchored at `<dataRoot>/dependencies/adb/`) |
| webpack's `import { createRequire } from 'module'` tree-shaken to `void 0` | Shell button greyed out; resolver fails to load node-pty after first install. | v0.1.23-beta.23 (switched to `process.getBuiltinModule('module').createRequire(...)`) |

The full per-bug diagnosis lives in the per-beta CHANGELOG entries
v0.1.23-beta.1 through beta.13. None of those fixes are reachable via the
in-app updater on a broken-chain build — Velopack's apply step itself is
what's broken.

## How to migrate

1. **Stop the service if you have one installed.** Settings → Service →
   Uninstall service, OR from elevated PowerShell:
   ```powershell
   sc.exe stop WsScrcpyWeb
   sc.exe delete WsScrcpyWeb
   ```
2. **Uninstall ws-scrcpy-web** via Settings → Apps → Installed apps. This
   removes the broken Velopack install at `C:\Program Files\WsScrcpyWeb\`.
3. **(Optional) Clear any stuck staged packages.** If you see updaters
   looping post-uninstall, also delete:
   - `C:\Program Files\WsScrcpyWeb\packages\*.nupkg` (if the dir survived)
   - `%LocalAppData%\WsScrcpyWeb\packages\*.nupkg` (LocalAppData fallback)
4. **Run the v0.1.23 MSI**: `WsScrcpyWeb-0.1.23.msi`. UAC fires once for
   the install. The first launch fires a SECOND one-time UAC prompt for
   the install-root ACL grant (this is the v0.1.23-beta.7 deferred-grant
   fix; it's the price of being multi-user friendly).
5. **Reconfigure install mode** if you were using service mode. Settings →
   Service → Install as service.

## What to expect going forward

From v0.1.23 onwards the in-app updater is fully functional. Updates apply
with no UAC prompt (the first-launch grant covers all subsequent updates),
and the `current\` swap completes automatically without the user needing
to relaunch. Settings → Updates → "apply update v0.1.X" handles the full
flow including auto-relaunch into the new version.

If a future update fails: the per-build `velopack.log` + `ws-scrcpy-web.log`
(plus the v0.1.23-beta.1–13 CHANGELOG entries) are the right starting points.
