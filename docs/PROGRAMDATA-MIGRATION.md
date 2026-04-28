# v0.1.20 → v0.1.21 install layout migration

ws-scrcpy-web v0.1.21 changes how the application is installed on Windows.
This affects every existing v0.1.x install. Read once before upgrading.

## What changed

| Concern | v0.1.20 (and earlier) | v0.1.21 |
|---|---|---|
| Installer artifact | Setup.exe (per-user) | MSI (per-machine) — Setup.exe still ships through v0.1.21 as a fallback |
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

The v0.1.21 launcher includes a one-shot legacy-config migration shim: if it
detects a v0.1.20 `config.json` left behind under `%LocalAppData%\WsScrcpyWeb\`
and no v0.1.21 `config.json` exists yet at `C:\ProgramData\WsScrcpyWeb\`, it
copies the file over. So if you uninstall **without removing the
%LocalAppData% leftovers** (skipping step 2 above is fine — Windows Settings
sometimes leaves user data behind), your v0.1.20 settings (`installMode`,
`webPort`, `firstRunComplete`, etc.) carry over automatically. Downloaded
dependencies (`Node`, `ADB`, `scrcpy-server`) will be re-downloaded once on
first launch — they're not migrated.

## What to expect on every future update

Because v0.1.21 installs to Program Files, every Velopack update apply
triggers a UAC prompt. This is unavoidable for system-wide installs and is
the cost of the architectural simplification. The prompt is from Velopack's
`Update.exe` (signed) writing to a privileged directory.

If you'd prefer a per-user install with no UAC on updates, the v0.1.21
release also includes a `Setup.exe` artifact alongside the MSI. The
Setup.exe variant still installs to `%LocalAppData%\WsScrcpyWeb\` (no MSI,
no PerMachine), at the cost of the multi-user / service-mode improvements
described above. v0.1.22 will drop Setup.exe — the MSI is the supported
install method going forward.

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

- `C:\ProgramData\WsScrcpyWeb\dependencies\server.log` (Node-side log)
- `C:\ProgramData\WsScrcpyWeb\ws-scrcpy-web-launcher.log` (Rust launcher log)
- `C:\Program Files\WsScrcpyWeb\velopack.log` (Velopack lifecycle log)

Open an issue on https://github.com/bilbospocketses/ws-scrcpy-web with the
last ~100 lines of each, plus a description of what you did.
