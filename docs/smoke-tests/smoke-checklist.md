# ws-scrcpy-web — Smoke Run-Sheet

> **Smoke target: `v0.1.30-beta.69`** — bump this one line each release; everything below is version-agnostic.

Execution-ordered, tickable checklist for the 0.1.30 Linux smoke gate. Regroups the canonical rows from
[`smoke-full.md`](./smoke-full.md) by **app state** — the order you actually run them; that doc
stays the module-organized reference. Wherever a row shows a version, expect the **smoke-target version** (top of this doc),
which carries the beta.48 port-discovery fix plus the Server-section UX (batch #15).

**Legend:** ✅ passed · ☐ to run · 🧩 needs setup (fresh snapshot / 2nd user / 2nd admin / beta.68 from-build / no-libfuse2 host) · 📱 needs a real device · 🪟 Windows pass (separate snapshot) · 🌐 browser-only (no device or install state) · 🐧 Ubuntu (AppArmor/userns/FUSE)

**Platform tags (distro-aware as of 2026-06-24 — we target Windows + Ubuntu/Canonical/AppArmor + Fedora/Red Hat/SELinux):** `[B]` everywhere (Windows + both Linux VMs) · `[L]` run on **both** Fedora + Ubuntu VMs (distro-neutral Linux) · `[Fed]` Fedora-only (SELinux: labels / `semanage` fcontext / AVC / `restorecon`) · `[Ubu]` Ubuntu-only (AppArmor / unprivileged-userns AppImage mount / libfuse2-absent / apt) · `[W]` Windows.

## Before each run — reset to a clean slate

**VM targets (run the Linux pass on BOTH):**
- **Fedora VM** (`[Fed]` + `[L]` rows): `getenforce` → **Enforcing**; 2nd user + 2nd admin; keep the **AVC monitor** `sudo journalctl -f | grep -i avc` running all session.
- **Ubuntu 24.04 VM** (`[Ubu]` + `[L]` rows): **stock, untouched** — do **NOT** pre-disable the userns restriction. Confirm the divergent baseline: `cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns` → **`1`** (mount-blocking restriction active), `dpkg -l | grep -i libfuse2` → **empty** (24.04 ships none → this VM is itself a **no-libfuse2 host**, covers 11.1/11.2 natively), `which semanage getenforce` → **not found** (no SELinux tooling). Same 2nd user + 2nd admin. Keep the **AppArmor denial monitor** `sudo journalctl -k -f | grep -i 'apparmor="DENIED"'` (the Ubuntu analogue of the AVC monitor) running all session; have `sudo dmesg -w | grep -i 'apparmor.*denied'` handy. `[L]`-tagged rows run here too.

1. **Wipe prior state** with [`clear-install.sh`](./clear-install.sh) (user + system service, `/opt` + `/var/lib`, dataRoot, autostart, `.desktop`, all fcontext rules, the lock, stray procs → prints `CLEAN SLATE ✓`).
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
| ☐ **1.2** `[L]` Accept "all users" | GUI double-click the non-`+x` AppImage → **yes, all users** → one pkexec | Binary at `/opt/ws-scrcpy-web/`; `/opt/ws-scrcpy-web/VERSION` = the smoke-target version; system `.desktop` present; original `~/Downloads` AppImage **gone** |
| ☐ **4.1** `[L]` System-scope gate un-greys | **Before installing any service** (a service install flips `scopeRadioState.locked` → radios go read-only; see 4.4): Settings → service → select **system** scope | Now **selectable** + its install **un-greyed** now that you're machine-wide; was gated *"requires installing system-wide for all users first"* before 1.2 |
| ☐ **1.7** `[L]` Cold-start opens one tab *(D1)* | After 1.2, fully quit, then GUI-launch the menu entry / AppImage again (still **no service**) | Server boots **and exactly one** browser tab opens (beta.62 D1 — previously took a 2nd click); a web-port-change **restart** adds **no** 2nd tab |
| ☐ **4.2-user** `[L]` Install user service | Settings → service → **user** scope → install (no elevation) | Service active on 8000; stable ExecStart; **no "port discovery timed out"** (the beta.48 fix) |
| ☐ **1.9** `[B]` First-run dependency-bootstrap banner + Retry | Force a failed first-run dep download — start the app **offline** / block the download host so adb / scrcpy-server / node-pty can't fetch | Home page shows the **"⚠ Setup incomplete — &lt;names&gt; failed to download. Check your network connection."** banner + **Retry**; restore network → **Retry** re-attempts (`POST /api/dependencies/retry-install`) and the banner **clears** on success — the only user-visible recovery for a flaky first-run download |

## #7 — Current install checks ▶ active *(machine-wide + user-service in place, no teardown)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **2.1** `[Fed]` Binary/deps labels | `ls -Z /opt/ws-scrcpy-web` | → **bin_t** — `VERSION` + `WsScrcpyWeb.AppImage` both `unconfined_u:object_r:bin_t:s0` |
| ☐ **2.4** `[Fed]` Zero AVC | Watch `sudo journalctl -f \| grep -i avc` across the installs | **No** AVC denials |
| ☐ **4.4** `[L]` Scope-radio legibility *(locked-radios state — counterpart to 4.1)* | Reopen Settings | Selected dot a **clear blue**; radios non-interactive (`pointer-events:none` + `tabindex=-1`, **not** `disabled`); **user** scope shown selected |
| ☐ **13.3** `[B]` Server-section layout + web-port save | Reopen Settings → inspect the **Server** section (3rd, after Updates + Service) | Rows top→bottom: **reset prompts → web port → [L-only] install for all users → stop server & exit → uninstall**; **web port** has an inline **save** button; status below **empty at rest** (only `saving…`/`saved.`/error after save); change port → save → persists + restarts |
| ☐ **4.6** `[L]` Unit hygiene | `cat ~/.config/systemd/user/WsScrcpyWeb.service` (StartLimit* under **[Unit]**); `journalctl --user -u WsScrcpyWeb -b` (**current boot only**); `pgrep -fa WsScrcpyWeb` | **No** `Unknown key 'StartLimitIntervalSec'` — must use **`-b`**: the persisted journal keeps stale pre-fix warnings from old installs that false-fail a whole-history grep; **only the service** runs (no leftover home instance); no false timeout toast |
| ☐ **3.2** `[L]` Single-instance flock | Launch a 2nd copy from `/opt` **and** from `~/Downloads` | 2nd launch **blocked** (flock on `$XDG_RUNTIME_DIR`); no 2nd server; existing URL opens |
| ☐ **10.1** `[B]` Status API | Browse `/api/service/status` | JSON with correct `platform`, `supported`, `status` |
| ☐ **10.3** `[L]` Logs clean | Tail `~/.local/share/WsScrcpyWeb/logs` | No error spam; teardown logs on stop |
| ☐ **12.2** `[B]` Stop-exit gating | Settings → Server (service installed) | Button **greyed** + neutral note; clicking fires **no** shutdown POST; re-enables after uninstall |

## #7A — Browser UX & accessibility 🌐 *(app running; no device needed)*

> Browser-only checks — run any time the app is up (right after #7 is convenient). No device or service state required. Repeat the visual rows in **both** light and dark themes. These cover beta.66's accessibility/theming work plus the user-visible security behaviors.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **16.1** `[B]` Theme switch | Toggle the home-page theme light ↔ dark; open a modal + the stream view in each | Whole UI recolors live; nothing stuck at the other theme; persists across reload |
| ☐ **16.2** `[B]` Keyboard focus ring | **Tab** through controls, then **click** with the mouse | 2px accent `:focus-visible` outline on keyboard focus; **not** on a mouse click (old global `:focus{outline:none}` gone) |
| ☐ **16.3** `[B]` Reduced motion | OS "reduce motion" on → reload → trigger modals/spinners/transitions | Animations collapse to near-instant (`prefers-reduced-motion`); off → normal animation returns |
| ☐ **16.4** `[B]` Light-mode status tints | In **light** theme: select a file row, hover delete, (update run) hover apply-update | Tints are proper light shades via danger/success tokens — not off-shade dark values |
| ☐ **16.5** `[B]` Embed page lang | Open `embed.html`; inspect `<html>` | `<html lang>` set (a11y), matching the app shell |
| ☐ **16.6** `[B]` Theme first-paint no-FOUC *(beta.67)* | OS set **dark** (or light) with **no saved theme** in-app (fresh profile / right after a settings reset) → load the app, watch the very first paint | Initial paint matches the **OS `prefers-color-scheme`** — **no flash** of the wrong theme — then your **saved choice** (if any) takes over once the app finishes loading |
| ☐ **10.4** `[B]` Token / reload-on-restart | Restart the server (web-port save, or stop & relaunch); also `curl /api/service/status` with no cookie | Open tab must **reload** to reconnect (new per-instance token each boot, `SameSite=Strict` `HttpOnly` cookie); cookie-less curl **rejected**; normal browser use unchanged |
| ☐ **10.5** `[B]` 404 + security headers | `curl -I` a missing path and `/`; load a deep in-app route + refresh | Missing asset / unknown API → **404** (not the shell); in-app route still serves shell; responses carry `nosniff` + `X-Frame-Options: SAMEORIGIN` |
| ☐ **10.6** `[B]` `allowedHosts` reverse-proxy opt-in *(beta.67)* | Set `allowedHosts: ["devices.example.com"]` in `config.json` → restart; `curl -H 'Host: devices.example.com' …/api/service/status` and `curl -H 'Host: evil.example.net' …` | **Listed** host **served** (200); **unlisted** domain Host still **403** (DNS-rebinding guard); empty/unset → only `localhost` + IP literals pass — the documented path to serve behind a TLS-terminating reverse proxy |

## #7B — Ubuntu (AppArmor / userns / FUSE) 🐧 *(stock Ubuntu 24.04 VM, AppArmor monitor running)*

> The Canonical-side counterpart to the SELinux rows — Ubuntu confines with **AppArmor** and (24.04) restricts **unprivileged user namespaces**, exactly what an AppImage uses to mount itself. None of it is exercised by the Fedora module. Run every row on the **stock** Ubuntu 24.04 VM (no userns pre-disable). Slot these where install/launch/uninstall happen on that VM.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **2b.1** `[Ubu]` Userns AppImage launch ⚠️ **(potential 0.1.30 "Canonical" blocker)** | Stock Ubuntu 24.04 (`apparmor_restrict_unprivileged_userns` = `1`, **not** pre-disabled) → run the AppImage **both** ways: terminal `./WsScrcpyWeb-linux-beta.AppImage; echo "exit=$?"` **and** GUI double-click (GUI swallows the error the terminal shows) | **PASS:** app launches, web UI reachable. **FAIL (the risk):** `fuse: mount failed` / userns `clone` EPERM / silent no-op; AppArmor monitor shows `DENIED … class="namespace"`. A static-FUSE runtime does **not** bypass userns. **On fail:** in-app extract-and-run / userns-detection fallback is the tracked code fix; workaround `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` **or** `APPIMAGE_EXTRACT_AND_RUN=1`. **Record the stock-VM result first — do NOT silently disable the restriction and re-run** |
| ☐ **2b.2** `[Ubu]` libfuse2 absent by default | `dpkg -l \| grep -i libfuse2` → empty; `ldconfig -p \| grep -i libfuse.so.2` → empty; then launch (assuming 2b.1 passes) | Launches with **no** libfuse2 ever installed — the **Canonical-native** no-libfuse2 case (11.1/11.2 ride here too); type-2 runtime carries its own FUSE; no "dlopen libfuse" error |
| ☐ **2b.3** `[Ubu]` AppArmor zero-denials (service `/opt` exec) | With a **system-scope** service running (from 2b.4): `sudo journalctl -b \| grep 'apparmor="DENIED"'` and `sudo dmesg \| grep -i 'apparmor.*denied'` | **Empty** — `/opt/ws-scrcpy-web` binary + deps run **unconfined**; any DENIED naming `/opt/ws-scrcpy-web/…` ⇒ needs an AppArmor profile / complain-mode note (the Ubuntu analogue of an AVC failure) |
| ☐ **2b.4** `[Ubu]` Install/uninstall, no SELinux tooling | Install the **system** service via GUI (pkexec), then in-app uninstall; watch `journalctl -u WsScrcpyWeb.service` (install) + launcher log (uninstall) | Install reaches `enable --now` + binds the port **despite** unguarded `semanage`/`restorecon` being ENOENT (they no-op); uninstall → **CLEAN SLATE** (`bash clear-install.sh` → CLEAN SLATE on Ubuntu, validates the script there first time); benign `… spawn failed` ERROR lines for `semanage`/`update-desktop-database` do **not** abort teardown |
| ☐ **2b.5** `[Ubu]` pkexec polkit dialog (GNOME) | Ubuntu GNOME → trigger system-scope **install** + in-app **uninstall**; once, **decline** | A real **graphical** polkit password dialog (not a tty prompt, not an instant decline); decline → local app relaunches, state intact (exit-126 path); approve → completes |
| ☐ **2b.6** `[Ubu]` `systemd-run --user` survival | User-scope **install** (GUI) then **uninstall** as that user | Install-handoff helper starts the unit after the local instance exits (`systemctl --user is-active WsScrcpyWeb` → active; browser reconnects); after uninstall the **post-uninstall local relaunch** reappears (window/tab returns) — the `systemd-run --user --collect` transient unit (carried a "verify on Fedora" marker, never run on Ubuntu) survives on Ubuntu's systemd |
| ☐ **2b.7** `[Ubu]` Desktop menu entry + icon (GNOME) | After a machine-wide install, open GNOME Activities / app grid; then uninstall | The **ws-scrcpy-web** entry + icon appear (not a generic placeholder; `ls /usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png` exists) and **disappear** after uninstall (`gtk-update-icon-cache` / `update-desktop-database` ran) |

## #8 — User-service uninstall → local mode

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **5.8** `[L]` Uninstall → relaunch local | Uninstall the user service **as that user** | Unit file gone (`~/.config/systemd/user/WsScrcpyWeb.service`); after relaunch **only the single local instance** runs (launcher + node + its pre-warmed adb daemon) — **no service procs, no 2nd instance, no `scrcpy-server`** (`pgrep -fa WsScrcpyWeb` = one launcher + one node; `pgrep -x adb` = one; `pgrep -f scrcpy-server` = none); relaunches **local mode**; Settings shows not-installed |
| ☐ **12.1** `[L]` Clean exit + adb teardown | Local mode, device + stream → Settings → Server → "stop server & exit" | Tab self-closes/"app stopped"; process tree exits clean; log shows "Stopping adb daemon"; launcher **exit 0** (no 75 restart) |
| ☐ **12.4** `[L]` DATA_ROOT override | Launch with `DATA_ROOT=/tmp/wssw-dataroot` exported | Config/deps/logs land there (Node **and** launcher agree) |
| ☐ **13.1** `[B]` Bookmark global-dismiss | Bookmark/port-change reminder → check "don't show again — ever" | Supersedes + disables the per-port checkbox; persists `bookmarkDismissedGlobally` |
| ☐ **13.2** `[B]` Reset prompts *(broadened beta.67)* | **Before clicking**, set a non-default theme + a device label + a per-device stream setting so you can see them wiped. Then Settings → "reset welcome and bookmark prompts" | Re-shows welcome **and** clears bookmark (per-port + global) — **and wipes ALL other per-user settings**: theme, device labels, per-device stream/audio, icon size, scan subnets (`POST /api/settings/reset` → `clearForUser` on both stores; the label understates it). Regression: welcome reset must **not** re-suppress the per-port bookmark |

## #9 — System-scope service pass

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **4.2-system-cli** `[L]` Headless install | Root shell: `sudo ./WsScrcpyWeb --install-system-service` (no GUI) | Service active; `/opt/ws-scrcpy-web` ExecStart **as root**; state in `/var/lib/ws-scrcpy-web`; zero AVC; **survives a reboot** (`systemctl is-active WsScrcpyWeb` after reboot) |
| ☐ **4.2-system-gui** `[L]` Desktop install + takeover | Settings → service → **system** scope → install → ONE awaited pkexec (no timeout, no kill) | UI shows **"switching to the system service…"**; local copy exits, systemd's `Restart=on-failure` retries bind the port (≤ ~2s); **exactly one tab reconnects** — no manual step, no kill/EPERM |
| ☐ **4.5** `[B]` Confirm-dialog buttons *(Linux: system-scope only)* | When you click install (or uninstall) on **system** scope, eyeball the **"Root Privileges Required"** confirm before the pkexec prompt (user-scope shows none) | **cancel** / **continue** are **white-outline + white-text** |
| ☐ **2.2** `[Fed]` State labels | `ls -Z /var/lib/ws-scrcpy-web` | → **var_lib_t** (policy default — no custom fcontext rule for this path) |
| ☐ **2.3** `[Fed]` fcontext rules | `sudo semanage fcontext -l \| grep ws-scrcpy-web` | **Only** the `/opt` bin_t rule — `/var/lib` is var_lib_t by the policy default (no custom rule) |
| ☐ **3.3** `[L]` Service-defer | System service running → launch locally | Defers to the service (opens its URL); no 2nd server |
| ☐ **5.1** `[L]` Same-user uninstall (served-by-service) | Settings → uninstall (ServiceApi spawns out-of-cgroup `systemd-run --system … <staged /opt AppImage> --linux-service-teardown --scope system`) | PASS = teardown: service **stopped + unit removed**, `/opt/ws-scrcpy-web` **and** `/var/lib/ws-scrcpy-web` both **gone**, `sudo semanage fcontext -l \| grep ws-scrcpy-web` → empty, zero AVC. Tab: **relaunch the app manually** if it doesn't reconnect (auto-relaunch is a tracked follow-up — do NOT pass/fail on it) |
| ☐ **5.4** `[Fed]` fcontext cleanup | After uninstall: `sudo semanage fcontext -l \| grep ws-scrcpy-web` | **Empty** (the `/opt` rule gone; `/var/lib` never had one) |
| ☐ **5.9** `[L]` Uninstall message | After a no-active-session uninstall | **Neutral** info line — not red, no "retry" button |
| ☐ **5.x-keepstate** `[L]` Headless uninstall `--keep-state` | `sudo ./WsScrcpyWeb --uninstall-system-service --keep-state`, then reinstall | `config.json` + `logs/` preserved under `/var/lib/ws-scrcpy-web`; `dependencies/`, `bin/`, `control/` removed; reinstall **reuses the saved port** |
| ☐ **4.2-system-ubuntu** `[L/Ubuntu]` Ubuntu install + boot + uninstall | Install, reboot, uninstall on an Ubuntu host (no SELinux) | All steps succeed; `semanage`/`restorecon` steps are no-ops (no SELinux policy, no AVC concept); AppArmor needs no per-path relabel |

## #10 — First-run variants 🧩 *(needs fresh snapshot / 2nd user / 2nd admin)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **1.1** `[L]` First-run modal | Run the home AppImage with no prior install/decline marker | 3 stacked lines + yes/no; no ×; **Esc** and **click-outside do nothing** |
| ☐ **1.3** `[L]` Decline + remember | Fresh state / 2nd user → **no, me only** | Runs in place from `~/.local`; next launch does **not** re-prompt; AppImage kept |
| ☐ **1.4** `[L]` Headless first-run | Launch over SSH / no display | No hang; graceful fallback |
| ☐ **3.1** `[L]` Per-user launch | 2nd user launches from the apps menu (`.desktop`) | Own `~/.local` data; "Open" reaches the same backend port |
| ☐ **5.2** `[L]` Different-admin uninstall | Uninstall via **pkexec as a different admin** (triggers `systemd-run --system` teardown) | PASS = teardown: service stopped + unit removed, `/opt/ws-scrcpy-web` and `/var/lib/ws-scrcpy-web` gone, fcontext clean, zero AVC. Tab: **relaunch the app manually** if it doesn't reconnect (auto-relaunch is a tracked follow-up) |
| ☐ **5.3** `[L]` Headless uninstall | `sudo ./WsScrcpyWeb --uninstall-system-service` (no graphical session) | No relaunch; manual fallback; no orphan; no `data_root_for_linux` panic; full teardown verified |

## #11 — Updates 🧩 *(needs the beta.68 "update-from" release)*

Get the from-build first: `gh release download v0.1.30-beta.68 --repo bilbospocketses/ws-scrcpy-web --pattern 'WsScrcpyWeb-linux-beta.AppImage'`.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **6.1** `[B]` Update check | Settings → Updates → Check | beta.68 **offers the latest**; the latest = up-to-date; no log spam |
| ☐ **6.2** `[L]` Local update apply | beta.68 home (local mode) → Apply | Verifies + swaps + **auto-relaunches** to the latest; reconnects |
| ☐ **6.3** `[L]` No-service /opt update | Machine-wide `/opt`, no service → update | One pkexec; **rename**-swap; relabel bin_t; **no ETXTBSY**; FUSE intact |
| ☐ **6.4** `[L]` Newer home over /opt | `/opt` beta.68 + newer home AppImage → launch | Offers system-wide update → swap → next launch runs updated `/opt` |
| ☐ **6.5** `[L]` User-service update | User-service → Apply | Unit stops, home swaps, restarts **same port**, **no prompt** |
| ☐ **6.6** `[L]` System-service update | System-service → Apply | **No polkit**; `/opt` swaps; restorecon bin_t; **zero AVC**; helper survives `systemctl stop`; updated deps stay **bin_t** (`ls -Z /opt/ws-scrcpy-web/dependencies` — copied into the bin_t tree, no relabel) |

## #12 — Velopack / no-libfuse2 🧩 *(run the smoke on a no-libfuse2 Fedora host — folds in 11.1/11.2)*

> Run the whole Linux smoke on a Fedora host with **no** `libfuse2` (`ldconfig -p | grep -i libfuse.so.2` → empty) and these ride the normal launch + Module 6 update. Regression check on the already-removed gate (PR #422) — **revert #422 if 11.2 fails.** Skippable if that host is friction (doesn't gate 0.1.30), but close it before wide publicity.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **11.1** `[L]` No-libfuse2 launch | Run the smoke-target AppImage on a host without `libfuse2` | Launches (type-2 FUSE embedded); no "dlopen libfuse" error |
| ☐ **11.2** `[L]` No-libfuse2 update | In-app update from that host | Succeeds — regression check that the type-2 runtime self-updates with no host libfuse2 (gate code already removed) |
| ☐ **11.3** `[L]` Locator-fix watch | During 6.3 / 6.4 / 6.6 apply + relaunch | No Velopack locator root-path regression (velopack#921) |

## #13 — Devices / scrcpy / adb 📱 *(needs a real Android device, Wireless debugging)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **7.1** `[B]` Wireless connect | Scan/connect → device `ip:port` | adb connects; card appears within ~5s |
| ☐ **7.2** `[B]` Subnet scan *(+ private-range guard)* | Scan-network modal → subnet; also try a **public** CIDR (e.g. `8.8.8.0/24`) | Devices listed; bad/empty subnets handled (no hang); a **public** CIDR is **refused** (private-range guard — scans restricted to private LAN ranges, beta.66) |
| ☐ **7.4** `[B]` Device list in place *(beta.66)* | Connect / rename / disconnect a few devices | Rows diff in place (no whole-list flicker); labels load once per refresh, not once per row |
| ☐ **7.5** `[B]` Remembered device model in scan hits *(beta.67)* | Connect a device once (facts recorded), disconnect it, re-run a network **scan** | The scan hit shows the device's **remembered manufacturer/model** from the last connection **before** you reconnect (shared `devices` table `observed.model` rehydrates it) |
| ☐ **8.1** `[B]` Video stream | Device → stream/config → connect; resize window | Live video renders; no decode errors; **video cell keeps correct aspect** (no stretch/overflow), rescales on resize (beta.66 #106) |
| ☐ **8.2** `[B]` Control | Click/scroll/type + on-screen device buttons | Input reaches the device; nav works |
| ☐ **8.3** `[B]` Audio | Enable audio (Android 11+) | Plays; codec/source toggle works |
| ☐ **8.4** `[B]` Codec/encoder *(+ resize persistence)* | Change display/codec/encoder/fps/bitrate → reconnect; then **resize the window** and reopen the device | Applies; persists per-device on next open **and survives a window resize** — keyed **per device**, not per window size (the beta.67 fix) |
| ☐ **8.5** `[B]` H.265 decode *(#41)* | Set codec **H.265/HEVC** → connect; repeat **H.264** | Both decode + render in-browser (WebCodecs); no decode errors |
| ☐ **9.1** `[B]` Shell modal | Run `getprop ro.product.model` + a couple commands | Terminal works; clean close, no orphaned adb shell |
| ☐ **9.2** `[B]` File listing/transfer | Browse, change icon size, push/pull (console open) | Loads; icon-size persists; transfers succeed; **console quiet** unless `ws-scrcpy-web-debug` localStorage flag set (beta.66) |
| ☐ **9.3** `[B]` Device actions | Sleep/wake + power/nav on the card | Buttons reflect state; actions take effect |
| ☐ **9.4** `[B]` Dependencies panel *(admin-gated)* | Home → **Dependencies** section: read the table (Installed / Latest / Status), **check for updates**, run a per-dependency **update**, then **restart server** | Table loads; **check for updates** populates Latest; **update** fetches + swaps that dep; **restart server** cycles + comes back. With auth on (Module 18) the whole panel + its APIs are **admin-only** (`requireAdmin`): a `user`-role account doesn't see it, and a direct `POST /api/dependencies/:name/update` is **401/403** |
| ☐ **9.5** `[B]` Shell-unavailable shows a reason | On a host where the `node-pty` prebuilt is missing / failed to load, open a device + look for the **shell** affordance | Shell affordance surfaces an **actionable reason** (`/api/capabilities` → `shell:false` + `shellReason`: download failed / no prebuilt for this Node ABI / native load failure) **instead of silently vanishing** (9.1 = positive path, this = negative) |

## #14 — Windows pass 🪟 *(clean Win11 snapshot, accounts Admin/User1/User2, the MSI)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **1.5** `[W]` Fresh MSI install | Install `WsScrcpyWeb-beta.msi` as Admin | Auto-opens; WelcomeModal; About = the smoke-target version; `C:\Program Files\WsScrcpyWeb\` |
| ☐ **1.6** `[W]` Reinstall reuses config | After 5.7, reinstall the MSI | Existing `config.json` detected + reused; same saved port |
| ☐ **1.8** `[W]` Cold-start opens one tab *(D4)* | Fully quit, then relaunch (Start-menu / exe), **no service** | Exactly **one** browser tab opens (beta.63 D4); a web-port-change **restart** and an in-app **update relaunch** do **not** double-tab |
| ☐ **1.10** `[W]` Install-dir ACL grant + one-time UAC *(install_acl)* | After a **fresh MSI install** (1.5), on the **first app launch** watch for a one-time UAC; then `icacls "C:\Program Files\WsScrcpyWeb"`; then relaunch | First launch fires **one** expected UAC for `icacls … /grant *S-1-5-11:(OI)(CI)M` (MSI strips the hook-time grant; runtime grant fires once on a clean install); `icacls` then shows **`Authenticated Users:(OI)(CI)(M)`**; **relaunch fires NO 2nd UAC** (`ensure_writable` early-returns); `launcher.log` shows `install-root grant applied`. This grant lets Velopack's PerMachine in-app updater write the swap — confirm an in-app update (6.8) then applies |
| ☐ **3.4** `[W]` Per-session tray | Service installed; Fast User Switch Admin→User1→User2 | Exactly **one** tray/session (~2s); "Open" → same backend port |
| ☐ **3.5** `[W]` 2nd tray rejected | Launch a 2nd `ws-scrcpy-web-tray.exe` | No 2nd tray; spawned proc exits ~100ms |
| ☐ **3.6** `[W]` Tray respawn after user-kill | Service mode, tray present → **kill `ws-scrcpy-web-tray.exe`** via Task Manager (End task) | Within ~10s (`TRAY_POLL_INTERVAL_SECS`) **exactly one** tray reappears, **with the startup balloon** ("tray started by launcher… use the exit option from the tray menu"); Open still works; repeatedly killing always brings back exactly one (single-instance mutex blocks doubles) — the supervisor's "tray keeps coming back" guarantee, distinct from the marker-gated *don't*-respawn cases (5.5/6.8) |
| ☐ **3.7** `[W]` Single-instance integrity (User vs Admin) | App running, local mode → (a) double-click the exe again; (b) right-click → **Run as administrator** a 2nd instance; (c) a 2nd **elevated** launch | (a) same-integrity 2nd launch **blocked** — exits ~immediately, no 2nd server/tray (`Local\WsScrcpyWeb-SingleInstance-User`; pure no-op exit, doesn't even reopen the browser); (b) the **elevated** instance **is allowed** to coexist (separate `…-Admin` mutex — the "run normal app, then Run-as-admin to uninstall the service" workflow), then exits cleanly; (c) a 2nd elevated launch is **blocked** |
| ☐ **3.8** `[W]` No startup Run-key (supervisor owns the tray) | After fresh MSI install + service install (before any uninstall): `reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v WsScrcpyWebTray`, the same under `HKCU`, and Task Manager → Startup tab | **Not found** under HKLM **or** HKCU, and **no** ws-scrcpy-web entry on the Startup tab — yet a per-session tray still appears (3.4). Proves the **supervisor poller**, not a Run key, drives the tray (the Run-key code was removed) |
| ☐ **4.3** `[W]` Install confirm UX | Settings → install service → test cancel/Esc/backdrop, then continue | Cancel/Esc/backdrop = **no** UAC/no fetch; continue → UAC → installs, no WelcomeModal |
| ☐ **5.5** `[W]` Uninstall + handoff | Service mode, Admin → uninstall → continue → UAC Yes | "uninstalling…"; >5s "still waiting…"; ends at local-mode URL |
| ☐ **5.6** `[W]` Handoff-failure guard | Kill all `tray.exe`, then uninstall | ~5s/~30s messages; button freed; **service still installed** |
| ☐ **5.7** `[W]` Full uninstall | Add/Remove → Uninstall as Admin | Service unregistered; Program Files cleared; **dataRoot preserved**. *(The legacy `HKLM…\Run\WsScrcpyWebTray` value is removed **if present**, but fresh installs **no longer create any Run key** — supervisor owns the tray — so on a fresh install this clause passes **vacuously**; the live invariant is **3.8**.)* |
| ☐ **5.10** `[W]` UAC declined | Standard user → uninstall → **decline** UAC | 403 `reason=uac-declined`; retry message; button freed; service still installed |
| ☐ **6.8** `[W]` Update + tray persists | beta.68 MSI → Updates → Apply | Applies; reachable; **one** tray after settling (persists across update) |
| ☐ **7.3** `[W]` USB device | Plug USB, authorize the RSA prompt | Appears; survives a reload |
| ☐ **10.2** `[W]` Logs clean | Tail `ProgramData\WsScrcpyWeb\logs\{launcher,server}.log` | No `ERR`/`Error:` except known node-pty AttachConsole noise |
| ☐ **11.4** `[W]` PerMachine intact | After the MSI install, check the location | `C:\Program Files\WsScrcpyWeb\` (PerMachine) |
| ☐ **12.3** `[W]` Stop-exit reaps tray | Local mode → stop server & exit | Tray disappears; no lingering launcher/node/tray/adb; **cancel** leaves running |
| ☐ **12.5** `[W]` Abnormal-termination JobObject reap *(job_object — the safety net)* | Local mode, device + stream live (Node + node-pty + `adb.exe` + `scrcpy.exe` resident) → **kill `ws-scrcpy-web-launcher.exe` via Task Manager (End task)** — NOT stop-server-&-exit. Repeat for a service-mode launcher via `sc stop` / Servy stop | Within ~1s the whole tree is gone — **no** `node.exe` / node-pty / `adb.exe` / `scrcpy.exe` from this instance (the Job's `KILL_ON_JOB_CLOSE` reaps them on abnormal launcher death); immediately MSI-repair/reinstall → **no** `C:\Config.Msi\*.rbf` rename, no "file in use" (the v0.1.21 orphan bug stays fixed). The **opposite** branch from 12.3 / 15.4 (graceful exit *clears* kill-on-close so Update.exe survives — only the graceful path was covered before) |

## #15 — Server-section UX (Linux)

Server-section additions (no module-doc counterpart): the one-click **install for all users**, the machine-wide start-menu icon, and the in-app **uninstall** flows.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **15.1** `[L]` install-for-all-users button | Local (me-only) install running → Settings → **Server** → click **install for all users**; authenticate the one prompt. | One pkexec; binary **relocates to `/opt/ws-scrcpy-web/`**; the button then goes **greyed/disabled** reading **"already installed for all users (/opt)"**; app keeps serving on the same port. |
| ☐ **15.2** `[L]` start-menu icon | After a machine-wide install (15.1 or 1.2), open the desktop apps menu and find the **ws-scrcpy-web** entry; also check the icon on disk. | The launcher entry shows the **ws-scrcpy-web icon** (not a generic placeholder); `ls /usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png` → **exists**. |
| ☐ **15.3** `[L]` uninstall — local | Local mode → Settings → **Server** → **uninstall…** → confirm (leave **"keep my settings & logs" unchecked**). | App removed; tab shows **"uninstalled — close this tab"**; `docs/smoke-tests/clear-install.sh` verify → **CLEAN SLATE** (no leftover binary / deps / config / decline marker). |
| ☐ **15.4** `[L]` uninstall — user-service cascade | User-scope service installed (machine-wide `/opt` binary) → Settings → **Server** → **uninstall…** → confirm. | **One pkexec** (for the `/opt` removal); the `--user` unit is **gone** AND the app is **removed in one pass**; **no relaunch**. |
| ☐ **15.5** `[L]` uninstall — system-service cascade | System-scope service installed → **uninstall…** (runs from the root service context). | Runs **as root, NO pkexec**; `/opt/ws-scrcpy-web` + `/var/lib/ws-scrcpy-web` + the systemd unit are **all gone**; **zero AVC**. |
| ☐ **15.6** `[L]` uninstall — keep settings & logs | Uninstall with **"keep my settings & logs" checked**. | `config.json` + `logs/` **survive** at the data root (`~/.local/share/WsScrcpyWeb` local, or `/var/lib/ws-scrcpy-web` system); `dependencies/` is **gone either way**; a **reinstall reuses the saved port**. |
| ☐ **15.7** `[Fed]` uninstall — SELinux clean | After any uninstall, inspect the fcontext rules + the AVC monitor. | `sudo semanage fcontext -l \| grep ws-scrcpy-web` → **empty**; **zero AVC**. |

## #16 — Windows Server-section: in-app uninstall + stop-exit 🪟 *(drive from smoke-full Module 15)*

New in beta.51, the wipe self-deletion fixed in beta.52. Run on the clean Win11 snapshot after the MSI install. The `[W]` tag distinguishes these from the Linux `15.x` rows in #15.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **15.1** `[W]` In-app uninstall — keep *(from a standard user)* | **From a standard (non-admin) session** (confirm the launcher is medium-integrity in Process Explorer): MSI install → Settings → **Server** → **uninstall** → keep **checked** (default) → uninstall | **One UAC, raised by `Update.exe` itself** — verify the dialog's path/publisher is `…\WsScrcpyWeb\Update.exe`, **not** the launcher (isolates the unelevated-caller → Update.exe-self-elevation model — **resolved**: Update.exe self-elevates from the unelevated staged launcher; no `--request-uac` seam was added); `C:\Program Files\WsScrcpyWeb\` gone; service gone (`sc query WsScrcpyWeb` → not found); tray gone; **ARP entry gone**; `config.json` + `logs\` **survive** under `%ProgramData%\WsScrcpyWeb`, `dependencies\` gone; reinstall reuses the saved port. **Decline** the UAC → install stays intact, no partial teardown |
| ☐ **15.2** `[W]` In-app uninstall — wipe | Same but **uncheck** keep | As 15.1, **and the whole `%ProgramData%\WsScrcpyWeb` is gone** — incl. `control\operation-server\` (the beta.52 fix: the temp-copy cleaner removes it after the original exits). Confirm **no** leftover dir — `capture-logs.ps1 15.2-wipe`, then check `31-dataroot` |
| ☐ **15.3** `[W]` Uninstall modal UX | Open the uninstall modal | Top-layer overlay above Settings; **cancel** white-outline, **uninstall** red text + border; keep checkbox **checked by default**; cancel / Esc / backdrop = no action |
| ☐ **15.4** `[W]` Stop-exit reaps tray + adb | Local mode, device + stream live → Settings → **Server** → **stop server & exit** | Tab closes / "app stopped"; Task Manager shows **no** lingering `ws-scrcpy-web-launcher.exe` / `node.exe` / `ws-scrcpy-web-tray.exe` / `adb.exe` |
| ☐ **15.5** `[W]` Server-section order | Settings → Server | Order top→bottom: **reset prompts → web port → stop server & exit → uninstall ws-scrcpy-web** (no "install for all users" on Windows) |

---

## #18 — Auth subsystem (opt-in login) 🔐 *(new in beta.67 — run top-to-bottom; finish with 18.11)*

> Off by default. Rows after 18.2 assume auth is enabled. Use two browser profiles / private windows (one admin, one regular user). Finish with 18.11 so the rest of the smoke runs un-gated.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **18.1** `[B]` Default open mode | Fresh install (auth never enabled): load app, open Settings | App loads with **no** login prompt — auth is inert until a user is added |
| ☐ **18.2** `[B]` 🔐 Secure the admin account | Settings → manage users → Add user (auth off); in the red "Secure the admin account" block set admin username + password; also fill New user fields (user role); click **Secure & add user** | "Login is now required. Reloading…" → page reloads to the login page; admin password set in the same step (no password-less window) |
| ☐ **18.3** `[B]` 🔐 Login | Sign in with the admin credentials from 18.2 | Reloads into the app authenticated; admin sees admin-only Settings sections (web port, dependencies, updates, service, Users) |
| ☐ **18.4** `[B]` 🔐 Brute-force lockout + generic error | Log out; attempt login with a wrong password 5× within 5 min; also try a non-existent username | Every failure shows the **same generic** message (no username-existence hint, timing blinded); after 5th failure the account is locked ~15 min — correct password refused while locked |
| ☐ **18.5** `[B]` 🔐 Admin clears a lockout | As admin: Settings → manage users → unlock the locked account | Account unlocks immediately; can log in again with correct password |
| ☐ **18.6** `[B]` 🔐 Manage users (role / disable / reset / delete + last-admin guard) | As admin: change a user's role; toggle disable; reset password; delete a throwaway account; then try to delete or demote the **only** admin | Each change applies + list refreshes; disabled account cannot log in; deleting/demoting the **last admin is refused** |
| ☐ **18.7** `[B]` 🔐 Non-admin authz (UI + server) | Log in as the regular user; inspect Settings; issue an admin request from dev-tools: `fetch('/api/users',{method:'POST',...})` | Admin Settings sections **hidden** in the UI **and** the direct admin request **rejected by the server (401/403)**, not merely hidden; user can still connect/scan/label |
| ☐ **18.8** `[B]` 🔐 Change own password | Settings → change password → enter current + new → Save; log out; log back in with new password | "password changed"; new password works; old one refused |
| ☐ **18.9** `[B]` 🔐 Logout | Click log out in Settings | Returns to login page; app gated until sign-in |
| ☐ **18.10** `[B]` 🔐📱 WebSocket streams gated | While logged out (no valid session cookie), try to open a device stream / file-browser / shell or load the app un-authenticated | Device/video/audio/file **WebSocket connections refused** (closed unauthorized) — auth gates live streams, not just the HTML page |
| ☐ **18.11** `[B]` 🔐 Return to open mode | As admin: Settings → disable login (return to open mode) | Page reloads; login no longer required; app open again |
| ☐ **18.12** `[B]` 🔐 Sessions survive restart | Auth enabled + session active → restart the server (don't clear cookies) | Existing `HttpOnly` session cookie still valid after restart (sessions are DB-backed in `wsscrcpy.db`) — no surprise logout |

## #19 — Per-user device labels 📱 *(new in beta.67)*

> Open mode unchanged (19.1 is the no-regression check). Rows 19.2–19.3 need auth enabled (Module 18) with two accounts and at least one discoverable device.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ **19.1** `[B]` 📱 Open-mode labels unchanged | Auth off: scan/connect a device, set a label, reload | Label persists and shows as before — per-user storage is transparent in open mode (single implicit user); no regression vs prior betas |
| ☐ **19.2** `[B]` 🔐📱🌐 Per-user label isolation | Auth enabled (Module 18), accounts A and B. As A: scan a device, label it **"A-name"**. Log out. As B: scan the **same** device | B sees **no label (or B's own)** — not "A-name". Set **"B-name"** as B. Log back in as A → still **"A-name"**. Labels are isolated per account |
| ☐ **19.3** `[B]` 🔐📱🌐 Labels in live scan hits | With A and B each holding a distinct label (from 19.2): as **each** user run a network scan | Each user's scan hits show **that user's own label** (A sees "A-name", B sees "B-name") — labels resolved per logged-in user as the scan streams, not globally |

## Global pass criteria

| Criterion | Holds when |
|---|---|
| **SELinux clean** `[Fed]` | Zero AVC all session; `sudo semanage fcontext -l \| grep ws-scrcpy-web` empty after every uninstall |
| **AppArmor / userns clean** `[Ubu]` | The AppImage **launches** on stock Ubuntu 24.04 (2b.1); zero `apparmor="DENIED"` for the app all session; install + uninstall reach a **CLEAN SLATE despite no SELinux tooling** |
| **Single instance** | Never two trays (Win) / two servers (Linux) per user/session |
| **Relaunch fidelity** | Every uninstall→relaunch lands on the **same port**; no orphaned processes |
| **Updates apply everywhere** | local, machine-wide `/opt` (no-service), user-service, system-service (headless) all swap + relaunch on the same port; **zero AVC** on the system-service path |
| **Clean shutdown** | "stop server & exit" tears down adb (+ Win tray) with no orphans; gated off in service mode |
| **Data preserved** | User config/deps/logs survive uninstall + reinstall |
| **Core flow** | Scan → connect → stream (video + control) → shell works on both platforms |
| **Auth opt-in** | Off by default; enabling via the first-user lockdown gates **both** HTTP and device/stream WebSockets; brute-force lockout + admin-unlock work; change-password / logout / disable-to-open-mode all work; the last admin can never be locked out. Open mode is unchanged |
| **Per-user labels** | Each logged-in account sees only its own device labels in scan hits + the connected list; open mode (single implicit admin) is unchanged from prior betas |

**Stop-and-report:** a `[Fed]` SELinux/lifecycle failure in Modules 2/4/5, the service-update rows 6.5/6.6 — run `capture-logs.sh <id>` (`.ps1` on Windows) for the evidence bundle, then fix before promoting 0.1.30 stable. Cosmetic/polish → note as beta-territory. **Module 11 (no-libfuse2)** is the regression check on the already-removed libfuse2 gate (PR #422) — **revert #422 if 11.2 fails**; it doesn't gate 0.1.30-stable on its own. **Ubuntu:** a `[Ubu]` AppArmor/lifecycle failure is captured the same way (AppArmor denial monitor + `capture-logs.sh`); **2b.1 (userns launch) is a potential 0.1.30 "Canonical" blocker** — if the AppImage won't launch on stock Ubuntu 24.04 that gates the Canonical side until the in-app extract-and-run / userns fallback lands. **Do not silently disable the VM's userns restriction to make it pass** — record the stock-VM result first; the `sysctl` / `APPIMAGE_EXTRACT_AND_RUN` workarounds are for *continuing* the rest of the pass, not for declaring 2b.1 green.
