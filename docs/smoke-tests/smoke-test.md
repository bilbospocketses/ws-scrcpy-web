# ws-scrcpy-web — Smoke Test

> **Smoke target: `v0.1.30-beta.72`** — bump this one line each release; everything below is version-agnostic.

The single manual smoke for the **0.1.30 final** gate (the first true Windows + Linux release). It is **execution-ordered** — work top to bottom; within a phase, some rows depend on state left by earlier rows. This doc is the sole source of truth: it consolidates the former module-reference, plain-English, and run-sheet smoke docs into one. For a by-feature view use [§ Index by module](#index-by-module); for terminology use the [§ Glossary](#glossary).

## How to use

1. Do the [Pre-flight setup](#pre-flight-setup) once per machine (setup, not tests — nothing here passes/fails the app).
2. Run [§ The run](#the-run) **in order**. Mark each row in its `☐` box: **`x`** = pass · **`F`** = fail · **`-`** = skipped / N/A.
3. **Platform tags** (distro-aware): we target Windows + **two** Linux families — **Canonical** (Ubuntu **26.04 LTS**, AppArmor) and **Red Hat** (Fedora **44**, SELinux).
   - `[Win]` — the Windows VM only.
   - `[Fedora]` — the Fedora VM only (SELinux-specific: `bin_t`/`var_lib_t` labels, `semanage` fcontext, AVC denials, `restorecon`).
   - `[Ubuntu]` — the Ubuntu VM only (AppArmor, unprivileged-userns AppImage mount, libfuse2-absent, apt).
   - `[Linux]` — run on **both** the Fedora and Ubuntu VMs (distro-neutral Linux behavior).
   - `[Both]` — run **everywhere** (Windows + both Linux VMs).
4. **Stop rule:** if a `[Linux]` SELinux/lifecycle row (Modules 2, 4, 5, the service-update rows 6.5/6.6, or the Module 14 uninstall-cascade rows), a `[Ubuntu]` AppArmor row, or the core flow (scan → connect → stream → shell) **fails** — stop, run `capture-logs.sh <id>` (`.ps1` on Windows) for the evidence bundle, and report before shipping. Cosmetic glitches: note and keep going. See [§ Global pass criteria](#global-pass-criteria).

## Pre-flight setup

**Linux — Fedora 44 VM** (`[Fedora]` + `[Linux]` rows): `getenforce` → **Enforcing**; a 2nd user account + a 2nd admin login; baseline `sudo semanage fcontext -l | grep ws-scrcpy-web` empty (or run `clear-install.sh` for a one-shot verified clean slate); keep `sudo journalctl -f | grep -i avc` running all session (the **SELinux** denial monitor). Download `WsScrcpyWeb-linux-beta.AppImage` from the **latest** release — **don't `chmod +x`**: GUI double-click of a non-`+x` AppImage is the realistic path (it's what surfaced the F1 service-mode bug).

**Linux — Ubuntu 26.04 VM** (`[Ubuntu]` + `[Linux]` rows): a **stock Ubuntu 26.04 LTS desktop** (GNOME, **Wayland-only** — 26.04 removed the X11 GNOME session; legacy X11 runs via XWayland), *untouched* — do **NOT** pre-disable the userns restriction. Confirm the divergent baseline: `cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns` → **`1`** (mount-blocking restriction active), `dpkg -l | grep -i libfuse2` → **empty** (24.04/26.04 ship none — the FUSE2 lib `libfuse2t64` is in *universe*, not installed → this VM is itself a **no-libfuse2 host**, covers 11.1/11.2 natively), `which semanage getenforce` → **not found** (no SELinux). Same 2nd user + 2nd admin. Keep the **AppArmor** monitor `sudo journalctl -k -f | grep -i 'apparmor="DENIED"'` running all session (have `sudo dmesg -w | grep -i 'apparmor.*denied'` handy). Same non-`+x` AppImage. `[Linux]`-tagged rows run here too.

**Linux — Kubuntu 26.04 VM (KDE — recommended 2nd desktop)** (`[Ubuntu]` + `[Linux]` rows): **Kubuntu 26.04 LTS** (KDE Plasma 6.6). Same Ubuntu base ⇒ the **same** userns + no-libfuse2 + AppArmor conditions — but it exercises **KDE** integration the GNOME VM can't: 2b.5's prompt is **polkit-kde**, 2b.7's menu is the **Kickoff** launcher (mind KDE's per-user icon cache), the 2b.1 double-click is via **Dolphin**; KDE natively supports the SNI tray and still offers a **Plasma-on-X11** session. Ubuntu 26.04 GNOME alone covers the whole Ubuntu side; this is a second-desktop confidence pass.

**Windows** (`[Win]` rows): Win11 VM, clean snapshot; three accounts `Admin` / `User1` / `User2`; `regedit` + Task Manager → Startup tab handy. Download `WsScrcpyWeb-beta.msi` from the **latest** release.

**Devices:** an Android device with **Wireless debugging** enabled (Android 11+) reachable from the VM, plus (Windows) one USB device if available.

**Build-prep — the "update from" build (Module 6).** The update rows need an older build to update *from*. The most recent **kept prior release** is **`v0.1.30-beta.68`** (bump when a newer prior is kept). Download its AppImage (and MSI, for Windows) into a separate dir — the asset filename is identical across versions:

```bash
# Linux — the update "from" build
gh release download v0.1.30-beta.68 --repo bilbospocketses/ws-scrcpy-web --pattern 'WsScrcpyWeb-linux-beta.AppImage' --dir ./beta68
chmod +x ./beta68/WsScrcpyWeb-linux-beta.AppImage
# Windows MSI (row 6.8 / the Windows pass):
gh release download v0.1.30-beta.68 --repo bilbospocketses/ws-scrcpy-web --pattern 'WsScrcpyWeb-beta.msi' --dir ./beta68
```

It's a kept release (not an expiring CI artifact), so no retention window to beat. **The latest release is feed-latest**, so any older install updates *to* it.

**No-libfuse2 host (Module 11.1/11.2) — fold it into this run.** Run the Linux smoke on a minimal Fedora 44 host with **no** `libfuse2` (confirm `ldconfig -p | grep -i libfuse.so.2` → empty, `rpm -q fuse-libs` → not installed; a base Fedora cloud/container image ships without it, else `sudo dnf remove fuse-libs` on a throwaway VM). Do the Module 6 update leg there and Module 11 rides along free — 11.1 = launched there at all, 11.2 = that same in-app update. It's the regression check on the **already-removed** libfuse2 gate (PR #422); **revert #422 if 11.2 fails.** Not a 0.1.30-stable blocker on its own — skip to a normal VM if friction, but close Module 11 before any wide-publicity release. **The Ubuntu/Kubuntu 26.04 VMs are themselves no-libfuse2 hosts**, so the smoke there exercises 11.1/11.2 natively on the Canonical side.

**Clean slate — `clear-install.sh` (recommended).** For a one-shot verified teardown of the **entire** install footprint — user- *and* system-scope service, `/opt` + `/var/lib`, dataRoot, tray autostart, the system `.desktop`, **all** SELinux fcontext rules, the single-instance lock, stray processes — run `bash clear-install.sh` (beside this doc). It tears down then prints per-item PASS/FAIL ending in `CLEAN SLATE ✓` / `NOT CLEAN ✗` (exit 0/1); idempotent + safe on an already-clean VM.

**Capture evidence — `capture-logs.sh` / `capture-logs.ps1` (run at every checkpoint).** Run `bash capture-logs.sh <test-id>` / `powershell -ExecutionPolicy Bypass -File capture-logs.ps1 <test-id>` at each capture point — **especially the moment a row fails** — to snapshot all logs + state (AVC, service status/journal, fcontext, SELinux labels, processes, dataRoot / Program Files / temp listings, config, app logs) to a timestamped folder + archive. The numbered output files (`10-avc`, `30-fcontext`, `33-dataroot-ls`, the `70-*.log` app logs, …) map directly to each row's verify step.

**Manual recovery** — the by-hand system-scope subset, to clear a single stuck service without the script:

```bash
sudo systemctl stop WsScrcpyWeb.service; sudo systemctl disable WsScrcpyWeb.service; sudo systemctl reset-failed WsScrcpyWeb.service
sudo rm -f /etc/systemd/system/WsScrcpyWeb.service
sudo rm -rf /opt/ws-scrcpy-web /var/lib/ws-scrcpy-web
sudo semanage fcontext -d '/opt/ws-scrcpy-web(/.*)?'; sudo semanage fcontext -d '/var/lib/ws-scrcpy-web(/.*)?'
sudo systemctl daemon-reload
```

## Glossary

Terms used in the run rows. Linked from a term's first use.

**Linux — Fedora = SELinux · Ubuntu = AppArmor**
- <a id="g-selinux"></a>**SELinux** — Fedora's mandatory security system. Tags every file with a "label" and limits what each program may touch, on top of normal permissions.
- <a id="g-apparmor"></a>**AppArmor** — Ubuntu's mandatory security system (the counterpart to SELinux). Confines programs by **path/profile** rather than by file labels. Fedora has SELinux; Ubuntu has AppArmor; they don't both run.
- <a id="g-userns"></a>**unprivileged user namespaces / the Ubuntu restriction** — a user namespace lets a non-root program briefly act as its own mini-root (e.g. to mount a filesystem). An **AppImage uses exactly this** to mount itself. Ubuntu 23.10/24.04/26.04 ship `kernel.apparmor_restrict_unprivileged_userns = 1`, which **blocks** this — and can stop an AppImage launching. Fedora doesn't restrict it.
- <a id="g-enforcing"></a>**Enforcing** — the SELinux mode where violations are **blocked** (vs *Permissive* = log only). `getenforce` / `sudo setenforce 1`.
- <a id="g-avc"></a>**AVC denial** — one "SELinux blocked something" event in the log. **Zero AVC** = nothing blocked.
- <a id="g-fcontext"></a>**file context (fcontext)** — an SELinux rule: "files under this path get this label." `semanage fcontext -l` lists them.
- <a id="g-bin_t"></a>**bin_t** — the label for "a system program" (runnable; services can't write it).
- <a id="g-var_lib_t"></a>**var_lib_t** — the label for "writable app data" (config, logs, data a service may change).
- <a id="g-restorecon"></a>**restorecon** — re-applies the correct SELinux labels (used after an update swaps the binary).
- <a id="g-pkexec"></a>**pkexec / polkit** — Linux's "type your password to allow this one action" — roughly Linux's UAC.
- <a id="g-appimage"></a>**AppImage** — an entire Linux app in one file; mark executable and run, nothing to install.
- <a id="g-fuse"></a>**FUSE / libfuse2** — the tech an AppImage uses to mount itself. Newer "type-2" AppImages bundle FUSE inside, so the host needs no `libfuse2` — which matters because **Ubuntu 24.04/26.04 ship none**.
- <a id="g-systemd"></a>**systemd / unit / service · ExecStart** — Linux's background-service manager; a "unit" file defines a service; **ExecStart** names the program it runs. **user-scope** runs as *your* login (no admin); **system-scope** runs as root for the whole machine.
- <a id="g-systemd-run"></a>**systemd-run --collect** — runs a one-off command as a temporary service and cleans it up; used to relaunch the app inside a user's session.
- <a id="g-journalctl"></a>**journalctl / loginctl** — view the systemd log (where AVC/service messages show) / list logged-in sessions (to find the active desktop user to relaunch into).
- <a id="g-paths"></a>**/opt · /var/lib · ~/.local** — system-wide software · its writable data · your per-user data.
- <a id="g-flock"></a>**flock / $XDG_RUNTIME_DIR** — a file lock so only one copy runs per user, kept in the private per-login temp dir.
- <a id="g-etxtbsy"></a>**ETXTBSY ("text file busy")** — the error from overwriting a running program. The updater dodges it by *renaming* the new file into place.
- <a id="g-audit2allow"></a>**audit2allow** — auto-writes SELinux rules. We avoid its broad suggestions; if SELinux blocks something, add a *narrow, targeted* rule.

**Android / adb**
- <a id="g-adb"></a>**adb · Wireless debugging** — Android Debug Bridge (the tool that talks to devices); an Android 11+ option letting adb connect over Wi-Fi.
- <a id="g-scrcpy"></a>**scrcpy · scrcpy-server · kill-server** — the screen-mirroring engine; a small server runs on the phone; `kill-server` shuts adb's daemon down cleanly.
- <a id="g-udid"></a>**udid** — a device's unique id; the key used to remember per-device settings.

**Windows · App / packaging**
- <a id="g-msi"></a>**MSI · PerMachine** — a standard Windows installer; PerMachine = installed once for **all** users under Program Files.
- <a id="g-uac"></a>**UAC · HKLM …\Run · Fast User Switching** — Windows' admin prompt · the registry "start at login" spot · switching users without logging out.
- <a id="g-tray"></a>**tray · snapshot** — the system-tray icon + its background process · a saved VM state to roll back to (start clean so old installs don't skew results).
- <a id="g-velopack"></a>**Velopack · dataRoot · node-pty · exit 75** — the cross-platform installer + auto-updater · the folder holding `config.json`/deps/logs · powers the in-app adb-shell terminal (its "AttachConsole" log noise is harmless) · the launcher's "restart me" exit code (a normal quit is `exit 0`).

## Index by module

By-feature lookup into the run rows below (numeric order; the body itself is execution-ordered).

- **Module 1 — Install & first-run:** [1.1](#t-1-1) · [1.2](#t-1-2) · [1.3](#t-1-3) · [1.4](#t-1-4) · [1.5](#t-1-5) · [1.6](#t-1-6) · [1.7](#t-1-7) · [1.8](#t-1-8) · [1.9](#t-1-9) · [1.10](#t-1-10)
- **Module 2 — Linux layout & SELinux `[Fedora]`:** [2.1](#t-2-1) · [2.2](#t-2-2) · [2.3](#t-2-3) · [2.4](#t-2-4)
- **Module 2b — Ubuntu: AppArmor, userns & FUSE `[Ubuntu]`:** [2b.1](#t-2b-1) · [2b.2](#t-2b-2) · [2b.3](#t-2b-3) · [2b.4](#t-2b-4) · [2b.5](#t-2b-5) · [2b.6](#t-2b-6) · [2b.7](#t-2b-7)
- **Module 3 — Multi-user & single-instance:** [3.1](#t-3-1) · [3.2](#t-3-2) · [3.3](#t-3-3) · [3.4](#t-3-4) · [3.5](#t-3-5) · [3.6](#t-3-6) · [3.7](#t-3-7) · [3.8](#t-3-8)
- **Module 4 — Service mode:** [4.1](#t-4-1) · [4.2-user](#t-4-2-user) · [4.2-system-cli](#t-4-2-system-cli) · [4.2-system-gui](#t-4-2-system-gui) · [4.3](#t-4-3) · [4.4](#t-4-4) · [4.5](#t-4-5) · [4.6](#t-4-6)
- **Module 5 — Lifecycle: uninstall → relaunch / handoff:** [5.1](#t-5-1) · [5.2](#t-5-2) · [5.3](#t-5-3) · [5.3a](#t-5-3a) · [5.3b](#t-5-3b) · [5.4](#t-5-4) · [5.5](#t-5-5) · [5.6](#t-5-6) · [5.7](#t-5-7) · [5.8](#t-5-8) · [5.9](#t-5-9) · [5.10](#t-5-10)
- **Module 6 — Updates:** [6.1](#t-6-1) · [6.2](#t-6-2) · [6.3](#t-6-3) · [6.4](#t-6-4) · [6.5](#t-6-5) · [6.6](#t-6-6) · [6.8](#t-6-8)
- **Module 7 — Devices: scan & connect:** [7.1](#t-7-1) · [7.2](#t-7-2) · [7.3](#t-7-3) · [7.4](#t-7-4) · [7.5](#t-7-5)
- **Module 8 — scrcpy streaming:** [8.1](#t-8-1) · [8.2](#t-8-2) · [8.3](#t-8-3) · [8.4](#t-8-4) · [8.5](#t-8-5)
- **Module 9 — adb in modals:** [9.1](#t-9-1) · [9.2](#t-9-2) · [9.3](#t-9-3) · [9.4](#t-9-4) · [9.5](#t-9-5)
- **Module 10 — Logs & sanity:** [10.1](#t-10-1) · [10.2](#t-10-2) · [10.3](#t-10-3) · [10.4](#t-10-4) · [10.5](#t-10-5) · [10.6](#t-10-6)
- **Module 11 — Velopack 1.2.0 / no-libfuse2:** [11.1](#t-11-1) · [11.2](#t-11-2) · [11.3](#t-11-3) · [11.4](#t-11-4)
- **Module 12 — Stop server & exit:** [12.1](#t-12-1) · [12.2](#t-12-2) · [12.3](#t-12-3) · [12.4](#t-12-4) · [12.5](#t-12-5)
- **Module 13 — Settings: bookmark & reset prompts:** [13.1](#t-13-1) · [13.2](#t-13-2) · [13.3](#t-13-3)
- **Module 14 — Linux Server-section UX:** [14.1](#t-14-1) · [14.2](#t-14-2) · [14.3](#t-14-3) · [14.4](#t-14-4) · [14.5](#t-14-5) · [14.6](#t-14-6) · [14.7](#t-14-7)
- **Module 15 — Windows Server-section uninstall + stop-exit:** [15.1](#t-15-1) · [15.2](#t-15-2) · [15.3](#t-15-3) · [15.4](#t-15-4) · [15.5](#t-15-5)
- **Module 16 — Accessibility & theming:** [16.1](#t-16-1) · [16.2](#t-16-2) · [16.3](#t-16-3) · [16.4](#t-16-4) · [16.5](#t-16-5) · [16.6](#t-16-6)
- **Module 18 — Auth subsystem (opt-in login):** [18.1](#t-18-1) · [18.2](#t-18-2) · [18.3](#t-18-3) · [18.4](#t-18-4) · [18.5](#t-18-5) · [18.6](#t-18-6) · [18.7](#t-18-7) · [18.8](#t-18-8) · [18.9](#t-18-9) · [18.10](#t-18-10) · [18.11](#t-18-11) · [18.12](#t-18-12)
- **Module 19 — Per-user device labels:** [19.1](#t-19-1) · [19.2](#t-19-2) · [19.3](#t-19-3)

## The run

Mark each `☐`: `x` pass · `F` fail · `-` skip. Boxes start empty — this is a fresh pass. Reset to a clean slate first (`bash clear-install.sh`), then re-download the latest AppImage (no `chmod +x`).

### #6 — First install + the beta.48 port-discovery re-confirm

> Run **first** on the fresh download. **Order matters — check 4.1 in the no-service window (after 1.2, before 4.2-user):** installing any service flips `scopeRadioState.locked`, locking the scope radios read-only, so "system becomes selectable" is only observable before any service exists.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-1-2"></a> **1.2** `[Linux]` Accept → install + delete original | GUI double-click the non-`+x` [AppImage](#g-appimage) → **yes, all users** → one [pkexec](#g-pkexec) | Binary at `/opt/ws-scrcpy-web/`; `/opt/ws-scrcpy-web/VERSION` = the smoke-target version; system `.desktop` present; app runs; the original `~/Downloads` AppImage is **gone**. |
| ☐ <a id="t-4-1"></a> **4.1** `[Linux]` System-scope gate | **Before installing any service** (a service install flips `scopeRadioState.locked` → radios read-only; see 4.4): Settings → service → pick **system** scope | Install greyed + modal "requires installing system-wide first"; **user** scope available; after a machine-wide install → **system** becomes selectable + un-greyed. |
| ☐ <a id="t-1-7"></a> **1.7** `[Linux]` Cold-start opens one tab *(D1, beta.62)* | After 1.2, fully quit → GUI-launch the `.desktop`/AppImage, still **no service** | Server boots **and exactly one** browser tab opens (previously took a 2nd click); a later web-port-change **restart** does **not** open a 2nd tab. |
| ☐ <a id="t-4-2-user"></a> **4.2-user** `[Linux]` Install user scope | Settings → service → **user** scope → install (no elevation) | Home ExecStart; service active; stable ExecStart; **no** "port discovery timed out" (the beta.48 fix); no [AVC](#g-avc). |
| ☐ <a id="t-1-9"></a> **1.9** `[Both]` First-run dependency-bootstrap banner + Retry | Force a failed first-run dep download — start the app **offline** / block the host so adb / scrcpy-server / node-pty can't fetch | Home shows the **"⚠ Setup incomplete — &lt;names&gt; failed to download. Check your network connection."** banner + **Retry**; restore network → **Retry** re-attempts (`POST /api/dependencies/retry-install`) and the banner **clears** on success. |

### #7 — Current install checks *(machine-wide + user-service in place, no teardown)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-2-1"></a> **2.1** `[Fedora]` Binary/deps labels | After a machine-wide (and/or system-service) install: `ls -Z /opt/ws-scrcpy-web` | → **[bin_t](#g-bin_t)** (`VERSION` + the AppImage both `…:bin_t:s0`). |
| ☐ <a id="t-2-4"></a> **2.4** `[Fedora]` Zero AVC during install | Watch the `journalctl` monitor through 1.2 + a service install | **No** AVC denials. |
| ☐ <a id="t-4-4"></a> **4.4** `[Linux]` Scope-radio legibility + detection *(item 42)* | After a user- and a system-scope install, reopen Settings each time | Selected scope radio's dot a **clearly visible blue** (not washed grey); radios non-interactive but legible (`pointer-events:none` + `tabindex=-1`, **not** `disabled`); the **correct** scope is selected (`resolveActiveScope`). |
| ☐ <a id="t-13-3"></a> **13.3** `[Both]` Server-section layout + web-port inline save *(beta.62)* | Open Settings → inspect the **Server** section (3rd, after Updates + Service) | Top→bottom: **reset welcome & bookmark prompts → web port → [Linux-only] install for all users → stop server & exit → uninstall**; the **web port** row has an inline **save**; status line **empty at rest** (`saving…`/`saved.`/error only after save); change port → save → persists + restarts. |
| ☐ <a id="t-4-6"></a> **4.6** `[Linux]` Service-unit hygiene | After a user-scope install: `cat ~/.config/systemd/user/WsScrcpyWeb.service` (StartLimit* under **[Unit]**) + `journalctl --user -u WsScrcpyWeb -b` (**current boot only**) + `pgrep` | **No** `Unknown key 'StartLimitIntervalSec' in section [Service]` on the current boot; the originating local instance **exits** (`pgrep -fa WsScrcpyWeb` shows only the service's); no false "port discovery timed out" toast on a same-port install. |
| ☐ <a id="t-3-2"></a> **3.2** `[Linux]` Single-instance ([flock](#g-flock)) | Same user, app running → launch a 2nd copy (from `/opt` and from home) | 2nd launch **blocked** (flock on `$XDG_RUNTIME_DIR`); no 2nd server; existing URL opens. |
| ☐ <a id="t-10-1"></a> **10.1** `[Both]` Service status API | Browse `/api/service/status` | JSON with correct `platform`, `supported`, `status`. |
| ☐ <a id="t-10-3"></a> **10.3** `[Linux]` Logs clean | Tail `launcher.log` + `ws-scrcpy-web.log` under `~/.local/share/.../logs` (or `/var/lib/.../logs` for system) — canonical logs; `server.log`/`service.log` are thin crash-catchers; a `.1` backup may appear | No error spam; teardown logs present on stop. |
| ☐ <a id="t-12-2"></a> **12.2** `[Both]` Stop-exit service-mode gating *(SE-4)* | Service installed (Win system; Linux user/system) → Settings → Server | Button **disabled (greyed)** with a neutral note; clicking fires **no** shutdown POST; after **uninstalling** the service it **re-enables** (re-gates on status refresh, no reload). |

### #7A — Browser UX & accessibility *(app running; no device needed)*

> Browser-only — run any time the app is up. Repeat the visual rows in **both** light and dark themes.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-16-1"></a> **16.1** `[Both]` Light/dark theme switch | Toggle the theme light ↔ dark; open a couple of modals + the stream view in each | Whole UI recolors live — backgrounds, text, borders, buttons — nothing stuck at the other theme; persists across reload. |
| ☐ <a id="t-16-2"></a> **16.2** `[Both]` Keyboard focus ring *(WCAG 2.4.7)* | **Tab** through controls with the keyboard; then **click** with the mouse | 2px accent `:focus-visible` outline on keyboard focus; **not** on a mouse click (old global `:focus{outline:none}` gone). |
| ☐ <a id="t-16-3"></a> **16.3** `[Both]` Reduced motion *(WCAG 2.3.3)* | Turn on OS "reduce motion" → reload → trigger modals/spinners/transitions | Animations collapse to **near-instant** (`prefers-reduced-motion`); turn off → normal animation returns. |
| ☐ <a id="t-16-4"></a> **16.4** `[Both]` Light-mode status tints | In **light** theme: select a file row, hover delete, (update run) hover apply-update | Tints render as proper light shades via the danger/success tokens — **not** off-shade dark channel values. |
| ☐ <a id="t-16-5"></a> **16.5** `[Both]` Embed page lang | Open `embed.html`; inspect `<html>` | `<html>` has a **`lang`** attribute (a11y), matching the app shell. |
| ☐ <a id="t-16-6"></a> **16.6** `[Both]` Theme first-paint no-FOUC *(beta.67)* | OS set **dark** (or light) with **no saved theme** (fresh profile / right after a reset) → load the app, watch the very first paint | Initial paint matches the **OS `prefers-color-scheme`** — **no flash** of the wrong theme — then your saved choice takes over once loaded. |
| ☐ <a id="t-10-4"></a> **10.4** `[Both]` Per-instance token / reload-on-restart *(beta.66 security)* | Restart the server (web-port save, or stop & relaunch); then `curl /api/service/status` with no cookie | After a restart the open tab must be **reloaded** to reconnect (new per-instance token each boot, `SameSite=Strict` `HttpOnly` cookie); cookie-less `curl` **rejected** on the sensitive API; normal browser use unchanged. |
| ☐ <a id="t-10-5"></a> **10.5** `[Both]` 404 + security headers *(beta.66 security)* | `curl -I` a missing `/no-such-asset.js` and `/`; then load a deep in-app route + refresh | Missing asset / unknown API → **404** (not the shell with 200); in-app route still falls back to the shell; every static response carries **`X-Content-Type-Options: nosniff`** + **`X-Frame-Options: SAMEORIGIN`**. |
| ☐ <a id="t-10-6"></a> **10.6** `[Both]` `allowedHosts` reverse-proxy opt-in *(beta.67)* | Set `allowedHosts: ["devices.example.com"]` in `config.json` → restart; `curl -H 'Host: devices.example.com'` and `-H 'Host: evil.example.net'` `…/api/service/status` | **Listed** host **served** (200); **unlisted** domain Host still **403** (DNS-rebinding guard); empty/unset → only `localhost` + IP literals pass. |

### #7B — Ubuntu (AppArmor / userns / FUSE) 🐧 *(stock Ubuntu 26.04 — GNOME; + optional Kubuntu KDE; AppArmor monitor running)*

> The Canonical-side counterpart to the SELinux rows. Run every row on the **stock** Ubuntu 26.04 VM (no userns pre-disable). 2b.5 / 2b.7 are **GNOME**-specific; on the **Kubuntu (KDE)** host they map to **polkit-kde** and the **Kickoff** launcher + KDE icon cache.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-2b-1"></a> **2b.1** `[Ubuntu]` Userns AppImage launch ⚠️ **(potential 0.1.30 "Canonical" blocker)** | Stock Ubuntu 26.04 ([userns](#g-userns) `apparmor_restrict_unprivileged_userns` = `1`, **not** pre-disabled) → run the AppImage **both** ways: terminal `./WsScrcpyWeb-linux-beta.AppImage; echo "exit=$?"` **and** GUI double-click (GUI swallows the error the terminal shows) | **PASS:** app launches, web UI reachable. **FAIL (the risk):** `fuse: mount failed` / userns `clone` EPERM / silent no-op; the [AppArmor](#g-apparmor) monitor shows `DENIED … class="namespace"`. A static-FUSE runtime does **not** bypass userns. **On fail:** the in-app extract-and-run / userns-detection fallback is the tracked code fix; workaround `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` **or** `APPIMAGE_EXTRACT_AND_RUN=1`. **Record the stock-VM result FIRST — do not silently disable the restriction and re-run.** |
| ☐ <a id="t-2b-2"></a> **2b.2** `[Ubuntu]` libfuse2 absent by default | `dpkg -l \| grep -i libfuse2` → empty; `ldconfig -p \| grep -i libfuse.so.2` → empty; then launch (assuming 2b.1 passes) | Launches with **no** libfuse2 ever installed — the Canonical-native no-libfuse2 case (11.1/11.2 ride here); the type-2 runtime carries its own [FUSE](#g-fuse); no "dlopen libfuse" error. |
| ☐ <a id="t-2b-3"></a> **2b.3** `[Ubuntu]` AppArmor zero-denials (service `/opt` exec) | With a **system-scope** service running (from 2b.4): `sudo journalctl -b \| grep 'apparmor="DENIED"'` and `sudo dmesg \| grep -i 'apparmor.*denied'` | **Empty** — the `/opt/ws-scrcpy-web` binary + deps run **unconfined**; any DENIED naming `/opt/ws-scrcpy-web/…` ⇒ needs an AppArmor profile / complain-mode note (the Ubuntu analogue of an AVC failure). |
| ☐ <a id="t-2b-4"></a> **2b.4** `[Ubuntu]` Install/uninstall with no SELinux tooling | Install the **system** service via GUI (pkexec), then in-app uninstall; watch `journalctl -u WsScrcpyWeb.service` (install) + the launcher log (uninstall) | Install reaches `enable --now` + binds the port **despite** unguarded `semanage`/`restorecon` being ENOENT (they no-op); uninstall → **CLEAN SLATE** (`bash clear-install.sh` → CLEAN SLATE on Ubuntu, validating the script there for the first time); benign `… spawn failed` ERROR lines for `semanage`/`update-desktop-database` do **not** abort teardown. |
| ☐ <a id="t-2b-5"></a> **2b.5** `[Ubuntu]` pkexec polkit dialog (GNOME) | Ubuntu GNOME → trigger system-scope **install** + in-app **uninstall**; once, **decline** | A real **graphical** polkit password dialog (not a tty prompt, not an instant decline); decline → local app relaunches, state intact (exit-126 path); approve → completes. |
| ☐ <a id="t-2b-6"></a> **2b.6** `[Ubuntu]` `systemd-run --user` survival | User-scope **install** (GUI) then **uninstall** as that user | Install-handoff helper starts the unit after the local instance exits (`systemctl --user is-active WsScrcpyWeb` → active; browser reconnects); after uninstall the post-uninstall local relaunch reappears (window/tab returns) — the [`systemd-run --user --collect`](#g-systemd-run) transient unit (carried a "verify on Fedora" marker, never run on Ubuntu) survives on Ubuntu's systemd. |
| ☐ <a id="t-2b-7"></a> **2b.7** `[Ubuntu]` Desktop menu entry + icon (GNOME) | After a machine-wide install, open GNOME Activities / app grid; then uninstall | The **ws-scrcpy-web** entry + icon appear (not a placeholder; `ls /usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png` exists) and **disappear** after uninstall (`gtk-update-icon-cache` / `update-desktop-database` ran). |

### #8 — User-service uninstall → local mode

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-5-8"></a> **5.8** `[Linux]` User-scope uninstall → relaunch local | User-scope service installed, in use → uninstall **as that user** | `--user` unit stopped/disabled/`reset-failed`, file removed (`~/.config/systemd/user/WsScrcpyWeb.service` absent); the old service's escaped adb daemon is reaped; after relaunch **only the single local instance** runs (launcher + node + its own pre-warmed adb) — **no** leftover service procs, **no** 2nd instance, **no** `scrcpy-server` (`pgrep -fa WsScrcpyWeb` = one launcher + one node; `pgrep -x adb` = one; `pgrep -f scrcpy-server` = none); app relaunches local mode, browser reconnects, Settings shows not-installed. |
| ☐ <a id="t-12-1"></a> **12.1** `[Linux]` Local-mode clean exit + adb teardown *(SE-3)* | Local mode, a device + a stream running → Settings → Server → "stop server & exit" → confirm | Tab self-closes or blanks to **"app stopped — you can close this tab"**; process tree exits clean (`pgrep -fa WsScrcpyWeb` / `pgrep -fa adb` show nothing from this instance); log shows `Stopping adb daemon (kill-server)`; the launcher does **not** restart (clean `exit 0`, not the 75 restart sentinel). |
| ☐ <a id="t-12-4"></a> **12.4** `[Linux]` DATA_ROOT override honored *(item 40a)* | Launch with `DATA_ROOT=/tmp/wssw-dataroot` exported | Config/deps/logs land under `/tmp/wssw-dataroot` (Node side **and** launcher agree — same root for spawn and adb-reap/tray paths). |
| ☐ <a id="t-13-1"></a> **13.1** `[Both]` Bookmark global-dismiss *(beta.32)* | Reach the bookmark / port-change reminder → check "don't show again — ever, even when the port changes" → confirm | The confirmation uses the white-outline buttons; checking it **supersedes + disables** the per-port checkbox; persists (`bookmarkDismissedGlobally` in `config.json`). |
| ☐ <a id="t-13-2"></a> **13.2** `[Both]` Reset welcome & bookmark prompts *(beta.40; broadened beta.67)* | **Before clicking**, set a non-default theme + a device label + a per-device stream setting so you can see them wiped. Then Settings → "reset welcome and bookmark prompts" | Re-shows the welcome modal **and** clears the bookmark dismissal (per-port **and** global) — **and wipes all other per-user settings**: theme, device labels, per-device stream/audio, icon size, scan subnets (`POST /api/settings/reset` → `clearForUser` on both stores). Regression: the welcome reset must **not** re-suppress the per-port bookmark. |

### #9 — System-scope service pass

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-4-2-system-cli"></a> **4.2-system-cli** `[Linux]` Install system scope — headless CLI | Root shell: `sudo ./WsScrcpyWeb --install-system-service [--port N]`. Stages binary+deps to `/opt` (bin_t), state `/var/lib` ([var_lib_t](#g-var_lib_t) default — no custom rule), adds the `/opt` bin_t [fcontext](#g-fcontext) rule, writes the unit (`Restart=on-failure`/`RestartSec=2`, `WantedBy=multi-user.target`), `enable --now`. No GUI, no pkexec | `/opt` ExecStart as root; state in `/var/lib`; `semanage fcontext -l \| grep ws-scrcpy-web` shows only the `/opt` bin_t rule; `systemctl is-active` = active; **reboot: service still active**; zero AVC. |
| ☐ <a id="t-4-2-system-gui"></a> **4.2-system-gui** `[Linux]` Install system scope — desktop pkexec takeover | Settings → service → **system** scope → install → ONE awaited pkexec (no timeout, no kill). Root core enables+starts the unit; the local copy is still on the port so the first bind fails; systemd's `Restart=on-failure` retries | UI shows **"switching to the system service…"**; the local copy **gracefully exits**, freeing the port; systemd's next retry (≤ ~2s) binds; the UI (polling `/api/service/status`) **reconnects — exactly one tab, a few seconds, no manual step**, no kill/EPERM. |
| ☐ <a id="t-4-5"></a> **4.5** `[Both]` Confirm-dialog button style *(item 35)* | Open the service install/uninstall "privileges required" confirms (and "end shell session"). **Linux:** the service confirm fires only for **system** scope | Cancel/confirm buttons use the shared **white-outline + white-text** style, matching the welcome/bookmark/service-first-run modals. |
| ☐ <a id="t-2-2"></a> **2.2** `[Fedora]` State labels | `ls -Z /var/lib/ws-scrcpy-web` | → **var_lib_t** (config/logs/deps the service writes). |
| ☐ <a id="t-2-3"></a> **2.3** `[Fedora]` fcontext rules registered | After a system-service install: `sudo semanage fcontext -l \| grep ws-scrcpy-web` | **Only** the `/opt` bin_t rule. `/var/lib` is var_lib_t by policy default — no custom rule. |
| ☐ <a id="t-3-3"></a> **3.3** `[Linux]` Service-defer | System service running → launch locally | Defers to the service (opens its URL); no 2nd server. |
| ☐ <a id="t-5-1"></a> **5.1** `[Linux]` Same-user uninstall (served-by-service) | System service installed, in use → Settings → uninstall. ServiceApi spawns an out-of-cgroup [`systemd-run --system`](#g-systemd-run) `… <staged /opt AppImage> --linux-service-teardown --scope system` (pkexec only when caller isn't root). Teardown removes the unit, `semanage fcontext -d`, `rm -rf` `/opt` + `/var/lib` | PASS = teardown verified: service **stopped + unit removed**; `/opt/ws-scrcpy-web` **gone**; `/var/lib/ws-scrcpy-web` **gone**; `semanage fcontext -l \| grep ws-scrcpy-web` **empty**; zero AVC. Tab: **relaunch the app manually** if it doesn't reconnect — auto-relaunch after a served-by-service uninstall is a tracked follow-up; do NOT pass/fail on it. |
| ☐ <a id="t-5-4"></a> **5.4** `[Fedora]` fcontext cleanup | After any uninstall | `sudo semanage fcontext -l \| grep ws-scrcpy-web` → **empty** (the `/opt` rule gone; `/var/lib` never had one). |
| ☐ <a id="t-5-9"></a> **5.9** `[Linux]` System-scope uninstall message *(item 40b)* | After a system-scope uninstall (no active session) | The "service removed — relaunch the app manually" follow-up renders as a **neutral info line** — **not** red, **no** "retry" button. |
| ☐ <a id="t-5-3a"></a> **5.3a** `[Linux]` Headless uninstall `--keep-state` *(run-sheet alias: 5.x-keepstate)* | `sudo ./WsScrcpyWeb --uninstall-system-service --keep-state`, then reinstall via `--install-system-service` | `config.json` + `logs/` survive under `/var/lib`; `dependencies/`, `bin/`, `control/` removed; reinstall **reuses the saved port**. |
| ☐ <a id="t-5-3b"></a> **5.3b** `[Linux]` Ubuntu install + boot + uninstall *(run-sheet alias: 4.2-system-ubuntu)* | Install, reboot, and uninstall on an **Ubuntu** host (no SELinux) | All steps succeed; `semanage`/`restorecon` calls are no-ops; AppArmor needs no per-path relabel; no AVC concept applies. |

### #10 — First-run variants 🧩 *(needs fresh snapshot / 2nd user / 2nd admin)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-1-1"></a> **1.1** `[Linux]` First-run modal | Run the home AppImage with no prior install/decline marker | "install for all users?" modal: 3 stacked lines + **yes, all users** / **no, me only**; **no ×**; **Esc** and **click-outside do nothing** (forced choice). |
| ☐ <a id="t-1-3"></a> **1.3** `[Linux]` Decline + remember | Fresh state / 2nd user → **no, me only** | Runs in place from `~/.local`; **next launch does NOT re-prompt**; original AppImage **kept**. |
| ☐ <a id="t-1-4"></a> **1.4** `[Linux]` Headless first-run | Launch over SSH / no display | No hang; graceful fallback, no crash. |
| ☐ <a id="t-3-1"></a> **3.1** `[Linux]` Per-user launch | Log in as a **2nd user**; launch from the apps menu (`.desktop`) | Runs under that user's login, own `~/.local` data; "Open" reaches the same backend port. |
| ☐ <a id="t-5-2"></a> **5.2** `[Linux]` Different-admin uninstall | Uninstall via **pkexec as a different admin** (triggers `systemd-run --system` teardown same as 5.1) | PASS = teardown verified: service stopped + unit removed; `/opt` + `/var/lib` gone; fcontext clean; zero AVC. Tab: **relaunch manually** if it doesn't reconnect — auto-relaunch is a tracked follow-up. |
| ☐ <a id="t-5-3"></a> **5.3** `[Linux]` Headless uninstall | `sudo ./WsScrcpyWeb --uninstall-system-service` (no active graphical session) | No relaunch; manual fallback; **no orphan**; no `data_root_for_linux` panic; full teardown: unit removed, `/opt` + `/var/lib` gone. |

### #11 — Updates 🧩 *(needs the beta.68 "update-from" release — see Pre-flight)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-6-1"></a> **6.1** `[Both]` Update check | Settings → Updates → Check | A beta.68 install **offers the latest**; the latest reports **up-to-date**; no error spam in `server.log`/`launcher.log`. |
| ☐ <a id="t-6-2"></a> **6.2** `[Linux]` Local-mode (home) update apply + relaunch *(#27)* | beta.68 home AppImage in **local mode** (no service) → Settings → Updates → Apply | Downloads + SHA-256 verifies; the "updating…" overlay above Settings; the AppImage **swaps and auto-relaunches** onto the latest unattended; browser reconnects; About = the new version. **Edge:** also confirm apply on an instance relaunched right after a user-scope service uninstall (the `systemd-run --collect` cgroup case). |
| ☐ <a id="t-6-3"></a> **6.3** `[Linux]` No-service `/opt` update *(one pkexec)* | Machine-wide `/opt`, **no** service → trigger update | One pkexec; `/opt` swapped by **rename**; relabel bin_t + [restorecon](#g-restorecon); VERSION bumps; relaunches as the user; reconnects. No [ETXTBSY](#g-etxtbsy); FUSE intact. |
| ☐ <a id="t-6-4"></a> **6.4** `[Linux]` Newer home over `/opt` | `/opt` at beta.68; place a newer home AppImage; launch | Bootstrapper runs home in place → offers "update the system-wide install to vX" → accept → swap → next launch runs updated `/opt`. |
| ☐ <a id="t-6-5"></a> **6.5** `[Linux]` User-scope service update apply *(item 39)* | User-scope service installed → Settings → Updates → Apply | The `--user` unit stops, the home `$APPIMAGE` swaps, the unit restarts on the **same** web port, browser reconnects via the overlay. **No prompt.** |
| ☐ <a id="t-6-6"></a> **6.6** `[Linux]` System-scope headless service update apply *(item 39 — the SELinux risk)* | System-scope service installed → Apply | **No** polkit prompt (root self-update); `/opt` copy swaps; restorecon re-applies bin_t; unit restarts; **zero AVC**. The `systemd-run` apply helper **survives `systemctl stop`** of the unit it's restarting (out-of-cgroup); the FUSE unmount settles within the helper's ~15s swap-retry window. If SELinux blocks the `init_t` `/opt` write or relabel → **narrow targeted policy only, never broad [audit2allow](#g-audit2allow)**. Updated deps land **bin_t** with no relabel — confirm `ls -Z /opt/ws-scrcpy-web/dependencies`. |

### #12 — Velopack / no-libfuse2 🧩 *(run the smoke on a no-libfuse2 host — folds in 11.1/11.2)*

> Regression check on the already-removed libfuse2 gate (PR #422) — **revert #422 if 11.2 fails.** Skippable if the host is friction (doesn't gate 0.1.30), but close it before wide publicity.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-11-1"></a> **11.1** `[Linux]` No-libfuse2 launch | On a minimal distro/container **without** `libfuse2`, run the smoke-target AppImage | Launches (the type-2 runtime has FUSE embedded); **no** `libfuse.so.2` / "dlopen libfuse" error. |
| ☐ <a id="t-11-2"></a> **11.2** `[Linux]` No-libfuse2 in-app update | From that no-libfuse2 host, run the Module 6 in-app update (this row IS the 6.x flow on the no-libfuse2 host) | Update succeeds. The libfuse2 gate code is already removed (`SystemdClient.ts`, `UpdatesApi.ts`, `UpdateEvents.ts`, `SettingsModal.ts`, README); this is the regression check that the type-2 runtime self-updates with no host libfuse2 — **revert PR #422 if it fails.** |
| ☐ <a id="t-11-3"></a> **11.3** `[Linux]` Locator fix watch (velopack#921) | During **6.3 / 6.4 / 6.6** apply + relaunch on the machine-wide `/opt` install | Apply + relaunch land correctly; no [Velopack](#g-velopack) locator root-path regression (the 1.2.0 fix targets exactly this path). |

### #13 — Devices / scrcpy / adb 📱 *(needs a real Android device, Wireless debugging)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-7-1"></a> **7.1** `[Both]` Wireless connect | Home → "scan/connect" → enter device `ip:port` (or scan a subnet) | adb connects; device card appears in "connected devices" within ~5s. |
| ☐ <a id="t-7-2"></a> **7.2** `[Both]` Scan subnet *(+ private-range guard)* | Open the scan-network modal; run a subnet scan; also try a **public** CIDR (e.g. `8.8.8.0/24`) | Reachable devices listed; selecting one connects; bad/empty subnets handled gracefully (no hang). A **public** range is **refused** — scans restricted to private LAN ranges (beta.66 security). |
| ☐ <a id="t-7-4"></a> **7.4** `[Both]` Device list updates in place *(beta.66 perf)* | Connect/rename/disconnect a few devices and watch the "connected devices" list | Rows update **in place** — diffed by device id, not rebuilt on every server message (no whole-list flicker); labels load **once per refresh**, not once per row; add/remove/rename reflects within ~1s. |
| ☐ <a id="t-7-5"></a> **7.5** `[Both]` Remembered device model in scan hits *(beta.67)* | Connect a device once (facts recorded), disconnect it, then re-run a network **scan** | The scan hit shows the device's **remembered manufacturer/model** from the last connection **before** you reconnect — the shared `devices` table (`observed.model`) rehydrates it. |
| ☐ <a id="t-8-1"></a> **8.1** `[Both]` Video stream | Click a device → stream/config modal → connect; then resize the browser window | Live video renders smoothly; no decode errors. The video cell fills its area with the **correct aspect ratio** — no stretch/squish/overflow — and **rescales on resize** while keeping aspect (beta.66 #106: `.video` grid-auto-sized; resolution via `--video-width`/`--video-height`). |
| ☐ <a id="t-8-2"></a> **8.2** `[Both]` Control | In the stream, click/scroll/type and use the on-screen device buttons | Touch + key input reaches the device; navigation works. |
| ☐ <a id="t-8-3"></a> **8.3** `[Both]` Audio | Enable audio in the stream settings (Android 11+) | Audio plays; codec/source toggle works. |
| ☐ <a id="t-8-4"></a> **8.4** `[Both]` Codec/encoder settings *(+ resize persistence)* | Change display/codec/encoder/fps/bitrate → reconnect; then **resize the window** and reopen the device | Settings apply; stream restarts with the new params; persisted **per device** on next open **and** retained across a window resize — keyed per device, not per window size (the beta.67 fix). |
| ☐ <a id="t-8-5"></a> **8.5** `[Both]` H.265 (HEVC) decode *(#41)* | Set the video codec to **H.265/HEVC** → connect; then repeat with **H.264** | **Both** codecs decode + render in-browser (WebCodecs) — live frames, no decode errors; H.264 is the baseline. |
| ☐ <a id="t-9-1"></a> **9.1** `[Both]` Shell modal | Device → "shell" → run `getprop ro.product.model`, a couple commands | Interactive terminal works; output correct; closing the modal ends the session cleanly (no orphaned adb shell). |
| ☐ <a id="t-9-2"></a> **9.2** `[Both]` File listing/transfer *(+ quiet console, beta.66)* | Device → file-list modal → browse, change icon size, push/pull a file — console open | Listing loads; icon-size pref persists; transfers succeed. Console stays **quiet** — per-message traces gated behind a debug flag. Verify: `localStorage.setItem('ws-scrcpy-web-debug','true')` → reopen → `[ListFiles]` traces reappear; `removeItem` → silent again. |
| ☐ <a id="t-9-3"></a> **9.3** `[Both]` Device actions | Use sleep/wake (and power/nav actions) on the device card | Buttons reflect state (green/red), actions take effect. |
| ☐ <a id="t-9-4"></a> **9.4** `[Both]` Dependencies panel *(admin-gated)* | Home → **Dependencies** section: read the table (Installed/Latest/Status), **check for updates**, run a per-dependency **update**, then **restart server** | Table loads; check-for-updates populates Latest; an **update** fetches + swaps that dependency; **restart server** cycles + comes back. With auth on (Module 18) the whole panel + APIs are **admin-only** (`requireAdmin`): a `user`-role account doesn't see it; a direct `POST /api/dependencies/:name/update` is **401/403**. |
| ☐ <a id="t-9-5"></a> **9.5** `[Both]` Shell-unavailable shows a reason | On a host where the `node-pty` prebuilt is missing/failed to load, open a device + look for the **shell** affordance | The shell affordance surfaces an **actionable reason** (`/api/capabilities` → `shell:false` + `shellReason`: download failed / no prebuilt for this Node ABI / native load failure) **instead of silently vanishing**. |

### #14 — Windows pass 🪟 *(clean Win11 snapshot, accounts Admin/User1/User2, the MSI)*

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-1-5"></a> **1.5** `[Win]` Fresh MSI install | Clean snapshot, log in `Admin`; install `WsScrcpyWeb-beta.msi` | Installs clean; browser auto-opens `http://localhost:<port>`; WelcomeModal shows; Settings → About = the smoke-target version; installs to `C:\Program Files\WsScrcpyWeb\`. |
| ☐ <a id="t-1-6"></a> **1.6** `[Win]` Reinstall reuses config *(H.2)* | After 5.7's full uninstall, reinstall the MSI | Installs clean; existing `config.json` under dataRoot **detected + reused** (no skeleton overwrite); app reachable on the previously-saved port. |
| ☐ <a id="t-1-8"></a> **1.8** `[Win]` Cold-start opens one tab *(D4, beta.63)* | App fully stopped → launch (Start-menu/exe), **no service** | Exactly **one** browser tab opens; a web-port-change **restart** and an in-app **update relaunch** do **not** double-tab (the `suppress-browser-open` marker covers Velopack's relaunch). |
| ☐ <a id="t-1-10"></a> **1.10** `[Win]` Install-dir ACL grant + one-time UAC *(install_acl)* | After a **fresh MSI install** (1.5), on the **first app launch** watch for a one-time UAC; then `icacls "C:\Program Files\WsScrcpyWeb"`; then relaunch | First launch fires **one** expected UAC for `icacls … /grant *S-1-5-11:(OI)(CI)M` (MSI strips the hook-time grant); `icacls` then shows **`Authenticated Users:(OI)(CI)(M)`**; a **relaunch fires NO 2nd UAC** (`ensure_writable` early-returns); `launcher.log` shows `install-root grant applied`. This grant lets Velopack's PerMachine updater write the swap — confirm an in-app update (6.8) then applies. |
| ☐ <a id="t-3-4"></a> **3.4** `[Win]` Per-session tray | Service installed; switch `Admin`→`User1`→`User2` via Fast User Switching | Each session gets **exactly one** tray within ~2s; right-click → "Open" loads the app (same backend port for every session). |
| ☐ <a id="t-3-5"></a> **3.5** `[Win]` 2nd tray.exe rejected | With tray running: `start "" "C:\Program Files\WsScrcpyWeb\current\ws-scrcpy-web-tray.exe"` | No 2nd tray; spawned proc exits ~100ms; original tray fine. |
| ☐ <a id="t-3-6"></a> **3.6** `[Win]` Tray respawn after user-kill | Service mode, tray present → **kill `ws-scrcpy-web-tray.exe`** via Task Manager (End task) | Within ~10s (`TRAY_POLL_INTERVAL_SECS`) **exactly one** tray reappears, **with the startup balloon** ("tray started by launcher… use the exit option from the tray menu"); Open still works; repeatedly killing it always brings back exactly one (single-instance mutex blocks doubles). Distinct from the marker-gated *don't*-respawn cases (5.5/6.8). |
| ☐ <a id="t-3-7"></a> **3.7** `[Win]` Single-instance integrity (User vs Admin) | App running, local mode → (a) double-click the exe again; (b) right-click → **Run as administrator** a 2nd instance; (c) a 2nd **elevated** launch | (a) same-integrity 2nd launch **blocked** — exits ~immediately, no 2nd server/tray (`Local\WsScrcpyWeb-SingleInstance-User`; pure no-op, doesn't reopen the browser); (b) the **elevated** instance **is allowed** to coexist (separate `…-Admin` mutex — the "run normal app, then Run-as-admin to uninstall the service" workflow), then exits cleanly; (c) a 2nd elevated launch is **blocked**. |
| ☐ <a id="t-3-8"></a> **3.8** `[Win]` No startup Run-key (supervisor owns the tray) | After a fresh MSI + service install (before any uninstall): `reg query "HKLM\…\Run" /v WsScrcpyWebTray`, same under `HKCU`, and Task Manager → Startup | **Not found** under HKLM **or** HKCU, and **no** ws-scrcpy-web entry on Startup — yet a per-session tray still appears (3.4). Proves the **supervisor poller**, not a Run key, drives the tray. |
| ☐ <a id="t-4-3"></a> **4.3** `[Win]` Install confirm UX | Settings → "install service" → inspect modal; test **cancel**, **Esc**, **backdrop**, then **continue** | AdminConfirmModal "Administrative Privileges Required"; cancel/Esc/backdrop close with **no** UAC, **no** fetch; continue → UAC → service installs, redirects, no WelcomeModal. |
| ☐ <a id="t-5-5"></a> **5.5** `[Win]` Uninstall + handoff affordance | Service mode, Settings as `Admin` → "uninstall service" → continue → Yes on UAC | Button → "uninstalling…"; if handoff >5s → "still waiting for user session…"; ends at the local-mode URL. |
| ☐ <a id="t-5-6"></a> **5.6** `[Win]` Uninstall handoff-failure guard | Service mode; kill all `ws-scrcpy-web-tray.exe`; then uninstall | ~5s → "still waiting…"; ~30s → "couldn't reach the user session…"; button freed; **service STILL installed** (no silent direct uninstall). |
| ☐ <a id="t-5-7"></a> **5.7** `[Win]` Full uninstall | Add/Remove Programs → ws-scrcpy-web → Uninstall as `Admin` | Service stops/unregisters; `Program Files\WsScrcpyWeb` cleared; **user data under dataRoot preserved**; admin tray disappears. (Legacy `HKLM…\Run\WsScrcpyWebTray` removed **if present** — but fresh installs **no longer create any Run key**, so this passes vacuously; the live invariant is **3.8**.) |
| ☐ <a id="t-5-10"></a> **5.10** `[Win]` Non-admin uninstall, UAC declined *(D.6)* | Service mode, as a **standard user** → uninstall service → continue → **decline/cancel** the UAC | Backend returns **403 `reason='uac-declined'`**; frontend "administrative privileges were declined. try again and approve the prompt."; button freed; **service still installed**. (UAC accepted → uninstalls cleanly, back to local mode.) |
| ☐ <a id="t-6-8"></a> **6.8** `[Win]` In-app update apply + tray persists *(SE-2)* | From a prior installed build (beta.68 MSI) → Settings → Updates → Apply | Applies clean; app reachable post-update; the tray **persists across the update** (the `apply-update-pending` marker gates the reap off) — **one** tray after settling, no duplicate/orphan. |
| ☐ <a id="t-7-3"></a> **7.3** `[Win]` USB device | Plug a USB device (authorize the RSA prompt on device) | Appears in connected devices; survives a home-page reload. |
| ☐ <a id="t-10-2"></a> **10.2** `[Win]` Logs clean | Tail `C:\ProgramData\WsScrcpyWeb\logs\{launcher,ws-scrcpy-web}.log` during normal use (canonical logs). `server.log`/`service.log` are thin crash-catchers; a `.1` backup may appear | No `ERR` / `Error:` except known cosmetic node-pty AttachConsole noise. |
| ☐ <a id="t-11-4"></a> **11.4** `[Win]` PerMachine intact | After the 1.5 MSI install, check the install location | Installed PerMachine to `C:\Program Files\WsScrcpyWeb\` (vpk 1.2.0 `--msi --instLocation PerMachine` unchanged). |
| ☐ <a id="t-12-3"></a> **12.3** `[Win]` Local-mode reaps everything *(SE-1)* | Local mode, device + stream live, tray present → Settings → Server → "stop server & exit" → ok | Confirm dialog (title "stop server & exit", modal-styled ok/cancel); server exits (tab self-closes or "app stopped"); the **tray disappears** (launcher reaped it); Task Manager shows **no** lingering launcher/node/tray/bundled `adb.exe` from this instance; **cancel** leaves everything running. |
| ☐ <a id="t-12-5"></a> **12.5** `[Win]` Abnormal-termination JobObject reap *(job_object — the safety net)* | Local mode, device + stream live (Node + node-pty + `adb.exe` + `scrcpy.exe` resident) → **kill `ws-scrcpy-web-launcher.exe`** via Task Manager (End task) — NOT "stop server & exit". Repeat for a service-mode launcher via `sc stop` / Servy stop | Within ~1s the whole tree is gone — **no** `node.exe`/node-pty/`adb.exe`/`scrcpy.exe` from this instance (the Job's `KILL_ON_JOB_CLOSE` reaps them on abnormal launcher death). Immediately MSI-repair/reinstall → **no** `C:\Config.Msi\*.rbf` rename, no "file in use" (v0.1.21 orphan bug stays fixed). The **opposite** branch from 12.3/15.4 (graceful exit *clears* kill-on-close so Update.exe survives). |

### #15 — Server-section UX (Linux) *(rows carry Module 14 ids — see the index)*

> The one-click **install for all users**, the machine-wide start-menu icon, and the in-app **uninstall** flows.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-14-1"></a> **14.1** `[Linux]` Install-for-all-users button | Local (me-only) install running → Settings → **Server** → **install for all users**; authenticate the one prompt | One pkexec; the binary **relocates to `/opt/ws-scrcpy-web/`**; the button then **greys/disables** reading "already installed for all users (/opt)"; the app keeps serving on the same port. |
| ☐ <a id="t-14-2"></a> **14.2** `[Linux]` Start-menu icon | After a machine-wide install (14.1 or 1.2), open the desktop apps menu; also check disk | The launcher entry shows the **ws-scrcpy-web icon** (not a placeholder); `ls /usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png` → exists. |
| ☐ <a id="t-14-3"></a> **14.3** `[Linux]` Complete uninstall — local | Local mode → Settings → **Server** → **uninstall…** → confirm with **"keep my settings & logs" unchecked** | App removed; tab shows "uninstalled — close this tab"; `clear-install.sh` verifies a **CLEAN SLATE** (no leftover binary/deps/config/decline marker). |
| ☐ <a id="t-14-4"></a> **14.4** `[Linux]` Uninstall — user-service cascade | User-scope service installed (machine-wide `/opt` binary) → **uninstall…** → confirm | **One pkexec** (for the `/opt` removal); the `--user` unit is **gone** AND the app is **removed in one pass**; no relaunch. |
| ☐ <a id="t-14-5"></a> **14.5** `[Linux]` Uninstall — system-service cascade | System-scope service installed → **uninstall…** (from the root service context) | Runs **as root, NO pkexec**; `/opt/ws-scrcpy-web` + `/var/lib/ws-scrcpy-web` + the systemd unit are **all gone**; zero AVC. |
| ☐ <a id="t-14-6"></a> **14.6** `[Linux]` Uninstall — keep settings & logs | Uninstall with **"keep my settings & logs" checked** | `config.json` + `logs/` **survive** at the data root (`~/.local/share/WsScrcpyWeb` local, or `/var/lib/ws-scrcpy-web` system); `dependencies/` gone either way; a reinstall reuses the saved port. |
| ☐ <a id="t-14-7"></a> **14.7** `[Fedora]` Uninstall — SELinux clean | After any uninstall, inspect fcontext + the AVC monitor | `sudo semanage fcontext -l \| grep ws-scrcpy-web` → **empty**; zero AVC. |

### #16 — Windows Server-section: in-app uninstall + stop-exit 🪟 *(rows carry Module 15 ids — see the index)*

> New in beta.51, the wipe self-deletion fixed in beta.52. Run on the clean Win11 snapshot after the MSI install.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-15-1"></a> **15.1** `[Win]` In-app uninstall — keep *(from a standard user)* | **From a standard (non-admin) session** (confirm the launcher is medium-integrity in Process Explorer): MSI install → Settings → **Server** → **uninstall** → keep **checked** (default) → uninstall | **One UAC, raised by `Update.exe` itself** — verify the dialog's path/publisher is `…\WsScrcpyWeb\Update.exe`, **not** the launcher; `C:\Program Files\WsScrcpyWeb\` gone; service gone (`sc query WsScrcpyWeb` → not found); tray gone; **ARP entry gone**; `config.json` + `logs/` **survive** under `%ProgramData%\WsScrcpyWeb`, `dependencies/` gone; reinstall reuses the saved port. **Decline** the UAC → install stays intact, no partial teardown. |
| ☐ <a id="t-15-2"></a> **15.2** `[Win]` In-app uninstall — wipe | Same, but **uncheck** keep | As 15.1 but the whole `%ProgramData%\WsScrcpyWeb` is **gone** — incl. `control\operation-server\` (the beta.52 temp-copy-cleaner fix: the deleter runs from a temp copy after the original exits). Capture `capture-logs.ps1 15.2-wipe` and confirm `31-dataroot` shows it absent. |
| ☐ <a id="t-15-3"></a> **15.3** `[Win]` Uninstall modal UX | Open the uninstall modal | Top-layer overlay above Settings; **cancel** white-outline, **uninstall** red text + red border; keep checkbox **checked by default**; cancel/Esc/backdrop = no action. |
| ☐ <a id="t-15-4"></a> **15.4** `[Win]` Stop-exit reaps tray + adb *(item 4)* | Local mode, device + stream live → Settings → **Server** → **stop server & exit** | Tab closes / "app stopped"; Task Manager shows **no** lingering launcher/node/tray/`adb.exe` — the tray is reaped (poll thread stopped first) **and** stray adb is `taskkill`'d. |
| ☐ <a id="t-15-5"></a> **15.5** `[Win]` Server-section order | Settings → Server | Order top→bottom: **reset prompts → web port → stop server & exit → uninstall ws-scrcpy-web** (no "install for all users" on Windows). |

### #18 — Auth subsystem (opt-in login) 🔐 *(new in beta.67 — run top-to-bottom; finish with 18.11)*

> Off by default. Rows after 18.2 assume auth is enabled. Use two browser profiles / private windows (one admin, one regular user). **Finish with 18.11** so the rest of the smoke runs un-gated.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-18-1"></a> **18.1** `[Both]` Default open mode | Fresh install (auth never enabled): load app, open Settings | App loads with **no** login prompt — auth is inert until a user is added. |
| ☐ <a id="t-18-2"></a> **18.2** `[Both]` 🔐 Secure the admin account | Settings → manage users → Add user (auth off); in the red "Secure the admin account" block set admin username + password; also fill New user fields (user role); click **Secure & add user** | "Login is now required. Reloading…" → reloads to the login page; admin password set in the same step (no password-less window). |
| ☐ <a id="t-18-3"></a> **18.3** `[Both]` 🔐 Login | Sign in with the admin credentials from 18.2 | Reloads into the app authenticated; admin sees admin-only Settings sections (web port, dependencies, updates, service, Users). |
| ☐ <a id="t-18-4"></a> **18.4** `[Both]` 🔐 Brute-force lockout + generic error | Log out; attempt login with a wrong password 5× within 5 min; also try a non-existent username | Every failure shows the **same generic** message ("Invalid credentials or the account is temporarily locked.") — no username-existence hint, timing blinded; after the 5th failure the account is locked ~15 min — correct password refused while locked. |
| ☐ <a id="t-18-5"></a> **18.5** `[Both]` 🔐 Admin clears a lockout | As admin: Settings → manage users → unlock the locked account | Account unlocks immediately; can log in again with the correct password. |
| ☐ <a id="t-18-6"></a> **18.6** `[Both]` 🔐 Manage users (role / disable / reset / delete + last-admin guard) | As admin: change a user's role; toggle disable; reset password; delete a throwaway account; then try to delete or demote the **only** admin | Each change applies + list refreshes; disabled account cannot log in; deleting/demoting the **last admin is refused**. |
| ☐ <a id="t-18-7"></a> **18.7** `[Both]` 🔐 Non-admin authz (UI + server) | Log in as the regular user; inspect Settings; from dev-tools issue an admin request: `fetch('/api/users',{method:'POST',…})` | Admin Settings sections **hidden** in the UI **and** the direct admin request **rejected by the server (401/403)**, not merely hidden; user can still connect/scan/label. |
| ☐ <a id="t-18-8"></a> **18.8** `[Both]` 🔐 Change own password | Settings → change password → current + new → Save; log out; log back in with the **new** password | "password changed"; new password works; old one refused. |
| ☐ <a id="t-18-9"></a> **18.9** `[Both]` 🔐 Logout | Click log out in Settings | Returns to the login page; app gated until sign-in. |
| ☐ <a id="t-18-10"></a> **18.10** `[Both]` 🔐📱 WebSocket streams gated | While **logged out** (no valid session cookie), try to open a device stream / file-browser / shell or load the app un-authenticated | Device/video/audio/file **WebSocket** connections refused (closed unauthorized) — auth gates the live streams, not just the HTML page. |
| ☐ <a id="t-18-11"></a> **18.11** `[Both]` 🔐 Return to open mode | As admin: Settings → disable login (return to open mode) | Page reloads; login no longer required; app open again. (Re-enabling later still needs at least one admin with a password.) |
| ☐ <a id="t-18-12"></a> **18.12** `[Both]` 🔐 Sessions survive restart | Auth enabled + session active → restart the server (don't clear cookies) | Existing `HttpOnly` session cookie still valid after restart (sessions DB-backed in `wsscrcpy.db`) — no surprise logout. |

### #19 — Per-user device labels 📱 *(new in beta.67)*

> Open mode unchanged (19.1 is the no-regression check). Rows 19.2–19.3 need auth enabled (Module 18) with two accounts and at least one discoverable device.

| Test | How to perform | Expected + verify |
|---|---|---|
| ☐ <a id="t-19-1"></a> **19.1** `[Both]` 📱 Open-mode labels unchanged | Auth off: scan/connect a device, set a label, reload | Label persists and shows as before — per-user storage transparent in open mode (single implicit user); no regression vs prior betas. |
| ☐ <a id="t-19-2"></a> **19.2** `[Both]` 🔐📱 Per-user label isolation | Auth enabled (Module 18), accounts A and B. As **A**: scan a device, label **"A-name"**. Log out. As **B**: scan the **same** device | **B sees no label (or B's own)** — **not** "A-name". Set **"B-name"** as B. Log back in as A → still **"A-name"**. Labels isolated per account. |
| ☐ <a id="t-19-3"></a> **19.3** `[Both]` 🔐📱 Labels in live scan hits | With A and B each holding a distinct label (from 19.2): as **each** user run a network **scan** | Each user's scan hits show **that user's own label** (A sees "A-name", B sees "B-name") — resolved per logged-in user as the scan streams, not globally. |

## Global pass criteria

| Criterion | Holds when |
|---|---|
| **SELinux clean** `[Fedora]` | Zero AVC all session; `sudo semanage fcontext -l \| grep ws-scrcpy-web` empty after every uninstall. |
| **AppArmor / userns clean** `[Ubuntu]` | The AppImage **launches** on stock Ubuntu 26.04 (2b.1); zero `apparmor="DENIED"` for the app all session; install + uninstall reach a CLEAN SLATE despite no SELinux tooling. |
| **Single instance** | Never two trays (Win) / two servers (Linux) per user/session. |
| **Relaunch fidelity** | Every uninstall→relaunch lands on the **same port**; no orphaned processes. |
| **Updates apply everywhere** | local, machine-wide `/opt` (no-service), user-service, and system-service (headless) all swap + relaunch on the same port; **zero AVC** on the system-service path. |
| **Clean shutdown** | "stop server & exit" tears down adb (+ Win tray) with no orphans; gated off in service mode. |
| **Data preserved** | User config/deps/logs survive uninstall + reinstall. |
| **Core flow** | Scan → connect → stream (video + control) → shell works on both platforms. |
| **Accessible UI** | Keyboard focus is always visible (`:focus-visible`); reduce-motion is honoured; both light + dark themes render fully with no hardcoded off-theme tints. |
| **Auth opt-in** | Off by default; enabling via the first-user lockdown gates **both** HTTP and the device/stream WebSockets; brute-force lockout + admin-unlock work; change-password / logout / disable-to-open-mode all work; the last admin can never be locked out. Open mode is unchanged. |
| **Per-user labels** | Each logged-in account sees only its own device labels in scan hits + the connected list; open mode (single implicit admin) is unchanged from prior betas. |

**Stop-and-report.** A `[Fedora]` SELinux/lifecycle failure in Modules 2/4/5, the service-update rows 6.5/6.6, or the Module 14 uninstall-cascade rows (14.4–14.7) — or the core-flow criterion — means: stop, run `capture-logs.sh <id>` (`.ps1` on Windows), report, and fix before promoting 0.1.30 stable. Cosmetic/polish → triage as beta-territory vs stable-blocker. **Module 11 (no-libfuse2)** is the regression check on the already-removed libfuse2 gate (PR #422) — an 11.2 failure means **revert #422** (restore the gate); it doesn't gate 0.1.30-stable on its own. **2b.1 (userns launch) is a potential 0.1.30 "Canonical" blocker** — if the AppImage won't launch on stock Ubuntu 26.04 that gates the Canonical side until the in-app extract-and-run / userns fallback lands. **Do not silently disable the VM's userns restriction to make it pass** — record the stock-VM result first; the `sysctl` / `APPIMAGE_EXTRACT_AND_RUN` workarounds are for *continuing* the rest of the pass, not for declaring 2b.1 green.
