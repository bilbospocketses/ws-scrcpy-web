# ws-scrcpy-web — Full Smoke Test

> **Smoke target: `v0.1.30-beta.52`** — bump this one line each release; everything below is version-agnostic.

All-encompassing manual smoke, grouped by function and tagged by platform (`[Win]` / `[Linux]` / `[Both]`). Each row is a single test: **what to verify**, **how to perform it**, and the **expected result + how to verify**. Walk top to bottom; some rows depend on state from earlier rows in the same module.

> **Consolidated 2026-06-06.** This doc absorbs the three former per-feature checklists — Linux service-mode (`beta.37`), stop-server-&-exit (`beta.39`), and the Windows multi-user / MSI pass (`v0.1.25-beta.3`) — so it is the **single gate for `0.1.30` final** (the first true Windows + Linux release). It covers every shipped feature to date: install/first-run, Linux layout & SELinux, multi-user & single-instance, service mode (incl. the beta.45–48 stable-ExecStart + install hand-off + post-install port-discovery fix), lifecycle, updates (local / machine-wide / user- & system-service / migration), devices, streaming, adb, logs, Velopack 1.2.0, stop-server-&-exit, settings prompts, and the **Linux App-section UX** (install-for-all-users, start-menu icon, in-app complete uninstall — Module 14).

## Pre-flight

- **Linux:** Fedora VM, `getenforce` → **Enforcing**; a 2nd user account + a 2nd admin login; baseline `sudo semanage fcontext -l | grep ws-scrcpy-web` empty (or run `clear-install.sh` beside this doc for a one-shot verified clean slate); keep `sudo journalctl -f | grep -i avc` running the whole session. Download `WsScrcpyWeb-linux-beta.AppImage` from the **latest** release — **don't `chmod +x`**: GUI double-click of a non-`+x` AppImage is the realistic path (it's what surfaced the F1 service-mode bug).
- **Windows:** Win11 VM, clean snapshot; three accounts `Admin` / `User1` / `User2`; `regedit` + Task Manager → Startup tab handy. Download `WsScrcpyWeb-beta.msi` from the **latest** release.
- **Devices:** an Android device with **Wireless debugging** enabled (Android 11+) reachable from the VM, plus (Windows) one USB device if available.

**Build-prep — the "update from" build (Modules 6 + the migration row).** The releases page is curated to the latest only, so the update/migration rows need an older build to update *from*. Don't rebuild — download the still-retained **beta.40** CI artifact (the exact published beta.40 AppImage: Velopack 1.1.1, the old `/opt/.../data` system layout the migration row needs):

```bash
# Linux — the update/migration "from" build
gh run download 26859605903 --repo bilbospocketses/ws-scrcpy-web --name linux-final --dir ./beta40
chmod +x ./beta40/WsScrcpyWeb-linux-beta.AppImage
# Windows MSI (row 6.8 / the Windows pass): --name windows-final from the same run
```

Artifacts are retained ~90 days from 2026-06-03. **the latest release is feed-latest**, so any older install updates *to* it.

- **No-libfuse2 host (Module 11.1/11.2):** a minimal Fedora container/distro **without** `libfuse2`. This is the gate for closing item 31, not a 0.1.30-stable blocker on its own.

**Clean slate — `clear-install.sh` (recommended).** For a one-shot, verified teardown of the **entire** install footprint — user- *and* system-scope service, `/opt` + `/var/opt`, dataRoot, tray autostart, the system `.desktop`, **all** SELinux fcontext rules (incl. the legacy beta.40 `/opt/.../data`), the single-instance lock, and any stray processes — run `bash clear-install.sh` (sits beside this doc). It tears down, then prints a per-item PASS/FAIL ending in `CLEAN SLATE ✓` / `NOT CLEAN ✗` (exit 0/1); idempotent + safe on an already-clean VM.

**Capture evidence — `capture-logs.sh` / `capture-logs.ps1` (run at every checkpoint).** Beside this doc: `capture-logs.sh` (Linux) / `capture-logs.ps1` (Windows). Run `bash capture-logs.sh <test-id>` or `powershell -ExecutionPolicy Bypass -File capture-logs.ps1 <test-id>` at each capture point — **especially the moment a row fails** — to snapshot all logs + state (AVC, service status/journal, fcontext, SELinux labels, processes, dataRoot / Program Files / temp listings, config, app logs) to a timestamped, labeled folder + archive. The numbered output files (`10-avc`, `30-fcontext`, `33-dataroot-ls` / `31-dataroot`, the `70-*.log` app logs, …) map directly to each row's verify step, so a failure can be diagnosed without re-running it.

**Manual recovery** — the by-hand system-scope subset, if you just need to clear a single stuck service without the script:

```bash
sudo systemctl stop WsScrcpyWeb.service; sudo systemctl disable WsScrcpyWeb.service; sudo systemctl reset-failed WsScrcpyWeb.service
sudo rm -f /etc/systemd/system/WsScrcpyWeb.service
sudo rm -rf /opt/ws-scrcpy-web /var/opt/ws-scrcpy-web
sudo semanage fcontext -d '/opt/ws-scrcpy-web(/.*)?'; sudo semanage fcontext -d '/var/opt/ws-scrcpy-web(/.*)?'
sudo systemctl daemon-reload
```

---

## Module 1 — Install & first-run

| Test | How to perform | Expected + verify |
|---|---|---|
| **1.1** `[Linux]` First-run modal | Run the home AppImage on a machine with no prior install/decline marker. | "install for all users?" modal: 3 stacked lines + buttons **yes, all users** / **no, me only**; **no ×**; **Esc** and **click-outside do nothing** (forced choice). |
| **1.2** `[Linux]` Accept → install + **delete original** | Click **yes, all users**; authenticate the one prompt. | One pkexec; binary at `/opt/ws-scrcpy-web/`; `/opt/VERSION` = the smoke-target version; system `.desktop` present; app runs. **NEW:** the original home AppImage (the file you launched) is **gone** — `ls ~/Downloads/WsScrcpyWeb*.AppImage` → not found. |
| **1.3** `[Linux]` Decline + remember | Fresh state / 2nd user → **no, me only**. | Runs in place from `~/.local`; **next launch does NOT re-prompt**; original AppImage **kept**. |
| **1.4** `[Linux]` Headless first-run | Launch over SSH / no display. | No hang; graceful fallback, no crash. |
| **1.5** `[Win]` Fresh MSI install | Clean snapshot, log in `Admin`; install `WsScrcpyWeb-beta.msi`. | Installs clean; browser auto-opens `http://localhost:<port>`; WelcomeModal shows; Settings → About = the smoke-target version; installs to `C:\Program Files\WsScrcpyWeb\`. |
| **1.6** `[Win]` Reinstall reuses config *(H.2)* | After 5.7's full uninstall, reinstall `WsScrcpyWeb-beta.msi`. | Installs clean; existing `config.json` under dataRoot is **detected and reused** (no fresh skeleton overwrite); app reachable on the previously-saved port. |

## Module 2 — Linux layout & SELinux

| Test | How to perform | Expected + verify |
|---|---|---|
| **2.1** `[Linux]` Binary/deps labels | After a machine-wide (and/or system-service) install. | `ls -Z /opt/ws-scrcpy-web` → **bin_t**. |
| **2.2** `[Linux]` State labels | Inspect the variable-state tree. | `ls -Z /var/opt/ws-scrcpy-web` → **var_lib_t** (config/logs/deps the service writes). |
| **2.3** `[Linux]` fcontext rules registered | After a system-service install. | `sudo semanage fcontext -l \| grep ws-scrcpy-web` shows **both** the `/opt` bin_t rule and the `/var/opt` var_lib_t rule. |
| **2.4** `[Linux]` Zero AVC during install | Watch the `journalctl` monitor through 1.2 + a service install. | **No AVC** denials. |

## Module 3 — Multi-user & single-instance

| Test | How to perform | Expected + verify |
|---|---|---|
| **3.1** `[Linux]` Per-user launch | Log in as a **2nd user**; launch from the apps menu (`.desktop`). | Runs under that user's login, own `~/.local` data (independent); "Open" reaches the same backend port. |
| **3.2** `[Linux]` Single-instance (flock) | Same user, app running → launch a 2nd copy (from `/opt` and from home). | 2nd launch **blocked** (flock on `$XDG_RUNTIME_DIR`); no 2nd server; existing URL opens. |
| **3.3** `[Linux]` Service-defer | System service running → launch locally. | Defers to the service (opens its URL); no 2nd server. |
| **3.4** `[Win]` Per-session tray | Service installed; switch `Admin`→`User1`→`User2` via Fast User Switching. | Each session gets **exactly one** tray within ~2s; right-click → "Open" loads the app (same backend port for every session). |
| **3.5** `[Win]` 2nd tray.exe rejected | With tray running: `start "" "C:\Program Files\WsScrcpyWeb\current\ws-scrcpy-web-tray.exe"`. | No 2nd tray; spawned proc exits ~100ms; original tray fine. |

## Module 4 — Service mode

| Test | How to perform | Expected + verify |
|---|---|---|
| **4.1** `[Linux]` System-scope gate | App **not** machine-wide → Settings → service → pick **system** scope. | Install greyed + modal "requires installing system-wide first"; **user** scope available; after machine-wide install → system enabled. |
| **4.2** `[Linux]` Install user + system scope | Install each scope (user via no-elevation; system via pkexec). | user → home ExecStart; system → `/opt` ExecStart running as root, state in `/var/opt`. Zero AVC. |
| **4.3** `[Win]` Install confirm UX | Settings → "install service" → inspect modal; test **cancel**, **Esc**, **backdrop**, then **continue**. | AdminConfirmModal "Administrative Privileges Required"; cancel/Esc/backdrop all close with **no UAC, no fetch**; continue → UAC fires → service installs, redirects, no WelcomeModal. |
| **4.4** `[Linux]` Scope-radio legibility + detection *(item 42)* | After a user- and a system-scope install, reopen Settings each time. | The selected scope radio's dot is a **clearly visible blue** (not washed-out grey); radios are non-interactive but legible (`pointer-events:none` + `tabindex=-1`, **not** the `disabled` attribute); the **correct** scope (user vs system) is the selected one (`resolveActiveScope` end-to-end). |
| **4.5** `[Both]` Confirm-dialog button style *(item 35)* | Open the service install/uninstall "privileges required" confirms (and "end shell session"). | Cancel/confirm buttons use the shared **white-outline + white-text** style (transparent), matching the welcome/bookmark/service-first-run modals. |
| **4.6** `[Linux]` Service-unit hygiene | After a user-scope install: inspect `journalctl --user -u WsScrcpyWeb` + `pgrep`. | **No** `Unknown key 'StartLimitIntervalSec' in section [Service]` (keys are in `[Unit]`); the originating local instance **exits** (`pgrep -fa WsScrcpyWeb` shows only the service's — no leftover home instance); **no** false "port discovery timed out" toast on a same-port install (reconnects on the same port). |

## Module 5 — Lifecycle: uninstall → relaunch / handoff

| Test | How to perform | Expected + verify |
|---|---|---|
| **5.1** `[Linux]` Same-user uninstall → relaunch | System service installed, active user using app → uninstall **as that user**. | App reappears in the active user's session, **same port**, visible "relaunching…" wait. |
| **5.2** `[Linux]` Different-admin uninstall | Uninstall via **pkexec as a different admin**. | App reappears in the **active desktop user's** session (not the admin's), same port. |
| **5.3** `[Linux]` Headless uninstall | Uninstall with no active graphical session. | No relaunch; manual fallback; **no orphan**; no `data_root_for_linux` panic. |
| **5.4** `[Linux]` fcontext cleanup *(fix a)* | After any uninstall. | `sudo semanage fcontext -l \| grep ws-scrcpy-web` → **empty** (both rules gone). |
| **5.5** `[Win]` Uninstall + handoff affordance | Service mode, Settings as `Admin` → "uninstall service" → continue → Yes on UAC. | Button → "uninstalling…"; if handoff >5s → "still waiting for user session…"; ends at local-mode URL. |
| **5.6** `[Win]` Uninstall handoff-failure guard | Service mode; kill all `ws-scrcpy-web-tray.exe`; then uninstall. | ~5s → "still waiting…"; ~30s → "couldn't reach the user session…"; button freed; **service STILL installed** (no silent direct uninstall). |
| **5.7** `[Win]` Full uninstall | Add/Remove Programs → ws-scrcpy-web → Uninstall as `Admin`. | Service stops/unregisters; `HKLM\…\Run\WsScrcpyWebTray` removed; `Program Files\WsScrcpyWeb` cleared; **user data under dataRoot preserved**; admin tray disappears. |
| **5.8** `[Linux]` User-scope uninstall → relaunch local | User-scope service installed, in use → uninstall **as that user**. | `--user` unit stopped/disabled/`reset-failed`, file removed (`~/.config/systemd/user/WsScrcpyWeb.service` absent); **no straggler** (`pgrep -fa "adb\|scrcpy-server\|WsScrcpyWeb"` clean — escaped adb daemon reaped); app **relaunches in local mode**, browser reconnects, Settings shows not-installed. |
| **5.9** `[Linux]` System-scope uninstall message *(item 40b)* | After a system-scope uninstall (no active session). | The "service removed — relaunch the app manually" follow-up renders as a **neutral info line** — **not** red, **no "retry" button**. |
| **5.10** `[Win]` Non-admin uninstall, UAC declined *(D.6)* | Service mode, as a **standard user** → uninstall service → continue → **decline/cancel** the UAC password prompt. | Backend returns **403 `reason='uac-declined'`**; frontend shows "administrative privileges were declined. try again and approve the prompt."; button freed (not stuck); **service still installed**. (UAC accepted → uninstalls cleanly, returns to local mode.) |

## Module 6 — Updates

Get the "update from" build first (Pre-flight build-prep: the beta.40 artifact). The latest release is feed-latest, so every row updates *to* it.

| Test | How to perform | Expected + verify |
|---|---|---|
| **6.1** `[Both]` Update check | Settings → Updates → Check for updates. | A beta.40 install **offers the latest**; the latest reports **up-to-date**; no error spam in `server.log` / `launcher.log`. |
| **6.2** `[Linux]` Local-mode (home) update apply + relaunch *(#27)* | beta.40 home AppImage in **local mode** (no service) → Settings → Updates → Apply. | Downloads + SHA-256 verifies; the "updating…" overlay shows **above** Settings; the AppImage **swaps and auto-relaunches** onto the latest unattended; browser reconnects; About = the new version. **Edge:** also confirm apply on an instance **relaunched right after a user-scope service uninstall** (the `systemd-run --collect` cgroup case) still swaps + relaunches. |
| **6.3** `[Linux]` No-service `/opt` update *(one pkexec)* | Machine-wide `/opt`, **no** service → trigger update. | One pkexec; `/opt` swapped by **rename**; relabel bin_t + restorecon; VERSION bumps; relaunches **as the user**; reconnects. No `ETXTBSY`; FUSE intact. |
| **6.4** `[Linux]` Newer home over `/opt` | `/opt` at beta.40; place a newer home AppImage; launch. | Bootstrapper runs home in place → offers "update the system-wide install to vX" → accept → swap → next launch runs updated `/opt`. |
| **6.5** `[Linux]` User-scope service update apply *(item 39)* | User-scope service installed → Settings → Updates → Apply. | The `--user` unit stops, the home `$APPIMAGE` swaps, the unit restarts on the **same** web port, browser reconnects via the overlay. **No prompt.** |
| **6.6** `[Linux]` System-scope headless service update apply *(item 39 — the SELinux risk)* | System-scope service installed → Apply. | **No polkit prompt** (root self-update); `/opt` copy swaps; `restorecon` re-applies `bin_t`; unit restarts; **zero AVC**. The `systemd-run` apply helper **survives `systemctl stop`** of the unit it's restarting (out-of-cgroup); the FUSE unmount settles within the helper's ~15s swap-retry window (widen if the VM is slow). If SELinux blocks the `init_t` `/opt` write or relabel → **narrow targeted policy only, never broad `audit2allow`**. |
| **6.7** `[Linux]` Migrate a legacy beta.40 system install *(Phase 3a)* | *Clean snapshot* → install **beta.40** → install **system-scope** service (old `/opt/ws-scrcpy-web/data` layout) → update to the latest **from a local instance, NOT from inside the running service**. | In-app notice *"the system service must be reinstalled for the new layout"* + **[reinstall now]** → uninstall→reinstall at `/var/opt`, **`webPort` + `installMode` carried over**, service active, **zero AVC**, `sudo semanage fcontext -l \| grep ws-scrcpy-web` shows only the new `/var/opt` rule. |
| **6.8** `[Win]` In-app update apply + tray persists *(SE-2)* | From a prior installed build (beta.40 MSI) → Settings → Updates → Apply. | Applies clean; app reachable post-update; **the tray persists across the update** (the `apply-update-pending` marker gates the reap off; the relaunched launcher keeps it) — **one** tray after settling, no duplicate/orphan. |

## Module 7 — Devices: scan & connect

| Test | How to perform | Expected + verify |
|---|---|---|
| **7.1** `[Both]` Wireless connect | Home → "scan/connect" → enter device `ip:port` (or scan a subnet). | adb connects; device card appears in "connected devices" within ~5s. |
| **7.2** `[Both]` Scan subnet | Open the scan-network modal; run a subnet scan. | Reachable devices listed; selecting one connects; bad/empty subnets handled gracefully (no hang). |
| **7.3** `[Win]` USB device | Plug a USB device (authorize the RSA prompt on device). | Appears in connected devices; survives a home-page reload. |

## Module 8 — scrcpy streaming

| Test | How to perform | Expected + verify |
|---|---|---|
| **8.1** `[Both]` Video stream | Click a device → open the stream/config modal → connect. | Live video renders smoothly; no decode errors in console. |
| **8.2** `[Both]` Control | In the stream, click/scroll/type and use the on-screen device buttons. | Touch + key input reaches the device; navigation works. |
| **8.3** `[Both]` Audio | Enable audio in the stream settings (Android 11+). | Audio plays; codec/source toggle works. |
| **8.4** `[Both]` Codec/encoder settings | In the config modal, change display/codec/encoder/fps/bitrate → reconnect. | Settings apply; stream restarts with the new params; persisted per-device on next open. |

## Module 9 — adb in modals

| Test | How to perform | Expected + verify |
|---|---|---|
| **9.1** `[Both]` Shell modal | Device → "shell" → run `getprop ro.product.model`, a couple of commands. | Interactive terminal works; output correct; closing the modal ends the session cleanly (no orphaned adb shell). |
| **9.2** `[Both]` File listing/transfer | Device → file-list modal → browse, change icon size, push/pull a file. | Listing loads; icon-size pref persists; transfers succeed. |
| **9.3** `[Both]` Device actions | Use sleep/wake (and any power/nav actions) on the device card. | Buttons reflect state (green/red), actions take effect. |

## Module 10 — Logs & sanity

| Test | How to perform | Expected + verify |
|---|---|---|
| **10.1** `[Both]` Service status API | Browse `http://localhost:<port>/api/service/status`. | JSON with correct `platform`, `supported`, `status`. |
| **10.2** `[Win]` Logs clean | Tail `C:\ProgramData\WsScrcpyWeb\logs\{launcher,server}.log` during normal use. | No `ERR` / `Error:` except known cosmetic node-pty AttachConsole noise. |
| **10.3** `[Linux]` Logs clean | Tail logs under `~/.local/share/.../logs` (or `/var/opt/.../logs` for system). | No error spam; teardown logs present on stop. |

## Module 11 — Velopack 1.2.0 / item-31

Velopack is at 1.2.0 (bumped in beta.44). These rows close out item 31 (the libfuse2 first-run gate) and guard the 1.2.0 apply path.

| Test | How to perform | Expected + verify |
|---|---|---|
| **11.1** `[Linux]` No-libfuse2 launch | On a minimal distro/container **without** `libfuse2` installed, run the smoke-target AppImage. | Launches (type-2 runtime has FUSE embedded); **no** `libfuse.so.2` / "dlopen libfuse" error. |
| **11.2** `[Linux]` No-libfuse2 in-app update | From that no-libfuse2 host, run an in-app update (6.x flow). | Update succeeds → **clears item 31 step 3**; then the 5 libfuse2 gate files can be removed (`SystemdClient.ts`, `UpdatesApi.ts`, `UpdateEvents.ts`, `SettingsModal.ts`, README section). |
| **11.3** `[Linux]` Locator fix watch (velopack#921) | During **6.3 / 6.4 / 6.6** apply + relaunch on the machine-wide `/opt` install. | Apply + relaunch land correctly; no Velopack locator root-path regression (the 1.2.0 fix targets exactly this path). |
| **11.4** `[Win]` PerMachine intact | After the 1.5 MSI install, check the install location. | Installed PerMachine to `C:\Program Files\WsScrcpyWeb\` (vpk 1.2.0 `--msi --instLocation PerMachine` unchanged). |

## Module 12 — Stop server & exit (item 27)

beta.39 added a "stop server & exit" button (Settings → App) with graceful teardown, service-mode gating, and (Windows) a tray reap.

| Test | How to perform | Expected + verify |
|---|---|---|
| **12.1** `[Linux]` Local-mode clean exit + adb teardown *(SE-3)* | Local mode, a device connected + a stream running → Settings → App → "stop server & exit" → confirm. | Browser tab self-closes or blanks to **"app stopped — you can close this tab"**; process tree exits clean (`pgrep -fa WsScrcpyWeb` / `pgrep -fa adb` show nothing from this instance); the log shows `Stopping adb daemon (kill-server)` (graceful teardown ran); the launcher does **not** restart (clean `exit 0`, not the 75 restart sentinel). |
| **12.2** `[Both]` Service-mode gating *(SE-4)* | With a service installed (Win system; Linux user- or system-scope) → Settings → App. | The button is **disabled (greyed)** with a neutral note ("managed by the system service — stop it via your service manager, or uninstall the service"); clicking fires **no** shutdown POST. After **uninstalling** the service it becomes **enabled again** (re-gates on status refresh, no reload). |
| **12.3** `[Win]` Local-mode reaps everything *(SE-1)* | Local mode, device + stream live, tray present → Settings → App → "stop server & exit" → ok. | Confirm dialog (title "stop server & exit", modal-styled ok/cancel); server exits (tab self-closes or "app stopped" page); **the tray icon disappears** (launcher reaped it); Task Manager shows **no** lingering `ws-scrcpy-web-launcher.exe` / `node.exe` / `ws-scrcpy-web-tray.exe` / bundled `adb.exe` from this instance; **cancel** leaves everything running. |
| **12.4** `[Linux]` DATA_ROOT override honored *(optional, item 40a)* | Launch with `DATA_ROOT=/tmp/wssw-dataroot` exported. | Config/deps/logs land under `/tmp/wssw-dataroot` (Node side **and** launcher agree — same root for spawn and for adb-reap/tray paths). Mostly unit-covered; confirms the env wiring end-to-end. |

## Module 13 — Settings: bookmark & reset prompts

| Test | How to perform | Expected + verify |
|---|---|---|
| **13.1** `[Both]` Bookmark global-dismiss *(beta.32)* | Reach the bookmark / port-change reminder → check "don't show again — ever, even when the port changes" → confirm. | The confirmation dialog uses the white-outline buttons; checking it **supersedes + disables** the per-port checkbox; persists (`bookmarkDismissedGlobally` in `config.json`). |
| **13.2** `[Both]` Reset welcome & bookmark prompts *(beta.40 fix)* | Settings → "reset welcome and bookmark prompts". | Re-shows the welcome modal **and** clears the bookmark dismissal — both **per-port** and **global** — so the reminder can re-fire. Regression check: the welcome reset must **not** re-suppress the per-port bookmark (the eager `bookmarkDismissedForPort` re-stamp is gone). |

## Module 14 — Linux App-section UX

The App section adds three Settings → **App** affordances on Linux: a one-click **install for all users**, a machine-wide **start-menu icon**, and an always-available in-app **complete uninstall** — it cascades through any installed service in one pass, runs root-direct under a system service (otherwise self-elevates via **one** pkexec), and offers a **"keep my settings & logs"** option.

| Test | How to perform | Expected + verify |
|---|---|---|
| **14.1** `[Linux]` Install-for-all-users button | Local (me-only) install running → Settings → **App** → **install for all users**; authenticate the one prompt. | One pkexec; the binary **relocates to `/opt/ws-scrcpy-web/`**; the button then **greys/disables** reading "already installed for all users (/opt)"; the app keeps serving on the same port. |
| **14.2** `[Linux]` Start-menu icon | After a machine-wide install (14.1 or 1.2), open the desktop apps menu; also check disk. | The launcher entry shows the **ws-scrcpy-web icon** (not a generic placeholder); `ls /usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png` → exists. |
| **14.3** `[Linux]` Complete uninstall — local | Local mode → Settings → **App** → **uninstall…** → confirm with **"keep my settings & logs" unchecked**. | App removed; tab shows "uninstalled — close this tab"; `clear-install.sh` verifies a **CLEAN SLATE** (no leftover binary / deps / config / decline marker). |
| **14.4** `[Linux]` Uninstall — user-service cascade | User-scope service installed (machine-wide `/opt` binary) → **uninstall…** → confirm. | **One pkexec** (for the `/opt` removal); the `--user` unit is **gone** AND the app is **removed in one pass**; no relaunch. |
| **14.5** `[Linux]` Uninstall — system-service cascade | System-scope service installed → **uninstall…** (from the root service context). | Runs **as root, NO pkexec**; `/opt/ws-scrcpy-web` + `/var/opt/ws-scrcpy-web` + the systemd unit are **all gone**; zero AVC. |
| **14.6** `[Linux]` Uninstall — keep settings & logs | Uninstall with **"keep my settings & logs" checked**. | `config.json` + `logs/` **survive** at the data root (`~/.local/share/WsScrcpyWeb` local, or `/var/opt/ws-scrcpy-web` system); `dependencies/` is **gone either way**; a reinstall reuses the saved port. |
| **14.7** `[Linux]` Uninstall — SELinux clean | After any uninstall, inspect fcontext + the AVC monitor. | `sudo semanage fcontext -l \| grep ws-scrcpy-web` → **empty**; zero AVC. |

## Module 15 — Windows App-section uninstall + stop-exit cleanup

In-app **uninstall** now works on Windows (parity with Linux), and "stop server & exit" fully reaps the tray + stray adb. The uninstall triggers Velopack's `Update.exe --uninstall`; **the elevation path and the running-helper self-deletion are the things to settle on the VM** (flagged rows).

| Test | How to perform | Expected + verify |
|---|---|---|
| **15.1** `[Win]` In-app uninstall — keep | MSI install → Settings → **App** → **uninstall** → modal with **keep checked** (default) → uninstall. | **One UAC prompt** (Update.exe self-elevates); `C:\Program Files\WsScrcpyWeb\` gone; service gone (`sc query WsScrcpyWeb` → not found); **tray gone**; **Add/Remove-Programs entry gone** (no orphan); `config.json` + `logs/` **survive** under `%ProgramData%\WsScrcpyWeb`, `dependencies/` gone; reinstall reuses the saved port. |
| **15.2** `[Win]` In-app uninstall — wipe | Same, but **uncheck** keep. | As 15.1 but the **whole `%ProgramData%\WsScrcpyWeb` is gone** — including `control\operation-server\` (the **beta.52** temp-copy-cleaner fix: the deleter runs from a temp copy after the original exits). Capture `capture-logs.ps1 15.2-wipe` and confirm `31-dataroot` shows it absent. |
| **15.3** `[Win]` Uninstall modal UX | Open the uninstall modal. | Top-layer overlay above Settings; **cancel** white-outline, **uninstall** red text + red border; keep checkbox **checked by default**; cancel / Esc / backdrop = no action. |
| **15.4** `[Win]` Stop-exit reaps tray + adb *(item 4)* | Local mode, device + stream live → Settings → **App** → **stop server & exit**. | Tab closes / "app stopped"; Task Manager shows **no** lingering `ws-scrcpy-web-launcher.exe` / `node.exe` / `ws-scrcpy-web-tray.exe` / `adb.exe` — the tray is reaped (poll thread stopped first) **and** stray adb is `taskkill`'d. |
| **15.5** `[Win]` App-section order | Settings → App. | Order top→bottom: **reset prompts → stop server & exit → uninstall ws-scrcpy-web** (no "install for all users" on Windows). |

> **VM decision to settle (beta.51):** does `Update.exe --uninstall` self-elevate when launched by the unelevated staged launcher (15.1 UAC)? If it needs an already-elevated caller, route the Node spawn through the launcher's `--request-uac` / `--elevate-and-run` seam with a new `windows-app-uninstall` command. *(The earlier wipe-self-deletion concern — the helper orphaning `control\operation-server\` — is **fixed in beta.52**: the cleaner runs from a temp copy after the original exits; 15.2 confirms it.)*

---

## Global pass criteria

| Criterion | Holds when |
|---|---|
| **SELinux clean** `[Linux]` | Zero AVC all session; `sudo semanage fcontext -l \| grep ws-scrcpy-web` empty after every uninstall. |
| **Single instance** | Never two trays (Win) / two servers (Linux) per user/session. |
| **Relaunch fidelity** | Every uninstall→relaunch lands on the **same port**; no orphaned processes. |
| **Updates apply everywhere** | local, machine-wide `/opt` (no-service), user-service, and system-service (headless) all swap + relaunch on the same port; **zero AVC** on the system-service path. |
| **Migration** | A beta.40 system install migrates to `/var/opt` carrying `webPort`/`installMode`, zero AVC. |
| **Clean shutdown** | "stop server & exit" tears down adb (+ Win tray) with no orphans; gated off in service mode. |
| **Data preserved** | User config/deps/logs survive uninstall + reinstall. |
| **Core flow** | Scan → connect → stream (video + control) → shell works on both platforms. |

**If a `[Linux]` SELinux/lifecycle row (Modules 2, 4, 5, the service-mode update rows 6.5/6.6, the migration row 6.7, or the Module 14 uninstall-cascade rows 14.4–14.7) or the core-flow criterion fails:** stop, run `capture-logs.sh <id>` (`.ps1` on Windows) for the evidence bundle, report back — fix before promoting 0.1.30 stable. Cosmetic/polish failures: note and triage as beta-territory vs stable-blocker. **Module 11 (no-libfuse2)** is the gate for closing item 31, not a 0.1.30-stable blocker on its own — a failure there means keep the libfuse2 gate, don't remove it.
