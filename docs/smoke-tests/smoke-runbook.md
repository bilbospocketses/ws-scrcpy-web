# ws-scrcpy-web — Smoke Test Runbook (plain-English)

> **Smoke target: `v0.1.30-beta.69`** — bump this one line each release; everything below is version-agnostic.

**What this is.** A step-by-step manual test pass for the **ws-scrcpy-web** app. Completing it is the agreed gate before cutting the **0.1.30 final** release — the "prove it really installs, updates, and streams on Windows + Linux" check. You run it by hand on your test VMs plus a real Android device; it can't be automated from a chat.

**Source of truth.** This is the plain-English twin of `docs/smoke-tests/smoke-full.md` in the repo. The same tests as the repo doc, jargon spelled out, laid out as fixed-width tables you can keep open and tick through. If the two ever disagree, **the repo doc wins** — tell me and I'll re-sync this one.

## How to use this runbook

1. Do the **Pre-flight setup** once (next section) to prepare each machine.
2. Work through the modules **in order**, top to bottom — some rows rely on the state left by earlier rows in the same module.
3. In the **Done** column mark each test: `x` = pass · `F` = fail · `-` = skipped / not applicable.
4. The **OS** column says where to run it: `Lin` = the Fedora VM · `Win` = the Windows VM · `Both` = run it on each.
5. **Stop rule:** if a Linux SELinux/lifecycle test — or the core flow (scan → connect → stream → shell) — **fails**, stop, **run `capture-logs.sh` / `capture-logs.ps1` (Pre-flight F)** to grab the evidence bundle, and report it before shipping. Cosmetic glitches: jot them down and keep going.

## Jargon key (read once, refer back as needed)

**Linux / Fedora / SELinux**
- **SELinux** — Fedora's mandatory security system. It tags every file with a "label" and limits what each program may touch, on top of normal file permissions.
- **Enforcing** — the SELinux mode where violations are actually **blocked** (the other mode, *Permissive*, only logs them). Check with `getenforce`; set with `sudo setenforce 1`.
- **AVC denial** — one "SELinux blocked something" event in the system log. **Zero AVC** = nothing got blocked.
- **file context (fcontext)** — an SELinux rule: "files under this path get this label." `semanage fcontext -l` lists them.
- **bin_t** — the label for "a system program" (runnable; services can't write it).
- **var_lib_t** — the label for "writable app data" (config, logs, data a service may change).
- **restorecon** — re-applies the correct SELinux labels to files (used after an update swaps the binary).
- **pkexec / polkit** — Linux's "type your password to allow this one action" — roughly Linux's version of Windows UAC.
- **AppImage** — an entire Linux app in one file. Mark it executable (`chmod +x`) and run it; nothing to install.
- **FUSE / libfuse2** — the tech an AppImage uses to mount and run itself. Newer ("type-2") AppImages bundle FUSE inside, so the host no longer needs the `libfuse2` package.
- **systemd / unit / service** — Linux's background-service manager; a "unit" file defines a service.
- **user-scope vs system-scope service** — runs as *your* login (no admin, just you) **vs** runs as root for the *whole machine* (needs admin).
- **ExecStart** — the line in a unit file naming which program the service runs.
- **systemd-run --collect** — runs a one-off command as a temporary service and cleans it up after; used to relaunch the app inside a user's session.
- **loginctl** — lists logged-in sessions; used to find the active desktop user to relaunch into.
- **journalctl** — views the systemd log (where AVC denials and service messages show up).
- **/opt · /var/lib · ~/.local** — standard spots: `/opt` = system-wide optional software · `/var/lib` = that software's writable data · `~/.local` = your personal per-user data.
- **flock** — a file lock the app uses so only one copy runs per user.
- **$XDG_RUNTIME_DIR** — a private per-login temp folder Linux gives each session; where the single-copy lock lives.
- **ETXTBSY ("text file busy")** — the error from trying to overwrite a program that's running. The updater dodges it by *renaming* the new file into place instead of copying over the old one.

**Android / adb**
- **adb** — Android Debug Bridge, the tool that talks to Android devices.
- **Wireless debugging** — an Android 11+ developer option letting adb connect over Wi-Fi.
- **scrcpy** — the screen-mirroring engine; a small `scrcpy-server` runs on the phone.
- **kill-server** — the adb command that shuts its background daemon down cleanly.
- **"allow debugging" prompt** — the trust dialog the phone shows the first time a computer connects.
- **udid** — a device's unique id; here, the key used to remember per-device settings.

**Windows**
- **MSI** — a standard Windows installer file.
- **PerMachine** — installed once for **all** users under Program Files (vs per-user).
- **UAC** — Windows' "allow this app to make changes?" admin prompt.
- **HKLM …\Run** — the registry spot listing programs to start at login.
- **Fast User Switching** — switching Windows users without logging out.
- **tray** — the app's system-tray icon (and its background process).
- **snapshot** — a saved VM state you can instantly roll back to; start from a clean one so old installs don't skew results.

**App / packaging**
- **Velopack** — the cross-platform installer + auto-updater the app is built with.
- **dataRoot** — the folder holding the app's `config.json`, dependencies, and logs.
- **config.json / VERSION** — the settings file / a tiny file recording the installed version.
- **node-pty** — powers the in-app terminal (the adb shell dialog); its "AttachConsole" log noise is harmless.
- **the restart code (exit 75)** — the exit code the launcher reads as "start me again"; a normal quit uses `exit 0` = "stay closed."
- **audit2allow** — a tool that auto-writes SELinux rules. We avoid its broad suggestions; if SELinux blocks something, we add a *narrow, targeted* rule instead.

## Pre-flight setup (do this once, before any tests)

This is **setup, not tests** — nothing here passes or fails the app; it just gets each machine ready.

### A. Linux — your Hyper-V Fedora VM (the main event)
1. Boot the VM. Confirm strict security mode — run `getenforce`; it must say **Enforcing**. (If not: `sudo setenforce 1`.)
2. Create two extra accounts: a **2nd normal user** and a **2nd admin (sudo) user**. (For the multi-user tests and the "different admin uninstalls" test.)
3. Confirm a clean slate — this must print **nothing**:
   ```bash
   sudo semanage fcontext -l | grep ws-scrcpy-web
   ```
   (If it prints rules, an old test left residue — clean it with the recovery block at the bottom before starting.)
4. In a spare terminal, start the live denial monitor and leave it running all session:
   ```bash
   sudo journalctl -f | grep -i avc
   ```
   (Ideally nothing ever scrolls by.)
5. Download `WsScrcpyWeb-linux-beta.AppImage` from the latest GitHub release. **Leave it non-executable** — double-clicking a NON-`chmod +x` AppImage straight from the file manager is the realistic path most users take, and it's exactly what surfaced the Linux service-mode bug. (Marking it runnable with `chmod +x WsScrcpyWeb-linux-beta.AppImage` is optional — only needed if you'd rather launch it from a terminal.)

### B. The older "update-from" build (only for the Module 6 update tests)
The update tests need an **older** version installed first, then updated *to* the latest. The most recent **kept prior release** is **`v0.1.30-beta.68`** — download it into a separate dir (the AppImage filename is identical across versions, so it'd collide with the latest):
```bash
gh release download v0.1.30-beta.68 --repo bilbospocketses/ws-scrcpy-web --pattern 'WsScrcpyWeb-linux-beta.AppImage' --dir ./beta68
chmod +x ./beta68/WsScrcpyWeb-linux-beta.AppImage
```
(beta.68 = your "before", the smoke-target = your "after". The Windows MSI is on the same release: add `--pattern 'WsScrcpyWeb-beta.msi'`. It's a kept release, so no artifact-expiry to track.)

### C. Android device
An Android phone/tablet with **Wireless debugging** on (Settings → Developer options, Android 11+), reachable from the VM. Optionally one **USB**-connected device on Windows (for the single USB test, 7.3).

### D. Windows — Win11 VM (only if you're also running the 14 Windows tests)
1. Start from a **clean VM snapshot**.
2. Have three accounts ready: `Admin`, `User1`, `User2`.
3. Keep **Registry Editor** and **Task Manager → Startup** open (a few tests check those).
4. Download `WsScrcpyWeb-beta.msi` from the same release.

### E. No-libfuse2 host (recommended — folds Module 11 into the run)
A minimal Fedora VM/container with **no** `libfuse2`. Confirm it's really absent: `ldconfig -p | grep -i libfuse.so.2` prints nothing and `rpm -q fuse-libs` says "not installed" (a base Fedora cloud/container image ships without it; otherwise `sudo dnf remove fuse-libs` on a throwaway VM). Run the **whole** Linux smoke on this host and Module 11 needs no extra steps — 11.1 is "the app launched here at all", 11.2 is the Module 6 update done here. It's the regression check on the already-removed libfuse2 gate — **revert PR #422 if 11.2 fails**. Not a 0.1.30 blocker on its own, so skip to a normal VM if this host is friction — but don't ship to a wide audience without it.

### F. Capture scripts — pull the logs at any checkpoint
Beside this doc are two snapshot scripts. Run one **at every capture point, and the instant any test fails**, to collect a complete evidence bundle (a timestamped, labeled folder + an archive to attach):
- **Linux:** `bash capture-logs.sh <test-id>` — e.g. `bash capture-logs.sh 5.8-after-uninstall`
- **Windows:** `powershell -ExecutionPolicy Bypass -File capture-logs.ps1 <test-id>` — e.g. `... 15.2-wipe`

Each grabs the AVC denials, the service journal + status, the SELinux rules + file labels, the running processes, the dataRoot / Program Files / temp listings, `config.json`, and the app logs. The numbered files map to the "Pass — what you should see" column, so a failure can be read (by you or me) without re-running it.

### If a stuck Linux system service ever needs a manual reset
```bash
sudo systemctl stop WsScrcpyWeb.service; sudo systemctl disable WsScrcpyWeb.service; sudo systemctl reset-failed WsScrcpyWeb.service
sudo rm -f /etc/systemd/system/WsScrcpyWeb.service
sudo rm -rf /opt/ws-scrcpy-web /var/lib/ws-scrcpy-web
sudo semanage fcontext -d '/opt/ws-scrcpy-web(/.*)?'; sudo semanage fcontext -d '/var/lib/ws-scrcpy-web(/.*)?'
sudo systemctl daemon-reload
```

---

## The tests

Mark the **Done** column as you go: `x` pass · `F` fail · `-` skip.

### Module 1 — Install & first-run
*The first time you run the app on each OS.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 1.1 First-run modal  │ Lin  │ Run the downloaded AppImage  │ A modal "install for all users?" appears: 3      │ [ ]  │
│                      │      │ on a machine with NO prior   │ lines + buttons "yes, all users" and "no, me     │      │
│                      │      │ install or 'declined'        │ only". No close (x); Esc and clicking outside do │      │
│                      │      │ marker.                      │ nothing (you must pick one).                     │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 1.2 Accept ->        │ Lin  │ Click "yes, all users";      │ Exactly one password prompt. App lands in        │ [ ]  │
│ install + delete     │      │ enter your password at the   │ /opt/ws-scrcpy-web/; the file                    │      │
│ original             │      │ single prompt.               │ /opt/ws-scrcpy-web/VERSION matches the           │      │
│                      │      │                              │ smoke-target version; a system menu entry        │      │
│                      │      │                              │ exists; the app runs. NEW: the AppImage you      │      │
│                      │      │                              │ launched (in Downloads) is deleted afterward.    │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 1.3 Decline +        │ Lin  │ On a fresh machine, or as a  │ Runs from your home folder (~/.local). The NEXT  │ [ ]  │
│ remember             │      │ 2nd user, choose "no, me     │ launch does NOT ask again. The downloaded        │      │
│                      │      │ only".                       │ AppImage is kept.                                │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 1.4 Headless         │ Lin  │ Launch over SSH or with no   │ No hang and no crash; it falls back gracefully.  │ [ ]  │
│ first-run            │      │ screen attached.             │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 1.5 Fresh MSI        │ Win  │ On a clean snapshot as       │ Installs cleanly; a browser opens                │ [ ]  │
│ install              │      │ Admin, run                   │ http://localhost:<port>; the welcome dialog      │      │
│                      │      │ WsScrcpyWeb-beta.msi.        │ shows; Settings > About = the smoke-target       │      │
│                      │      │                              │ version; files in C:\Program Files\WsScrcpyWeb\. │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 1.6 Reinstall reuses │ Win  │ After the full uninstall in  │ Installs cleanly and REUSES your old settings    │ [ ]  │
│ config               │      │ test 5.7, install the MSI    │ file (config.json) instead of overwriting it;    │      │
│                      │      │ again.                       │ the app returns on the port you had before.      │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 1.7 Cold-start tab   │ Lin  │ Fully quit (past first-run); │ The server boots AND exactly one browser tab     │ [ ]  │
│ (D1)                 │      │ relaunch the menu entry /    │ opens (the beta.62 D1 fix - it took a 2nd click  │      │
│                      │      │ AppImage, no service yet.    │ before); a later web-port-change restart adds no │      │
│                      │      │                              │ second tab.                                      │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 1.8 Cold-start tab   │ Win  │ Fully quit, then relaunch    │ Exactly one browser tab opens (the beta.63 D4    │ [ ]  │
│ (D4)                 │      │ (Start-menu / exe), no       │ fix); a web-port-change restart AND an in-app    │      │
│                      │      │ service.                     │ update relaunch do NOT double-tab.               │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 2 — Linux layout & SELinux
*Checks the app's files get the right Fedora security labels.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 2.1 Binary/deps      │ Lin  │ After a machine-wide (or     │ The security label is bin_t (the "system         │ [ ]  │
│ labels               │      │ system-service) install: ls  │ program" label).                                 │      │
│                      │      │ -Z /opt/ws-scrcpy-web        │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 2.2 State labels     │ Lin  │ Run: ls -Z                   │ The label is var_lib_t (the "writable app data"  │ [ ]  │
│                      │      │ /var/lib/ws-scrcpy-web       │ label - config, logs, deps the service writes).  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 2.3 Security rules   │ Lin  │ After a system-service       │ Only the /opt rule (bin_t) shows; /var/lib is    │ [ ]  │
│ registered           │      │ install: semanage fcontext   │ var_lib_t by the policy default - no custom rule.│      │
│                      │      │ -l | grep ws-scrcpy-web      │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 2.4 No blocked       │ Lin  │ Watch your "journalctl ...   │ Nothing scrolls by - zero SELinux denials.       │ [ ]  │
│ actions on install   │      │ avc" monitor through test    │                                                  │      │
│                      │      │ 1.2 and a service install.   │                                                  │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 3 — Multi-user & single-instance
*Each user gets their own copy; you can't accidentally run two.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 3.1 Per-user launch  │ Lin  │ Sign in as a 2nd user;       │ Runs under THAT user's login with its own        │ [ ]  │
│                      │      │ launch from the apps menu.   │ private data (~/.local); "Open" reaches the same │      │
│                      │      │                              │ backend port.                                    │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 3.2 Only one copy    │ Lin  │ Same user, app already       │ The 2nd launch is blocked (per-user lock); no    │ [ ]  │
│ per user             │      │ running - try a 2nd copy     │ 2nd server starts; the existing window/URL just  │      │
│                      │      │ (from /opt and from home).   │ opens.                                           │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 3.3 Defer to the     │ Lin  │ With the system service      │ It defers to the service (opens the service's    │ [ ]  │
│ service              │      │ running, launch the app      │ URL) instead of starting a 2nd server.           │      │
│                      │      │ locally.                     │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 3.4 One tray per     │ Win  │ Service installed; switch    │ Each session gets EXACTLY ONE tray within ~2s;   │ [ ]  │
│ Windows session      │      │ Admin > User1 > User2 (Fast  │ right-click > "Open" loads the app (same backend │      │
│                      │      │ User Switching).             │ port for all).                                   │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 3.5 Second tray      │ Win  │ With the tray running,       │ No 2nd tray; the one you started exits in        │ [ ]  │
│ rejected             │      │ manually start a 2nd         │ ~100ms; the original tray is fine.               │      │
│                      │      │ ws-scrcpy-web-tray.exe from  │                                                  │      │
│                      │      │ the install folder.          │                                                  │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 4 — Service mode
*Installing the app as a background service.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 4.1 System scope     │ Lin  │ Before installing            │ The install button is greyed with a note         │ [ ]  │
│ needs machine-wide   │      │ machine-wide: Settings >     │ "requires installing system-wide first". The     │      │
│ first                │      │ service > pick "system"      │ "user" scope still works. After a machine-wide   │      │
│                      │      │ scope.                       │ install, "system" becomes selectable.            │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 4.2 Install both     │ Lin  │ Install the service in each  │ user scope runs from your home folder; system    │ [ ]  │
│ scopes               │      │ scope: user (no password)    │ scope runs as root from /opt with data in        │      │
│                      │      │ and system (one password).   │ /var/lib. No SELinux denials either way.         │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 4.3 Install confirm  │ Win  │ Settings > "install          │ A confirm dialog ("Administrative Privileges     │ [ ]  │
│ dialog (Win)         │      │ service". Try Cancel, Esc,   │ Required") appears. Cancel/Esc/backdrop close it │      │
│                      │      │ backdrop; then Continue.     │ with NO admin prompt and NO action. Continue >   │      │
│                      │      │                              │ UAC > service installs, page redirects, no       │      │
│                      │      │                              │ welcome dialog.                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 4.4 Scope radio      │ Lin  │ After a user-scope and a     │ The selected scope's radio dot is a clearly      │ [ ]  │
│ readable + correct   │      │ system-scope install, reopen │ visible blue (not washed-out grey); radios       │      │
│                      │      │ Settings each time.          │ aren't clickable but are readable; the CORRECT   │      │
│                      │      │                              │ scope shows selected.                            │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 4.5 Confirm buttons  │ Both │ Open the service             │ Cancel/confirm buttons use the app's shared      │ [ ]  │
│ match app style      │      │ install/uninstall confirm    │ white-outline + white-text style, matching the   │      │
│                      │      │ dialogs (and "end shell      │ other dialogs.                                   │      │
│                      │      │ session").                   │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 4.6 Clean service    │ Lin  │ After a user-scope install:  │ No "Unknown key StartLimitIntervalSec" warning;  │ [ ]  │
│ unit                 │      │ journalctl --user -u         │ the temporary local copy that installed has      │      │
│                      │      │ WsScrcpyWeb -b and pgrep.    │ exited (only the service runs); no false "port   │      │
│                      │      │                              │ discovery timed out" message on a same-port      │      │
│                      │      │                              │ reinstall.                                       │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 5 — Lifecycle: uninstall → relaunch / handoff
*What happens when the service is removed while you're using the app.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 5.1 Same-user        │ Lin  │ System service installed and │ The app reappears in your session on the SAME    │ [ ]  │
│ uninstall, app       │      │ in use - uninstall it AS     │ port, with a visible "relaunching..." pause.     │      │
│ returns              │      │ that same user.              │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 5.2 Different-admin  │ Lin  │ Uninstall, giving the        │ The app reappears in the ACTIVE desktop user's   │ [ ]  │
│ uninstall            │      │ password as a DIFFERENT      │ session (not the admin's), same port.            │      │
│                      │      │ admin user.                  │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 5.3 Headless         │ Lin  │ Uninstall when nobody is     │ No relaunch attempt; you get a manual-restart    │ [ ]  │
│ uninstall            │      │ logged into the desktop.     │ message; nothing left running; no crash.         │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 5.4 Security rules   │ Lin  │ After any uninstall:         │ Returns NOTHING - both SELinux rules were        │ [ ]  │
│ cleaned up           │      │ sudo semanage fcontext -l    │ removed.                                         │      │
│                      │      │ | grep ws-scrcpy-web         │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 5.5 Win uninstall +  │ Win  │ Service mode, Settings as    │ Button shows "uninstalling..."; if handoff takes │ [ ]  │
│ handoff message      │      │ Admin > "uninstall service"  │ >5s you see "still waiting for user session..."; │      │
│                      │      │ > Continue > Yes on UAC.     │ it ends at the local-mode URL.                   │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 5.6 Win              │ Win  │ Service mode; kill every     │ ~5s > "still waiting..."; ~30s > "couldn't reach │ [ ]  │
│ handoff-failure is   │      │ ws-scrcpy-web-tray.exe, THEN │ the user session..."; the button frees up; the   │      │
│ safe                 │      │ uninstall.                   │ service is STILL installed (it did NOT silently  │      │
│                      │      │                              │ remove itself).                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 5.7 Full Windows     │ Win  │ Add/Remove Programs >        │ Service stops + unregisters; the startup         │ [ ]  │
│ uninstall            │      │ ws-scrcpy-web > Uninstall as │ registry entry (HKLM ...\Run\WsScrcpyWebTray) is │      │
│                      │      │ Admin.                       │ gone; Program Files\WsScrcpyWeb is cleared; YOUR │      │
│                      │      │                              │ data (config/deps/logs) is kept; the admin's     │      │
│                      │      │                              │ tray disappears.                                 │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 5.8 User-scope       │ Lin  │ User-scope service installed │ The user service is stopped/disabled/removed     │ [ ]  │
│ uninstall -> back to │      │ and in use - uninstall AS    │ (unit file gone); after relaunch only the local  │      │
│ local                │      │ that user.                   │ instance runs (launcher+node+pre-warmed adb)     │      │
│                      │      │                              │ - no service procs, no 2nd instance, no scrcpy;  │      │
│                      │      │                              │ reconnects; Settings shows "not installed".      │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 5.9 System uninstall │ Lin  │ After a system-scope         │ The "service removed - relaunch manually"        │ [ ]  │
│ message is neutral   │      │ uninstall with nobody at the │ message is a plain neutral line - not red, no    │      │
│                      │      │ desktop.                     │ "retry" button.                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 5.10 Non-admin       │ Win  │ As a standard (non-admin)    │ It reports politely ("administrative privileges  │ [ ]  │
│ uninstall, password  │      │ user, uninstall > Continue > │ were declined. try again and approve the         │      │
│ declined             │      │ then CANCEL the password     │ prompt."); the button frees up; the service      │      │
│                      │      │ prompt.                      │ stays installed. (Approve instead > it           │      │
│                      │      │                              │ uninstalls cleanly, back to local mode.)         │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 6 — Updates
*The smoke-target build is the newest, so every row updates **to** it. Get the beta.68 "from" build first (Pre-flight B).*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 6.1 Update check     │ Both │ Settings > Updates > "Check  │ A beta.68 install offers the latest; the latest  │ [ ]  │
│                      │      │ for updates".                │ install says "up to date". No error spam in the  │      │
│                      │      │                              │ server/launcher logs.                            │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 6.2 Local (home)     │ Lin  │ Start from the beta.68       │ It downloads, verifies the checksum, shows an    │ [ ]  │
│ update +             │      │ AppImage in plain local mode │ "updating..." overlay, swaps to the latest and   │      │
│ auto-relaunch        │      │ (no service). Settings >     │ relaunches on its own; the browser reconnects;   │      │
│                      │      │ Updates > Apply.             │ About = the new version. Also confirm on a copy  │      │
│                      │      │                              │ just relaunched after a user-scope service       │      │
│                      │      │                              │ uninstall.                                       │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 6.3 Machine-wide     │ Lin  │ Machine-wide /opt install    │ One password prompt; the /opt binary is swapped  │ [ ]  │
│ /opt update (one     │      │ with NO service - trigger an │ by RENAME (not copy, to avoid "file busy");      │      │
│ password)            │      │ update.                      │ labels re-applied; the VERSION file bumps; it    │      │
│                      │      │                              │ relaunches as you and reconnects.                │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 6.4 Newer home copy  │ Lin  │ With /opt at beta.68, drop a │ It runs the home copy, then offers "update the   │ [ ]  │
│ over /opt            │      │ newer AppImage in            │ system-wide install to vX"; accept > it swaps    │      │
│                      │      │ your home folder and launch  │ /opt; the next launch runs the updated /opt.     │      │
│                      │      │ it.                          │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 6.5 User-service     │ Lin  │ User-scope service installed │ The user service stops, the home app file swaps, │ [ ]  │
│ update (no prompt)   │      │ > Settings > Updates >       │ the service restarts on the SAME port, the       │      │
│                      │      │ Apply.                       │ browser reconnects. No password prompt.          │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 6.6 System-service   │ Lin  │ System-scope service         │ NO password prompt (already root); the /opt      │ [ ]  │
│ update (no prompt,   │      │ installed > Apply.           │ binary swaps; labels re-applied (restorecon >    │      │
│ watch SELinux)       │      │                              │ bin_t); the service restarts; ZERO denials. If   │      │
│                      │      │                              │ SELinux blocks a step, add a NARROW targeted     │      │
│                      │      │                              │ rule only - never a blanket audit2allow.         │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 6.8 Windows update   │ Win  │ From a prior installed build │ Updates cleanly; app reachable afterward; the    │ [ ]  │
│ keeps the tray       │      │ (beta.68 MSI) > Settings >   │ tray icon SURVIVES the update - exactly one tray │      │
│                      │      │ Updates > Apply.             │ once it settles, no duplicate or orphan.         │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 7 — Devices: scan & connect
*Connecting to an Android device.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 7.1 Connect over     │ Both │ Home > "scan/connect" > type │ adb connects; the device card shows under        │ [ ]  │
│ Wi-Fi                │      │ the device ip:port (or scan a│ "connected devices" within ~5s.                  │      │
│                      │      │ subnet).                     │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 7.2 Scan a subnet    │ Both │ Open the scan-network dialog │ Reachable devices are listed; picking one        │ [ ]  │
│                      │      │ and scan a subnet.           │ connects; a bad/empty subnet is handled          │      │
│                      │      │                              │ gracefully (no hang).                            │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 7.3 USB device       │ Win  │ Plug in a USB Android device;│ It appears under connected devices and survives a│ [ ]  │
│ (Windows)            │      │ approve the "allow debugging"│ page reload.                                     │      │
│                      │      │ prompt on the phone.         │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 7.4 List updates in  │ Both │ Connect, rename, and         │ Rows update in place (diffed by device id) — no  │ [ ]  │
│ place                │      │ disconnect a few devices;    │ whole-list flicker; labels load once per refresh,│      │
│                      │      │ watch the connected-devices  │ not once per row; changes show within ~1s.       │      │
│                      │      │ list.                        │ (beta.66 perf)                                   │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 8 — scrcpy streaming
*Mirroring the device screen.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 8.1 Video            │ Both │ Click a device > open the    │ Live video plays smoothly; no decode errors in   │ [ ]  │
│                      │      │ stream dialog > connect; then│ the console. The video cell fills its area with  │      │
│                      │      │ resize the window.           │ the correct aspect ratio (no stretch/overflow)   │      │
│                      │      │                              │ and rescales on resize keeping aspect. (beta.66  │      │
│                      │      │                              │ #106)                                            │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 8.2 Control          │ Both │ In the stream,               │ Your touches and keystrokes reach the device;    │ [ ]  │
│                      │      │ click/scroll/type and use the│ navigation works.                                │      │
│                      │      │ on-screen buttons.           │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 8.3 Audio            │ Both │ Turn on audio in the stream  │ Audio plays; the codec/source toggles work.      │ [ ]  │
│                      │      │ settings (needs Android 11+).│                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 8.4 Quality settings │ Both │ Change                       │ Changes take effect; the stream restarts with    │ [ ]  │
│                      │      │ display/codec/encoder/fps/bit│ them; they're remembered per-device next time.   │      │
│                      │      │ rate, then reconnect.        │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 8.5 H.265 (HEVC)     │ Both │ Set the video codec to       │ Both codecs decode and render in-browser         │ [ ]  │
│ decode               │      │ H.265/HEVC, connect; then    │ (WebCodecs) — live frames, no decode errors.     │      │
│                      │      │ repeat with H.264.           │ Confirms the owed real-browser H.265 check. (#41)│      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 9 — adb in dialogs
*Shell, files, and device buttons.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 9.1 Shell            │ Both │ Device > "shell" > run       │ A working terminal; correct output; closing the  │ [ ]  │
│                      │      │ getprop ro.product.model and │ dialog ends the session cleanly (no leftover adb │      │
│                      │      │ a couple commands.           │ shell).                                          │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 9.2 Files            │ Both │ Device > file-list dialog >  │ The listing loads; the icon-size choice sticks;  │ [ ]  │
│                      │      │ browse, change the icon size,│ transfers work. The console stays quiet —        │      │
│                      │      │ push and pull a file — with  │ file-listing protocol traces are gated behind the│      │
│                      │      │ the browser console open.    │ 'ws-scrcpy-web-debug' localStorage flag (set it  │      │
│                      │      │                              │ to 'true' to see the [ListFiles] traces).        │      │
│                      │      │                              │ (beta.66)                                        │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 9.3 Device buttons   │ Both │ Use sleep/wake and any       │ Buttons show the right state (green/red); the    │ [ ]  │
│                      │      │ power/nav buttons on the     │ actions actually happen on the device.           │      │
│                      │      │ device card.                 │                                                  │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 10 — Logs & sanity

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 10.1 Status endpoint │ Both │ Open                         │ Returns JSON with the right platform, supported, │ [ ]  │
│                      │      │ http://localhost:<port>/api/s│ and status fields.                               │      │
│                      │      │ ervice/status in a browser.  │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 10.2 Windows logs    │ Win  │ Tail launcher.log +          │ No ERR / Error: lines, apart from the known      │ [ ]  │
│ clean                │      │ ws-scrcpy-web.log under      │ harmless node-pty "AttachConsole" noise.         │      │
│                      │      │ ProgramData\WsScrcpyWeb\logs │ server.log / service.log are thin crash-catchers;│      │
│                      │      │ during use (canonical logs). │ a .1 backup may appear; all files are tail-able. │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 10.3 Linux logs clean│ Lin  │ Tail launcher.log +          │ No error spam; shutdown messages appear when you │ [ ]  │
│                      │      │ ws-scrcpy-web.log under      │ stop the app. server.log / service.log are thin  │      │
│                      │      │ ~/.local/share/.../logs (or  │ crash-catchers; a .1 backup may appear; all files│      │
│                      │      │ /var/lib/.../logs for system │ are tail-able.                                   │      │
│                      │      │ installs).                   │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 10.4 Token /         │ Both │ With the app open, restart   │ After a restart the open tab must be reloaded to │ [ ]  │
│ reload-on-restart    │      │ the server (change web port >│ reconnect — a new per-instance token is minted   │      │
│                      │      │ save, or stop & relaunch).   │ each boot (SameSite=Strict, HttpOnly cookie). A  │      │
│                      │      │ Separately, curl             │ cookie-less curl is rejected on the sensitive    │      │
│                      │      │ /api/service/status with no  │ API. Normal browser use is unchanged. (beta.66   │      │
│                      │      │ cookie.                      │ security)                                        │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 10.5 404 + security  │ Both │ curl -I a missing asset path │ A missing asset / unknown API path returns 404   │ [ ]  │
│ headers              │      │ and /, then load a deep      │ (not the HTML shell); an in-app route still      │      │
│                      │      │ in-app route in the browser  │ serves the shell. Static responses carry         │      │
│                      │      │ and refresh.                 │ X-Content-Type-Options: nosniff and              │      │
│                      │      │                              │ X-Frame-Options: SAMEORIGIN. (beta.66 security)  │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 11 — Velopack 1.2.0 / no-libfuse2 (fold into the run)
*The libfuse2 special-case code is already gone (PR #422); this confirms the packaging still launches and self-updates without it. Run the smoke on a no-libfuse2 host (Pre-flight E) and 11.1/11.2 ride along free. **Revert PR #422 if 11.2 fails.** Doesn't block 0.1.30 on its own — but close it before any wide release.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 11.1 Runs without    │ Lin  │ On a minimal                 │ It launches (the newer AppImage bundles its own  │ [ ]  │
│ libfuse2             │      │ distro/container with NO     │ FUSE); no "libfuse.so.2"/dlopen error.           │      │
│                      │      │ libfuse2, run the            │                                                  │      │
│                      │      │ smoke-target AppImage.       │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 11.2 Updates without │ Lin  │ From that same no-libfuse2   │ Update succeeds; gate code already gone (#422).  │ [ ]  │
│ libfuse2             │      │ machine, run an in-app       │ Revert PR #422 if this row fails.                │      │
│                      │      │ update.                      │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 11.3 Update path     │ Lin  │ During the /opt update tests │ Apply and relaunch land correctly - no           │ [ ]  │
│ still solid          │      │ (6.3 / 6.4 / 6.6), watch the │ regression in how the updater finds its files.   │      │
│                      │      │ apply + relaunch.            │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 11.4 Windows still   │ Win  │ After the MSI install (1.5), │ Installed for ALL users under C:\Program         │ [ ]  │
│ installs for all     │      │ check where it installed.    │ Files\WsScrcpyWeb\ (PerMachine still holds).     │      │
│ users                │      │                              │                                                  │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 12 — Stop server & exit
*The "stop server & exit" button in Settings → Server.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 12.1 Clean exit +    │ Lin  │ Local mode, a device         │ The tab self-closes or shows "app stopped - you  │ [ ]  │
│ adb shutdown (Linux) │      │ connected + a stream running │ can close this tab"; everything shuts down (no   │      │
│                      │      │ > Settings > Server > "stop  │ leftover app or adb processes); the log shows    │      │
│                      │      │ server & exit" > confirm.    │ "Stopping adb daemon (kill-server)"; the         │      │
│                      │      │                              │ launcher does NOT restart (clean exit, not the   │      │
│                      │      │                              │ restart code).                                   │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 12.2 Disabled in     │ Both │ With a service installed     │ The button is greyed with a note ("managed by    │ [ ]  │
│ service mode         │      │ (Windows system; Linux user  │ the system service..."); clicking does nothing.  │      │
│                      │      │ or system) > Settings >      │ After you UNINSTALL the service it becomes       │      │
│                      │      │ Server.                      │ usable again (no page reload).                   │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 12.3 Windows reaps   │ Win  │ Local mode, device + stream  │ A confirm dialog; the server exits (tab closes / │ [ ]  │
│ everything           │      │ live, tray present >         │ "app stopped" page); the TRAY ICON disappears;   │      │
│                      │      │ Settings > Server > "stop    │ Task Manager shows no leftover                   │      │
│                      │      │ server & exit" > ok.         │ launcher/node/tray/adb; Cancel leaves everything │      │
│                      │      │                              │ running.                                         │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 12.4 Custom data     │ Lin  │ Launch with the environment  │ Config/deps/logs all land under that folder      │ [ ]  │
│ folder honored       │      │ variable                     │ (both halves of the app agree). Mostly covered   │      │
│                      │      │ DATA_ROOT=/tmp/wssw-dataroot │ by unit tests; this just confirms it end-to-end. │      │
│                      │      │ set.                         │                                                  │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 13 — Settings: bookmark & reset prompts

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 13.1 "Never remind   │ Both │ Reach the bookmark /         │ The confirm uses the white-outline buttons;      │ [ ]  │
│ me" bookmark         │      │ port-change reminder > tick  │ ticking it overrides + disables the per-port     │      │
│                      │      │ "don't show again - ever,    │ checkbox; the choice sticks (saved in            │      │
│                      │      │ even when the port changes"  │ config.json).                                    │      │
│                      │      │ > confirm.                   │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 13.2 Reset the       │ Both │ Settings > "reset welcome    │ The welcome dialog shows again AND the bookmark  │ [ ]  │
│ prompts              │      │ and bookmark prompts".       │ reminder is cleared (both per-port and "ever"),  │      │
│                      │      │                              │ so it can re-appear. Check it does NOT           │      │
│                      │      │                              │ immediately re-suppress the per-port reminder.   │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 13.3 Server-section  │ Both │ Open Settings; look at the   │ Top to bottom: reset prompts > web port > [Linux │ [ ]  │
│ layout               │      │ Server section (3rd, after   │ only] install for all users > stop server & exit │      │
│                      │      │ Updates + Service).          │ > uninstall. The web port row has an inline      │      │
│                      │      │                              │ 'save' button; the status line below it is empty │      │
│                      │      │                              │ at rest (only saving... / saved. / an error after│      │
│                      │      │                              │ you click save).                                 │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 14 — Linux Server section UX
*The Server section adds three Settings → Server affordances on Linux: a one-click "install for all users" button, a machine-wide start-menu icon, and an always-available in-app "complete uninstall". The uninstall cascades through any installed service in one pass — it runs root-direct under a system service, otherwise self-elevates via ONE pkexec — and offers a "keep my settings & logs" option.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 14.1 Install for     │ Lin  │ From a local (me-only)       │ Exactly one pkexec prompt. The binary            │ [ ]  │
│ all users            │      │ install: Settings > Server > │ relocates to /opt/ws-scrcpy-web/; the            │      │
│                      │      │ click 'install for all       │ button then greys/disables, reading              │      │
│                      │      │ users'; authenticate the     │ 'already installed for all users                 │      │
│                      │      │ single prompt.               │ (/opt)'; the app keeps serving on the            │      │
│                      │      │                              │ same port.                                       │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 14.2 Start-menu      │ Lin  │ After a machine-wide         │ The ws-scrcpy-web icon shows in the menu         │ [ ]  │
│ icon                 │      │ install, open the desktop    │ (not a generic placeholder). On disk,            │      │
│                      │      │ apps menu.                   │ /usr/share/icons/hicolor/256x256/apps            │      │
│                      │      │                              │ /ws-scrcpy-web.png exists.                       │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 14.3 Uninstall -     │ Lin  │ Settings > Server >          │ App removed; the browser tab shows               │ [ ]  │
│ local mode           │      │ 'uninstall...' > confirm     │ 'uninstalled - close this tab'. Running          │      │
│                      │      │ with 'keep my settings &     │ clear-install.sh verifies a CLEAN SLATE:         │      │
│                      │      │ logs' UNCHECKED.             │ no leftover binary, dependencies,                │      │
│                      │      │                              │ config, or decline marker.                       │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 14.4 Uninstall -     │ Lin  │ With a user-scope service    │ Exactly ONE pkexec (for the /opt removal);       │ [ ]  │
│ user-service         │      │ installed on a machine-wide  │ the per-user systemd unit is gone AND            │      │
│ cascade              │      │ /opt binary, click           │ the app is removed in one pass; no               │      │
│                      │      │ uninstall.                   │ relaunch.                                        │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 14.5 Uninstall -     │ Lin  │ With a system-scope          │ Runs as root with NO pkexec;                     │ [ ]  │
│ system-service       │      │ service installed, run       │ /opt/ws-scrcpy-web,                              │      │
│ cascade              │      │ uninstall from the root      │ /var/lib/ws-scrcpy-web, and the                  │      │
│                      │      │ service context.             │ systemd unit are all gone; zero                  │      │
│                      │      │                              │ SELinux AVC denials.                             │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 14.6 Uninstall -     │ Lin  │ Run uninstall with 'keep     │ config.json and logs/ survive at the data        │ [ ]  │
│ keep settings        │      │ my settings & logs'          │ root: ~/.local/share/WsScrcpyWeb for a           │      │
│ & logs               │      │ CHECKED.                     │ local install, or /var/lib/ws-scrcpy-web         │      │
│                      │      │                              │ for a system service); dependencies/ is          │      │
│                      │      │                              │ removed either way; a later reinstall            │      │
│                      │      │                              │ reuses the saved port.                           │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 14.7 Uninstall -     │ Lin  │ After any uninstall, run     │ The output is empty - the fcontext list          │ [ ]  │
│ SELinux clean        │      │ sudo semanage fcontext -l    │ has no ws-scrcpy-web rules - and there           │      │
│                      │      │ | grep ws-scrcpy-web.        │ are zero AVC denials.                            │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 15 — Windows Server section: uninstall + stop-exit
*New on Windows in beta.51 (in-app uninstall), with the **wipe** fully fixed in beta.52. The uninstall cleaner runs with logging OFF by design, so the evidence is filesystem / registry / temp state — capture it with `capture-logs.ps1 <label>` (see Pre-flight) at each row, especially 15.2.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 15.1 Uninstall -     │ Win  │ MSI install > Settings >     │ One UAC prompt (Update.exe self-elevates).       │ [ ]  │
│ keep                 │      │ Server > "uninstall" > leave │ Program Files\WsScrcpyWeb gone; service gone (sc │      │
│                      │      │ "keep my settings & logs"    │ query = not found); tray gone; the Add/Remove    │      │
│                      │      │ CHECKED (default) >          │ Programs entry is gone. config.json + logs       │      │
│                      │      │ uninstall.                   │ survive under ProgramData\WsScrcpyWeb;           │      │
│                      │      │                              │ dependencies gone. A later reinstall reuses the  │      │
│                      │      │                              │ saved port.                                      │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 15.2 Uninstall -     │ Win  │ Same, but UNCHECK "keep my   │ As 15.1, AND the WHOLE ProgramData\WsScrcpyWeb   │ [ ]  │
│ wipe                 │      │ settings & logs".            │ is gone - nothing left behind, including         │      │
│                      │      │                              │ control\operation-server\. (The beta.52 fix: a   │      │
│                      │      │                              │ temp copy of the launcher does the delete after  │      │
│                      │      │                              │ the original exits.) Run capture-logs.ps1        │      │
│                      │      │                              │ 15.2-wipe and confirm 31-dataroot shows it       │      │
│                      │      │                              │ absent.                                          │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 15.3 Uninstall       │ Win  │ Open the uninstall dialog.   │ A top-layer dialog over Settings; Cancel is      │ [ ]  │
│ dialog               │      │                              │ white-outline, Uninstall is red; the "keep my    │      │
│                      │      │                              │ settings & logs" box is checked by default;      │      │
│                      │      │                              │ Cancel / Esc / clicking outside all do nothing.  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 15.4 Stop-exit reaps │ Win  │ Local mode, a device + stream│ The tab closes / shows "app stopped"; Task       │ [ ]  │
│ all                  │      │ live > Settings > Server >   │ Manager shows NO leftover launcher, node, tray,  │      │
│                      │      │ "stop server & exit".        │ or adb processes.                                │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 15.5 Server section  │ Win  │ Open Settings > Server.      │ Top to bottom: reset prompts > web port > stop   │ [ ]  │
│ order                │      │                              │ server & exit > uninstall ws-scrcpy-web. (No     │      │
│                      │      │                              │ "install for all users" on Windows.)             │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

---

### Module 16 — Accessibility & theming
*Keyboard focus, reduced motion, and theming — all in the browser. No device or install state needed; run with the app open and repeat the visual rows in both themes.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 16.1 Theme switch    │ Both │ Toggle the home-page theme   │ The whole UI recolors live (backgrounds, text,   │ [ ]  │
│                      │      │ control light <-> dark; open │ borders, buttons); nothing stuck at the other    │      │
│                      │      │ modals + the stream view in  │ theme; the choice persists across a reload.      │      │
│                      │      │ each.                        │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 16.2 Keyboard focus  │ Both │ Tab through the home page and│ A clear 2px accent focus outline shows on the    │ [ ]  │
│ ring                 │      │ a dialog's controls with the │ keyboard-focused control (:focus-visible), but   │      │
│                      │      │ keyboard; then click controls│ NOT on a plain mouse click. (WCAG 2.4.7)         │      │
│                      │      │ with the mouse.              │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 16.3 Reduced motion  │ Both │ Turn on the OS "reduce       │ Animations and transitions collapse to           │ [ ]  │
│                      │      │ motion" setting, reload the  │ near-instant; turn the setting off and normal    │      │
│                      │      │ app, then trigger animated UI│ animation returns. (WCAG 2.3.3)                  │      │
│                      │      │ (modals, spinners,           │                                                  │      │
│                      │      │ transitions).                │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 16.4 Light-mode tints│ Both │ In light theme: select a file│ The selection / delete-hover / apply-update tints│ [ ]  │
│                      │      │ row, hover the delete        │ are proper light-theme shades (via the           │      │
│                      │      │ control, and (on an update   │ danger/success tokens), not slightly-off dark    │      │
│                      │      │ run) hover apply-update.     │ values.                                          │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 16.5 Embed page      │ Both │ Open embed.html (the         │ <html> has a lang attribute set (assistive-tech  │ [ ]  │
│ language             │      │ embeddable stream page);     │ hint), matching the main app shell.              │      │
│                      │      │ view-source / inspect the    │                                                  │      │
│                      │      │ <html> element.              │                                                  │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

### Module 18 — Auth subsystem (opt-in login)
*New in beta.67. The optional login system is off by default and inert until the first user is added. Run these rows top-to-bottom — rows after 18.2 assume auth is enabled. Finish with 18.11 (return to open mode) so the rest of the smoke runs un-gated. Two browser profiles / private windows help (one admin, one regular user). Rows tagged 📱 need a connected/discoverable device.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 18.1 Default open    │ Both │ Fresh install (or auth never │ App loads with NO login prompt and works exactly  │ [ ]  │
│ mode                 │      │ enabled): load the app, open │ as prior betas. Auth is inert — nothing requires │      │
│                      │      │ Settings.                    │ signing in until a user is added.                │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 18.2 Secure the      │ Both │ Settings > manage users >    │ "Login is now required. Reloading..." then the   │ [ ]  │
│ admin account        │      │ Add user (auth off). In the  │ page reloads to the login page. The admin        │      │
│ (first user)         │      │ red "Secure the admin        │ password was set in the same step — there is     │      │
│                      │      │ account" block set an admin  │ never a password-less window.                    │      │
│                      │      │ username + password; fill the│                                                  │      │
│                      │      │ New user fields (user role); │                                                  │      │
│                      │      │ click Secure & add user.     │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 18.3 Login           │ Both │ On the login page, sign in   │ Reloads into the app, authenticated. Admin sees  │ [ ]  │
│                      │      │ with the admin credentials   │ the admin-only Settings sections (web port,      │      │
│                      │      │ from 18.2.                   │ dependencies, updates, service, Users).          │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 18.4 Brute-force     │ Both │ Log out (or private window). │ Every failure shows the same generic message     │ [ ]  │
│ lockout + generic    │      │ Attempt login with a WRONG   │ ("Invalid credentials or the account is          │      │
│ error                │      │ password 5x within 5 min;   │ temporarily locked.") — no hint whether the      │      │
│                      │      │ also try a non-existent      │ username exists, and the bad-username response   │      │
│                      │      │ username.                    │ is not noticeably faster (timing blinded).       │      │
│                      │      │                              │ After the 5th failure the account is locked      │      │
│                      │      │                              │ ~15 min; even the correct password is refused    │      │
│                      │      │                              │ while locked.                                    │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 18.5 Admin clears a  │ Both │ As admin (separate session,  │ The account unlocks immediately and can log in   │ [ ]  │
│ lockout              │      │ or after the lock expires),  │ again with the correct password.                 │      │
│                      │      │ Settings > manage users >    │                                                  │      │
│                      │      │ unlock the locked account.   │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 18.6 Manage users    │ Both │ In the Users modal as admin: │ Each change applies immediately and the list     │ [ ]  │
│ (role / disable /    │      │ change a user's role; toggle │ refreshes. A disabled account cannot log in.     │      │
│ reset / delete +     │      │ disable; reset password;     │ Deleting or demoting the LAST admin is refused   │      │
│ last-admin guard)    │      │ delete a throwaway account.  │ (you can't orphan the install).                  │      │
│                      │      │ Then try to delete or demote │                                                  │      │
│                      │      │ the only admin.              │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 18.7 Non-admin authz │ Both │ Log in as the regular user   │ Admin-only Settings sections are HIDDEN in the   │ [ ]  │
│ (UI + server)        │      │ account. Check Settings;     │ UI AND the direct admin request is REJECTED by   │      │
│                      │      │ then from dev-tools issue an │ the server (401/403), not merely hidden. The     │      │
│                      │      │ admin request: fetch('/api/  │ user can still connect/scan and keeps their own  │      │
│                      │      │ users',{method:'POST',...}).  │ theme/labels/settings.                          │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 18.8 Change own      │ Both │ As any user: Settings >      │ "password changed"; the new password works and   │ [ ]  │
│ password             │      │ change password > enter      │ the old one no longer does.                      │      │
│                      │      │ current + new > Save. Log    │                                                  │      │
│                      │      │ out, log back in with the    │                                                  │      │
│                      │      │ new password.                │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 18.9 Logout          │ Both │ Click log out in Settings.   │ Returns to the login page; the app is gated      │ [ ]  │
│                      │      │                              │ again until you sign in.                         │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 18.10 📱 WebSocket   │ Both │ While logged out (no valid   │ The device/video/audio/file WebSocket             │ [ ]  │
│ streams gated        │      │ session cookie), try to open │ connections are refused (closed unauthorized) —  │      │
│                      │      │ a device stream / file-      │ auth gates the live streams, not just the HTML   │      │
│                      │      │ browser / shell, or load the │ page.                                            │      │
│                      │      │ app un-authenticated.        │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 18.11 Return to open │ Both │ As admin: Settings > disable │ Page reloads; login no longer required; the app  │ [ ]  │
│ mode                 │      │ login (return to open mode). │ is open again. (Re-enabling still needs at least │      │
│                      │      │                              │ one admin with a password.)                      │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 18.12 Sessions       │ Both │ With auth enabled and a      │ Users persist and the existing HttpOnly session  │ [ ]  │
│ survive restart      │      │ session active, restart the  │ cookie is still valid after restart (sessions    │      │
│                      │      │ server (don't clear          │ are DB-backed in wsscrcpy.db) — no surprise      │      │
│                      │      │ cookies).                    │ logout.                                          │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

---

### Module 19 — Per-user device labels
*New in beta.67. Device labels are now per-user — each logged-in account sees its own names in scan results and the connected list. In open mode (default) labels behave exactly as before, so 19.1 is the no-regression check. Rows 19.2–19.3 need auth enabled (Module 18) with two accounts and at least one discoverable device.*

```text
┌──────────────────────┬──────┬──────────────────────────────┬──────────────────────────────────────────────────┬──────┐
│ Test                 │ OS   │ Do this                      │ Pass - what you should see                       │ Done │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 19.1 📱 Open-mode    │ Both │ In open mode (auth off):     │ The label persists and shows as before — per-    │ [ ]  │
│ labels unchanged     │      │ scan or connect a device,    │ user storage is transparent in open mode (single │      │
│                      │      │ set a label, reload.         │ implicit user). No regression vs prior betas.    │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 19.2 🔐📱🌐 Per-user │ Both │ Auth enabled (Module 18),    │ B sees no label (or B's own) for that device —   │ [ ]  │
│ label isolation      │      │ accounts A and B. As A: scan │ NOT A's label. Set "B-name" as B. Log back in as │      │
│                      │      │ a device, label it "A-name". │ A → still "A-name". Each account's labels are    │      │
│                      │      │ Log out. As B: scan the SAME │ isolated.                                        │      │
│                      │      │ device.                      │                                                  │      │
├──────────────────────┼──────┼──────────────────────────────┼──────────────────────────────────────────────────┼──────┤
│ 19.3 🔐📱🌐 Labels   │ Both │ With A and B each holding a  │ Each user's scan hits show that user's own label │ [ ]  │
│ in live scan hits    │      │ distinct label for the device│ (A sees "A-name", B sees "B-name") — labels are  │      │
│                      │      │ (from 19.2): as each user    │ resolved per logged-in user as the scan streams, │      │
│                      │      │ run a network scan.          │ not globally.                                    │      │
└──────────────────────┴──────┴──────────────────────────────┴──────────────────────────────────────────────────┴──────┘
```

---

## Global pass criteria

```text
┌──────────────────────┬────────────────────────────────────────────────────────────────┬──────┐
│ Criterion            │ Holds when                                                     │ Done │
├──────────────────────┼────────────────────────────────────────────────────────────────┼──────┤
│ SELinux clean (Lin)  │ Zero denials all session; the fcontext list is empty after     │ [ ]  │
│                      │ every uninstall.                                               │      │
├──────────────────────┼────────────────────────────────────────────────────────────────┼──────┤
│ One instance         │ Never two trays (Windows) or two servers (Linux) per           │ [ ]  │
│                      │ user/session.                                                  │      │
├──────────────────────┼────────────────────────────────────────────────────────────────┼──────┤
│ Relaunch fidelity    │ Every uninstall > relaunch returns on the SAME port; no        │ [ ]  │
│                      │ leftover processes.                                            │      │
├──────────────────────┼────────────────────────────────────────────────────────────────┼──────┤
│ Updates everywhere   │ local, machine-wide /opt (no service), user-service, and       │ [ ]  │
│                      │ system-service all update + relaunch on the same port; zero    │      │
│                      │ denials on the system path.                                    │      │
├──────────────────────┼────────────────────────────────────────────────────────────────┼──────┤
│ Clean shutdown       │ "stop server & exit" shuts down adb (+ the Windows tray) with  │ [ ]  │
│                      │ no leftovers; disabled in service mode.                        │      │
├──────────────────────┼────────────────────────────────────────────────────────────────┼──────┤
│ Data preserved       │ Your config/deps/logs survive an uninstall + reinstall.        │ [ ]  │
├──────────────────────┼────────────────────────────────────────────────────────────────┼──────┤
│ Core flow            │ scan > connect > stream (video + control) > shell works on both│ [ ]  │
│                      │ Windows and Linux.                                             │      │
├──────────────────────┼────────────────────────────────────────────────────────────────┼──────┤
│ Accessible UI        │ Keyboard focus stays visible (:focus-visible); reduce-motion is│ [ ]  │
│                      │ honoured; both themes render fully with no off-theme tints.    │      │
├──────────────────────┼────────────────────────────────────────────────────────────────┼──────┤
│ Auth opt-in          │ Off by default; enabling via the first-user lockdown gates     │ [ ]  │
│                      │ BOTH HTTP and device/stream WebSockets; brute-force lockout +  │      │
│                      │ admin-unlock work; change-password / logout / disable-to-open- │      │
│                      │ mode all work; the last admin can never be locked out. Open    │      │
│                      │ mode is unchanged.                                             │      │
├──────────────────────┼────────────────────────────────────────────────────────────────┼──────┤
│ Per-user labels      │ Each logged-in account sees only its own device labels in scan │ [ ]  │
│                      │ hits + the connected list; open mode (single implicit admin)   │      │
│                      │ is unchanged from prior betas.                                 │      │
└──────────────────────┴────────────────────────────────────────────────────────────────┴──────┘
```

**If any Linux SELinux/lifecycle test (Modules 2, 4, 5, the service-update rows 6.5/6.6) — or the core-flow criterion — fails:** stop, **run `capture-logs.sh <id>` (Pre-flight F; `.ps1` on Windows)** for the evidence bundle, and report it before promoting 0.1.30 to stable. Cosmetic/polish failures: note and triage later. **Module 11 (no-libfuse2)** is the regression check on the already-removed libfuse2 gate — an 11.2 failure means **revert PR #422** (restore the gate); it doesn't block 0.1.30 on its own.

*Plain-English companion to [`smoke-full.md`](./smoke-full.md), the canonical machine-precise checklist. The same tests as the repo doc, with the jargon spelled out; if the two ever diverge, the full doc wins.*
