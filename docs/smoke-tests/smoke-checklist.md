# ws-scrcpy-web — Smoke Run-Sheet

> **Smoke target: `v0.1.30-beta.60`** — bump this one line each release; everything below is version-agnostic.

Execution-ordered, tickable checklist for the 0.1.30 Linux smoke gate. Regroups the canonical rows from
[`smoke-full.md`](./smoke-full.md) by **app state** — the order you actually run them; that doc
stays the module-organized reference. Wherever a row shows a version, expect the **smoke-target version** (top of this doc),
which carries the beta.48 port-discovery fix plus the App-section UX (batch #15).

**Legend:** ✅ passed · ☐ to run · 🧩 needs setup (fresh snapshot / 2nd user / 2nd admin / beta.40 artifact / no-libfuse2 host) · 📱 needs a real device · 🪟 Windows pass (separate snapshot)

## Before each run — reset to a clean slate

1. **Wipe prior state** with [`clear-install.sh`](./clear-install.sh) (user + system service, `/opt` + `/var/opt`, dataRoot, autostart, `.desktop`, all fcontext rules, the lock, stray procs → prints `CLEAN SLATE ✓`).
2. **Re-download the latest** — the `~/Downloads` AppImage is stale; **no `chmod +x`** (GUI double-click of a non-`+x` AppImage is the realistic path):
   ```bash
   gh release download --repo bilbospocketses/ws-scrcpy-web --pattern '*linux-beta.AppImage' --dir ~/Downloads
   ```
3. **Keep the capture scripts handy.** Beside this doc: [`capture-logs.sh`](./capture-logs.sh) (Linux) / [`capture-logs.ps1`](./capture-logs.ps1) (Windows). Run one at any checkpoint — **especially the instant a row fails** — to snapshot every log + state (AVC, service journal/status, fcontext, SELinux labels, processes, dataRoot / Program Files / temp listings, config, app logs) to a timestamped, labeled folder + archive to attach. The numbered output files map to the "Expected + verify" column.
   ```bash
   bash capture-logs.sh <test-id>                                       # Linux,   e.g.  ... 5.8-after-uninstall
   ```
   ```powershell
   powershell -ExecutionPolicy Bypass -File capture-logs.ps1 <test-id>  # Windows, e.g.  ... 15.2-wipe
   ```

Boxes start unticked — this is a fresh pass.

---

## #6 — First install + the beta.48 port-discovery re-confirm

> Run this batch **first** on the fresh download (breadcrumb step 1). **Order matters — check 4.1 in the no-service window (after 1.2, before 4.2-user): installing any service flips `scopeRadioState.locked`, locking the scope radios read-only, so "system becomes selectable" is only observable before any service exists.** 1.2 + 4.2-user passed on beta.48; the smoke-target leaves that install/service code unchanged, so this is a quick re-confirm.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **1.2** `[L]` Accept "all users" | GUI double-click the non-`+x` AppImage → **yes, all users** → one pkexec | Binary at `/opt/ws-scrcpy-web/`; `/opt/VERSION` = the smoke-target version; system `.desktop` present; original `~/Downloads` AppImage **gone** |
| ☐ **4.1** `[L]` System-scope gate un-greys | **Before installing any service** (a service install flips `scopeRadioState.locked` → radios go read-only; see 4.4): Settings → service → select **system** scope | Now **selectable** + its install **un-greyed** now that you're machine-wide; was gated *"requires installing system-wide for all users first"* before 1.2 |
| ☐ **4.2-user** `[L]` Install user service | Settings → service → **user** scope → install (no elevation) | Service active on 8000; stable ExecStart; **no "port discovery timed out"** (the beta.48 fix) |

## #7 — Current install checks ▶ active *(machine-wide + user-service in place, no teardown)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **2.1** `[L]` Binary/deps labels | `ls -Z /opt/ws-scrcpy-web` | → **bin_t** — `VERSION` + `WsScrcpyWeb.AppImage` both `unconfined_u:object_r:bin_t:s0` |
| ☐ **2.4** `[L]` Zero AVC | Watch `sudo journalctl -f \| grep -i avc` across the installs | **No** AVC denials |
| ☐ **4.4** `[L]` Scope-radio legibility *(locked-radios state — counterpart to 4.1)* | Reopen Settings | Selected dot a **clear blue**; radios non-interactive (`pointer-events:none` + `tabindex=-1`, **not** `disabled`); **user** scope shown selected |
| ☐ **4.5** `[B]` Confirm-dialog buttons | Open the install/uninstall "privileges required" confirm | Cancel/confirm are **white-outline + white-text** |
| ☐ **4.6** `[L]` Unit hygiene | `cat ~/.config/systemd/user/WsScrcpyWeb.service` (StartLimit* under **[Unit]**); `journalctl --user -u WsScrcpyWeb -b` (**current boot only**); `pgrep -fa WsScrcpyWeb` | **No** `Unknown key 'StartLimitIntervalSec'` — must use **`-b`**: the persisted journal keeps stale pre-fix warnings from old installs that false-fail a whole-history grep; **only the service** runs (no leftover home instance); no false timeout toast |
| ☐ **3.2** `[L]` Single-instance flock | Launch a 2nd copy from `/opt` **and** from `~/Downloads` | 2nd launch **blocked** (flock on `$XDG_RUNTIME_DIR`); no 2nd server; existing URL opens |
| ☐ **10.1** `[B]` Status API | Browse `/api/service/status` | JSON with correct `platform`, `supported`, `status` |
| ☐ **10.3** `[L]` Logs clean | Tail `~/.local/share/WsScrcpyWeb/logs` | No error spam; teardown logs on stop |
| ☐ **12.2** `[B]` Stop-exit gating | Settings → App (service installed) | Button **greyed** + neutral note; clicking fires **no** shutdown POST; re-enables after uninstall |

## #8 — User-service uninstall → local mode

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **5.8** `[L]` Uninstall → relaunch local | Uninstall the user service **as that user** | Unit file gone (`~/.config/systemd/user/WsScrcpyWeb.service`); no straggler (`pgrep -fa "adb\|scrcpy-server\|WsScrcpyWeb"` clean); relaunches **local mode**; Settings shows not-installed |
| ☐ **12.1** `[L]` Clean exit + adb teardown | Local mode, device + stream → Settings → App → "stop server & exit" | Tab self-closes/"app stopped"; process tree exits clean; log shows "Stopping adb daemon"; launcher **exit 0** (no 75 restart) |
| ☐ **12.4** `[L]` DATA_ROOT override | Launch with `DATA_ROOT=/tmp/wssw-dataroot` exported | Config/deps/logs land there (Node **and** launcher agree) |
| ☐ **13.1** `[B]` Bookmark global-dismiss | Bookmark/port-change reminder → check "don't show again — ever" | Supersedes + disables the per-port checkbox; persists `bookmarkDismissedGlobally` |
| ☐ **13.2** `[B]` Reset prompts | Settings → "reset welcome and bookmark prompts" | Re-shows welcome **and** clears bookmark (per-port + global); welcome reset must **not** re-suppress the per-port bookmark |

## #9 — System-scope service pass

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **4.2-system** `[L]` Install system service | Settings → service → **system** scope → install (pkexec) | `/opt` ExecStart **as root**; state in `/var/opt`; zero AVC |
| ☐ **2.2** `[L]` State labels | `ls -Z /var/opt/ws-scrcpy-web` | → **var_lib_t** |
| ☐ **2.3** `[L]` fcontext rules | `sudo semanage fcontext -l \| grep ws-scrcpy-web` | **Both** the `/opt` bin_t rule and the `/var/opt` var_lib_t rule |
| ☐ **3.3** `[L]` Service-defer | System service running → launch locally | Defers to the service (opens its URL); no 2nd server |
| ☐ **5.1** `[L]` Same-user uninstall → relaunch | Uninstall as the active user | App reappears in that session, **same port**, visible "relaunching…" |
| ☐ **5.4** `[L]` fcontext cleanup | After uninstall: `sudo semanage fcontext -l \| grep ws-scrcpy-web` | **Empty** (both rules gone) |
| ☐ **5.9** `[L]` Uninstall message | After a no-active-session uninstall | **Neutral** info line — not red, no "retry" button |

## #10 — First-run variants 🧩 *(needs fresh snapshot / 2nd user / 2nd admin)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **1.1** `[L]` First-run modal | Run the home AppImage with no prior install/decline marker | 3 stacked lines + yes/no; no ×; **Esc** and **click-outside do nothing** |
| ☐ **1.3** `[L]` Decline + remember | Fresh state / 2nd user → **no, me only** | Runs in place from `~/.local`; next launch does **not** re-prompt; AppImage kept |
| ☐ **1.4** `[L]` Headless first-run | Launch over SSH / no display | No hang; graceful fallback |
| ☐ **3.1** `[L]` Per-user launch | 2nd user launches from the apps menu (`.desktop`) | Own `~/.local` data; "Open" reaches the same backend port |
| ☐ **5.2** `[L]` Different-admin uninstall | Uninstall via **pkexec as a different admin** | App reappears in the **active desktop user's** session, same port |
| ☐ **5.3** `[L]` Headless uninstall | Uninstall with no graphical session | No relaunch; manual fallback; no orphan; no `data_root_for_linux` panic |

## #11 — Updates 🧩 *(needs the beta.40 "update-from" artifact)*

Get the from-build first: `gh run download 26859605903 --repo bilbospocketses/ws-scrcpy-web --name linux-final`.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **6.1** `[B]` Update check | Settings → Updates → Check | beta.40 **offers the latest**; the latest = up-to-date; no log spam |
| ☐ **6.2** `[L]` Local update apply | beta.40 home (local mode) → Apply | Verifies + swaps + **auto-relaunches** to the latest; reconnects |
| ☐ **6.3** `[L]` No-service /opt update | Machine-wide `/opt`, no service → update | One pkexec; **rename**-swap; relabel bin_t; **no ETXTBSY**; FUSE intact |
| ☐ **6.4** `[L]` Newer home over /opt | `/opt` beta.40 + newer home AppImage → launch | Offers system-wide update → swap → next launch runs updated `/opt` |
| ☐ **6.5** `[L]` User-service update | User-service → Apply | Unit stops, home swaps, restarts **same port**, **no prompt** |
| ☐ **6.6** `[L]` System-service update | System-service → Apply | **No polkit**; `/opt` swaps; restorecon bin_t; **zero AVC**; helper survives `systemctl stop` |
| ☐ **6.7** `[L]` Migrate legacy beta.40 | beta.40 system install → update **from a local instance** | Reinstall to `/var/opt`, carry `webPort`/`installMode`, zero AVC, only the new fcontext rule |

## #12 — Velopack / no-libfuse2 🧩 *(needs a minimal Fedora host without libfuse2)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **11.1** `[L]` No-libfuse2 launch | Run the smoke-target AppImage on a host without `libfuse2` | Launches (type-2 FUSE embedded); no "dlopen libfuse" error |
| ☐ **11.2** `[L]` No-libfuse2 update | In-app update from that host | Succeeds → **clears item 31 step 3** (then remove the 5 gate files) |
| ☐ **11.3** `[L]` Locator-fix watch | During 6.3 / 6.4 / 6.6 apply + relaunch | No Velopack locator root-path regression (velopack#921) |

## #13 — Devices / scrcpy / adb 📱 *(needs a real Android device, Wireless debugging)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **7.1** `[B]` Wireless connect | Scan/connect → device `ip:port` | adb connects; card appears within ~5s |
| ☐ **7.2** `[B]` Subnet scan | Scan-network modal → subnet | Devices listed; bad/empty subnets handled (no hang) |
| ☐ **8.1** `[B]` Video stream | Device → stream/config → connect | Live video renders; no decode errors |
| ☐ **8.2** `[B]` Control | Click/scroll/type + on-screen device buttons | Input reaches the device; nav works |
| ☐ **8.3** `[B]` Audio | Enable audio (Android 11+) | Plays; codec/source toggle works |
| ☐ **8.4** `[B]` Codec/encoder | Change display/codec/encoder/fps/bitrate → reconnect | Applies; persists per-device |
| ☐ **9.1** `[B]` Shell modal | Run `getprop ro.product.model` + a couple commands | Terminal works; clean close, no orphaned adb shell |
| ☐ **9.2** `[B]` File listing/transfer | Browse, change icon size, push/pull | Loads; icon-size persists; transfers succeed |
| ☐ **9.3** `[B]` Device actions | Sleep/wake + power/nav on the card | Buttons reflect state; actions take effect |

## #14 — Windows pass 🪟 *(clean Win11 snapshot, accounts Admin/User1/User2, the MSI)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **1.5** `[W]` Fresh MSI install | Install `WsScrcpyWeb-beta.msi` as Admin | Auto-opens; WelcomeModal; About = the smoke-target version; `C:\Program Files\WsScrcpyWeb\` |
| ☐ **1.6** `[W]` Reinstall reuses config | After 5.7, reinstall the MSI | Existing `config.json` detected + reused; same saved port |
| ☐ **3.4** `[W]` Per-session tray | Service installed; Fast User Switch Admin→User1→User2 | Exactly **one** tray/session (~2s); "Open" → same backend port |
| ☐ **3.5** `[W]` 2nd tray rejected | Launch a 2nd `ws-scrcpy-web-tray.exe` | No 2nd tray; spawned proc exits ~100ms |
| ☐ **4.3** `[W]` Install confirm UX | Settings → install service → test cancel/Esc/backdrop, then continue | Cancel/Esc/backdrop = **no** UAC/no fetch; continue → UAC → installs, no WelcomeModal |
| ☐ **5.5** `[W]` Uninstall + handoff | Service mode, Admin → uninstall → continue → UAC Yes | "uninstalling…"; >5s "still waiting…"; ends at local-mode URL |
| ☐ **5.6** `[W]` Handoff-failure guard | Kill all `tray.exe`, then uninstall | ~5s/~30s messages; button freed; **service still installed** |
| ☐ **5.7** `[W]` Full uninstall | Add/Remove → Uninstall as Admin | Service unregistered; `HKLM…\Run\WsScrcpyWebTray` gone; Program Files cleared; **dataRoot preserved** |
| ☐ **5.10** `[W]` UAC declined | Standard user → uninstall → **decline** UAC | 403 `reason=uac-declined`; retry message; button freed; service still installed |
| ☐ **6.8** `[W]` Update + tray persists | beta.40 MSI → Updates → Apply | Applies; reachable; **one** tray after settling (persists across update) |
| ☐ **7.3** `[W]` USB device | Plug USB, authorize the RSA prompt | Appears; survives a reload |
| ☐ **10.2** `[W]` Logs clean | Tail `ProgramData\WsScrcpyWeb\logs\{launcher,server}.log` | No `ERR`/`Error:` except known node-pty AttachConsole noise |
| ☐ **11.4** `[W]` PerMachine intact | After the MSI install, check the location | `C:\Program Files\WsScrcpyWeb\` (PerMachine) |
| ☐ **12.3** `[W]` Stop-exit reaps tray | Local mode → stop server & exit | Tray disappears; no lingering launcher/node/tray/adb; **cancel** leaves running |

## #15 — App-section UX (Linux)

App-section additions (no module-doc counterpart): the one-click **install for all users**, the machine-wide start-menu icon, and the in-app **uninstall** flows.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **15.1** `[L]` install-for-all-users button | Local (me-only) install running → Settings → **App** → click **install for all users**; authenticate the one prompt. | One pkexec; binary **relocates to `/opt/ws-scrcpy-web/`**; the button then goes **greyed/disabled** reading **"already installed for all users (/opt)"**; app keeps serving on the same port. |
| ☐ **15.2** `[L]` start-menu icon | After a machine-wide install (15.1 or 1.2), open the desktop apps menu and find the **ws-scrcpy-web** entry; also check the icon on disk. | The launcher entry shows the **ws-scrcpy-web icon** (not a generic placeholder); `ls /usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png` → **exists**. |
| ☐ **15.3** `[L]` uninstall — local | Local mode → Settings → **App** → **uninstall…** → confirm (leave **"keep my settings & logs" unchecked**). | App removed; tab shows **"uninstalled — close this tab"**; `docs/smoke-tests/clear-install.sh` verify → **CLEAN SLATE** (no leftover binary / deps / config / decline marker). |
| ☐ **15.4** `[L]` uninstall — user-service cascade | User-scope service installed (machine-wide `/opt` binary) → Settings → **App** → **uninstall…** → confirm. | **One pkexec** (for the `/opt` removal); the `--user` unit is **gone** AND the app is **removed in one pass**; **no relaunch**. |
| ☐ **15.5** `[L]` uninstall — system-service cascade | System-scope service installed → **uninstall…** (runs from the root service context). | Runs **as root, NO pkexec**; `/opt/ws-scrcpy-web` + `/var/opt/ws-scrcpy-web` + the systemd unit are **all gone**; **zero AVC**. |
| ☐ **15.6** `[L]` uninstall — keep settings & logs | Uninstall with **"keep my settings & logs" checked**. | `config.json` + `logs/` **survive** at the data root (`~/.local/share/WsScrcpyWeb` local, or `/var/opt/ws-scrcpy-web` system); `dependencies/` is **gone either way**; a **reinstall reuses the saved port**. |
| ☐ **15.7** `[L]` uninstall — SELinux clean | After any uninstall, inspect the fcontext rules + the AVC monitor. | `sudo semanage fcontext -l \| grep ws-scrcpy-web` → **empty**; **zero AVC**. |

## #16 — Windows App-section: in-app uninstall + stop-exit 🪟 *(drive from smoke-full Module 15)*

New in beta.51, the wipe self-deletion fixed in beta.52. Run on the clean Win11 snapshot after the MSI install. The `[W]` tag distinguishes these from the Linux `15.x` rows in #15.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **15.1** `[W]` In-app uninstall — keep | MSI install → Settings → **App** → **uninstall** → keep **checked** (default) → uninstall | **One UAC** (Update.exe self-elevates — VM decision #1); `C:\Program Files\WsScrcpyWeb\` gone; service gone (`sc query WsScrcpyWeb` → not found); tray gone; **ARP entry gone**; `config.json` + `logs\` **survive** under `%ProgramData%\WsScrcpyWeb`, `dependencies\` gone; reinstall reuses the saved port |
| ☐ **15.2** `[W]` In-app uninstall — wipe | Same but **uncheck** keep | As 15.1, **and the whole `%ProgramData%\WsScrcpyWeb` is gone** — incl. `control\operation-server\` (the beta.52 fix: the temp-copy cleaner removes it after the original exits). Confirm **no** leftover dir — `capture-logs.ps1 15.2-wipe`, then check `31-dataroot` |
| ☐ **15.3** `[W]` Uninstall modal UX | Open the uninstall modal | Top-layer overlay above Settings; **cancel** white-outline, **uninstall** red text + border; keep checkbox **checked by default**; cancel / Esc / backdrop = no action |
| ☐ **15.4** `[W]` Stop-exit reaps tray + adb | Local mode, device + stream live → Settings → **App** → **stop server & exit** | Tab closes / "app stopped"; Task Manager shows **no** lingering `ws-scrcpy-web-launcher.exe` / `node.exe` / `ws-scrcpy-web-tray.exe` / `adb.exe` |
| ☐ **15.5** `[W]` App-section order | Settings → App | Order top→bottom: **reset prompts → stop server & exit → uninstall ws-scrcpy-web** (no "install for all users" on Windows) |

---

## Global pass criteria

| Criterion | Holds when |
|---|---|
| **SELinux clean** `[L]` | Zero AVC all session; `sudo semanage fcontext -l \| grep ws-scrcpy-web` empty after every uninstall |
| **Single instance** | Never two trays (Win) / two servers (Linux) per user/session |
| **Relaunch fidelity** | Every uninstall→relaunch lands on the **same port**; no orphaned processes |
| **Updates apply everywhere** | local, machine-wide `/opt` (no-service), user-service, system-service (headless) all swap + relaunch on the same port; **zero AVC** on the system-service path |
| **Migration** | A beta.40 system install migrates to `/var/opt` carrying `webPort`/`installMode`, zero AVC |
| **Clean shutdown** | "stop server & exit" tears down adb (+ Win tray) with no orphans; gated off in service mode |
| **Data preserved** | User config/deps/logs survive uninstall + reinstall |
| **Core flow** | Scan → connect → stream (video + control) → shell works on both platforms |

**Stop-and-report:** a `[Linux]` SELinux/lifecycle failure in Modules 2/4/5, the service-update rows 6.5/6.6, or migration 6.7 — run `capture-logs.sh <id>` (`.ps1` on Windows) for the evidence bundle, then fix before promoting 0.1.30 stable. Cosmetic/polish → note as beta-territory. **Module 11 (no-libfuse2)** gates closing item 31, not 0.1.30-stable on its own.
