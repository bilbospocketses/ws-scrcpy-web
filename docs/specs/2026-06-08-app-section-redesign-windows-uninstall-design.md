# App-section redesign + in-app Windows uninstall — design

**Date:** 2026-06-08
**Status:** approved (brainstorm) — pending spec review

## Goal

Four changes to **Settings → App**, bringing the Windows and Linux variants closer:

1. **Reorder** the App-section rows (per-OS).
2. Move the **uninstall confirmation** from an inline panel to an **overlay modal**.
3. Add an **in-app Windows uninstall** — Windows has no in-app uninstall today (only Add/Remove Programs); give it the same "uninstall ws-scrcpy-web" button Linux has.
4. **Fix the Windows "stop server & exit" teardown** — the tray (`ws-scrcpy-web-tray.exe`) is left resident, and adb is only `kill-server`'d (missing the `taskkill /F /IM adb.exe /T` belt-and-braces the update path uses), so stray adb can linger. node + launcher do exit.

## Current state

- `src/app/client/SettingsModal.ts` builds the App-section rows in this order via `buildRow(...)` + `appendChild`: **stop-server** (~L1610), **reset prompts** (~L1623), **install-for-all-users** (~L1683, Linux-only), **uninstall** (~L1695, Linux-only). Row visibility/enabled state comes from a pure helper (`appSectionButtonsState`, ~L158–209; applied at ~L1221). The uninstall confirmation is an **inline panel** beneath the button (`buildUninstallControl`, the settings-confirm-panel pattern).
- **Linux uninstall:** `POST /api/service/uninstall-app` (`ServiceApi.handleAppUninstall`, ~L980) → spawns the detached, out-of-cgroup `--linux-app-uninstall` helper (`launcher/src/linux_app_uninstall.rs`, pure `app_uninstall_commands` split into privileged/user-owned) → cascades through any service + removes `/opt` + deps; `keep` preserves `config.json` + `logs/`, else wipes. App then exits.
- **Windows uninstall:** only via Add/Remove Programs → the Velopack uninstaller runs the launcher with `--veloapp-uninstall` → `hooks.rs:on_uninstall` (servy stop + uninstall the `WsScrcpyWeb` service, kill the tray, **preserve user data**). No in-app trigger. Each install has `<installRoot>\Update.exe` (Velopack's updater/uninstaller).

## Design

### 1. App-section row order

```
LINUX                                WINDOWS
─────────────────────────────        ─────────────────────────────
reset welcome & bookmark             reset welcome & bookmark
install for all users                stop the server and close the app
stop the server and close the app    uninstall ws-scrcpy-web   ← NEW
uninstall ws-scrcpy-web
```

Pure reorder of the `appendChild` sequence. `install for all users` stays **Linux-only**; the **uninstall** row now renders on **both** OSes. `reset` moves to the top on both. The `appSectionButtonsState` helper is extended so `showUninstall` is true on win32 too (today it is `linux` only).

### 2. Uninstall confirmation → overlay modal (both OS)

Replaces the inline confirm panel with a **top-layer `<dialog>`** opened via `showModal()` (consistent with the welcome / system-wide-install modals, and avoids the z-index/top-layer trap noted in the Velopack packaging memory).

Contents:
- Title: **uninstall ws-scrcpy-web**
- One-line body: *"this removes the app, its dependencies, and any installed service."*
- Checkbox: **keep my settings & logs** — **defaults to checked** (deleting data is a deliberate uncheck). No extra explanatory line.
- Two buttons:
  - **cancel** — white text + white border (the existing white-outline style) → closes the modal, no action.
  - **uninstall** — **red text + red border** (new red-outline danger style) → `POST /api/service/uninstall-app { keep: <checkbox> }`, then the "uninstalling…" overlay, then the app exits.

The `keep` semantics are identical to Linux's existing toggle; the modal simply moves where it is asked.

### 3. Windows uninstall backend

`ServiceApi.handleAppUninstall` gains a **win32 branch** (today it returns `{ ok:false, reason:'unsupported' }` on non-linux). It mirrors the Linux branch: resolve `keep` from the body, spawn a **detached + elevated** Windows uninstall helper, write a 200 `{ ok:true, status:'uninstalling' }`, and schedule the local instance's exit so the helper can remove the running binary.

New launcher routine **`launcher/src/windows_app_uninstall.rs`** (mirrors `linux_app_uninstall.rs`), dispatched by a new **`--windows-app-uninstall [--keep|--wipe]`** flag in `main.rs`. It:

1. **Triggers the Velopack uninstaller** — `<installRoot>\Update.exe --uninstall` (primary). This removes the Program Files install and fires the existing `--veloapp-uninstall` hook (servy stop + uninstall the service, kill the tray, ARP cleanup).
   - **VM-verified fallback:** if `Update.exe --uninstall` leaves the MSI's Add/Remove-Programs entry orphaned, switch to `msiexec /x {ProductCode}` (literally what ARP runs). Decided on the Win11 VM (see §6).
2. **Handles the dataRoot** (`%ProgramData%\WsScrcpyWeb`) for keep/wipe parity with Linux:
   - always remove `dependencies/`;
   - remove `config.json` + `logs/` **only if `keep` is false**.

The helper is the win32 analog of `linux_app_uninstall.rs`: a pure command/step builder (`windows_app_uninstall_commands` returning the `Update.exe` invocation + the dataRoot keep/wipe steps) wrapped by a thin best-effort executor.

**Elevation + survival.** The helper runs **elevated** (one UAC prompt) via the existing elevated-runner / `ShellExecuteEx "runas"` pattern, and must **survive the app's exit and job-object teardown** the same way the apply-time `Update.exe` does (it can't delete a running binary otherwise — cf. the Velopack Job-Object `KILL_ON_JOB_CLOSE` gotcha). Spawned out of the app's job, then the app exits.

### 4. Keep/wipe semantics (both OS, unchanged contract)

- **keep (checked — default):** `config.json` + `logs/` survive; `dependencies/` removed; app binary/install removed. A reinstall reuses the saved config (port).
- **wipe (unchecked):** the whole dataRoot is removed in addition to the app binary/install.

### 5. Pure / testable units

- **`appSectionButtonsState`** — extend + test: `showUninstall` true on win32; ordering reflected where state-driven.
- **Uninstall modal** — DOM construction, checkbox **defaults checked**, cancel(white)/uninstall(red) button classes, `keep` read from the checkbox.
- **`windows_app_uninstall_commands`** — Rust unit (like `app_uninstall_commands`): the `Update.exe --uninstall` step is always present; the dataRoot steps include `dependencies/` always and `config.json`+`logs/` only when `!keep`.
- **`ServiceApi` win32 branch** — vitest, platform pinned to `win32` (per the cross-platform-test discipline): asserts it spawns the helper + schedules exit, doesn't run the Linux path.

### 6. Verification

- **Automated:** vitest (frontend + API) + `cargo`/`cross` (launcher) — the pure pieces. CI is the Rust gate (the win32 helper compiles/tests there; local Windows `cargo test` covers the cross-platform parts).
- **The real gate — Win11 VM smoke** (you already run it): install via the MSI → in-app **uninstall** →
  - `Update.exe --uninstall` removes `C:\Program Files\WsScrcpyWeb\`, the service is gone (`sc query WsScrcpyWeb` → not found), the tray is gone, **the Add/Remove-Programs entry is gone** (no orphan), **one** UAC prompt;
  - **keep checked** → `config.json` + `logs/` survive under `%ProgramData%\WsScrcpyWeb`, `dependencies/` gone, a reinstall reuses the port; **unchecked** → the whole dataRoot is gone;
  - if the ARP entry orphans → flip to `msiexec /x {ProductCode}` and re-verify.
- Add Windows uninstall rows to the smoke docs (the Linux App-section rows already exist in Module 14 / batch #15).

### 7. Non-goals

- **No Windows "install for all users."** Velopack's PerMachine MSI already installs machine-wide; an in-app machine-wide install is meaningless on Windows.
- **No change to the Linux uninstall mechanism** — only its confirmation UX moves to the shared modal, and the checkbox now defaults checked.

### 8. Open item (VM-gated)

`Update.exe --uninstall` vs `msiexec /x {ProductCode}` — which produces a clean MSI uninstall (hook fires **and** ARP entry removed, no orphan). Resolved on the Win11 VM during the smoke; the helper is structured so the command choice is a one-line swap.

### 9. Windows tray reap on "stop server & exit" (item 4)

**Symptom:** on Windows, "stop server & exit" exits node + launcher + adb cleanly but leaves `ws-scrcpy-web-tray.exe` resident. Smoke 12.3 (SE-1) expected the reap; it was never runtime-verified on Windows.

**What's already there (verified by inspection):** the reap is wired — after `supervisor::run()` returns, `main.rs:391` calls `tray_supervisor::reap_tray_on_terminal_exit(data_root)`, which (gated only by `apply-update-pending` / `uninstall-pending` markers under `<dataRoot>/control/`) runs `taskkill /F /IM ws-scrcpy-web-tray.exe`. `data_root_from_env()` always returns `Some` on Windows (PROGRAMDATA-based), so the call site IS reached. `should_reap_tray_on_exit` is pure + unit-tested.

**Root cause — diagnose on the VM, then fix.** Candidates, in likely order:
1. **Respawn race (strongest):** the tray-supervisor poll thread (`tray_supervisor_loop`, 10 s) re-spawns a missing tray and is never signalled to stop before the reap. Its `stop_flag` exists but is unused (`let _stop = start_background(...)` in `supervisor.rs`). **Hardening regardless:** thread the `stop_flag` up so the supervisor/`main` sets it BEFORE the reap, so the loop can't respawn the tray the reap just killed.
2. **Stale marker:** a leftover `apply-update-pending` / `uninstall-pending` under `control/` skips the reap. Confirm none is present on a plain stop-exit.
3. **taskkill miss:** the kill doesn't reach the tray (image-name/session). Confirm it runs + exits 0.

**Method:** on the Win11 VM, stop-exit then read `…\WsScrcpyWeb\logs\launcher.log` — is the `tray-supervisor: terminal exit; reaping tray helper` line present? is a marker present (the "leaving tray for relaunch" line)? Then fix the identified cause. Keep `should_reap_tray_on_exit` coverage; add a unit test for whatever pure decision the fix introduces (e.g. a `stop_flag`-set-before-reap ordering helper).

**adb — verified code gap (not just a runtime question).** `gracefulShutdown` (`src/server/index.ts:283`, the stop-exit teardown) runs **`adb kill-server` only**. The in-app *update* path (`UpdateService.ts:689-697` preApply hygiene) runs kill-server **plus** a Windows `taskkill /F /IM adb.exe /T` belt-and-braces — added precisely because kill-server alone leaves stray `adb.exe` (stuck transport, in-flight forward; the daemon is spawned `detached` to escape Node's job object). So stop-exit is missing that reap → stray adb survives on Windows. **Fix:** after `killServer()` in `gracefulShutdown`, add a win32-only `execFileAsync('C:\\Windows\\System32\\taskkill.exe', ['/F','/IM','adb.exe','/T'])` (non-zero = no-match = ok), mirroring the update path exactly. Unit-testable: pin win32, mock `execFileAsync`, assert the taskkill is issued.

**Note:** independent of the App-section UI work, but bundled into this pass + beta per the user's request.
