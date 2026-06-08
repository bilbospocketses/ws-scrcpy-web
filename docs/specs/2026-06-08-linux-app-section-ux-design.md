# Linux App-section UX — Design

**Date:** 2026-06-08 · **Target:** beta.49 · **Surfaced by:** the 0.1.30 Fedora smoke.

Three **Linux-only** Settings → App enhancements. All three render only when `/api/service/status`
reports `platform === 'linux'`.

## Goals

1. **Install for all users** — a persistent button to trigger the machine-wide (`/opt`) install, instead of offering it only in the first-run modal.
2. **Start-menu icon** — the Linux menu entry shows the app's icon (today it's generic).
3. **Complete uninstall** — an in-app button that fully removes the install (cascading through any installed service), with an option to keep settings + logs.

## Non-goals

- No Windows changes; the Windows Add/Remove uninstall already covers that platform.
- The first-run `SystemWideInstallModal` is unchanged — the new button is additive.
- **Not** shipping `clear-install.sh` into the app — that's the bare-`PATH` *smoke* tool; the in-app teardown is its Local-Dependencies-Only sibling.
- "Keep" preserves settings + logs only — **never** dependencies (those are re-downloadable artifacts, not user data).

---

## Feature 1 — "Install for all users" button

**Context.** The machine-wide install already exists end-to-end: `POST /api/service/install-system-wide` → `handleInstallSystemWide` (`ServiceApi.ts`) runs one pkexec via `buildMachineWideInstallScript` (relocate the AppImage to `/opt`, write `VERSION` + the system `.desktop`, delete the home copy), then re-execs from `/opt`. `/api/service/status` already returns `machineWideInstalled`. Today this is only reachable via the first-run modal.

**Design.** Add a Linux-only row to `buildAppSection` (`SettingsModal.ts`): label *"install for all users"*, button *"install"*.
- `machineWideInstalled === true` → button **disabled** + neutral note *"already installed for all users (/opt)."*
- On click → confirm (it's a pkexec action — reuse the existing confirm pattern) → `POST /api/service/install-system-wide`. On 200, reload (the server is re-execing to `/opt`); on 403 (declined) / 500, surface the error inline.
- State wired off the same status payload (`machineWideInstalled`, `platform`) as the scope radios, in `renderServiceState`.

**Components.** `SettingsModal.ts` only. No backend change.

---

## Feature 2 — Start-menu icon

**Context.** `buildMachineWideInstallScript` (`SystemdClient.ts:384`) already writes `Icon=ws-scrcpy-web` into the system `.desktop`, but nothing installs an icon **file** under that name, so the desktop can't resolve it → generic icon. The asset exists: `assets/tray-icon.png` (256×256, already used for the vpk `--icon`).

**Design.**
1. **Bundle** `assets/tray-icon.png` into the Linux AppImage payload at a stable relative path, so the install script (running from the mounted `$APPDIR`) can copy it. — `scripts/package-linux.mjs` / the AppDir build.
2. **Install** at machine-wide install — after the `.desktop` write in `buildMachineWideInstallScript`: `cp` the bundled icon → `/usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png`, then `gtk-update-icon-cache -f /usr/share/icons/hicolor` (best-effort `|| true`). Tools resolved via `binTool`/`sbinTool` (Local-Deps), like the rest of the script.
3. **AppImage `.DirIcon`** — ensure the AppImage's embedded icon is `tray-icon.png` too, so file managers / appimaged thumbnails show it (verify in the build).
4. **Uninstall** removes the installed icon (Feature 3 teardown).

**Open.** Confirm where the current `package-linux.mjs` AppDir places an icon and that the payload exposes one at a stable path the install script can `cp` from `$APPDIR`.

---

## Feature 3 — Complete-uninstall button

**Context.** No non-service "uninstall the app" path exists today — only the **service** teardown (`teardown_commands` + the `--linux-service-teardown` dispatch in `launcher/src/linux_service.rs`, spawned detached via `spawnDetached` + `systemd-run --user --collect`). The full-footprint teardown is captured in `docs/smoke-tests/clear-install.sh` (smoke tool, bare-`PATH`).

### Frontend (`SettingsModal.ts`, App section)

- Linux-only **"uninstall ws-scrcpy-web"** button — **always enabled** (NOT gated on service mode; this is the key difference from "stop server & exit", which stays greyed in service mode).
- On click → inline confirm panel (reuse the existing `confirmPanel` pattern) with:
  - warning text (*"completely removes ws-scrcpy-web, including any installed service"*);
  - a **"keep my settings & logs"** checkbox — **unchecked by default**;
  - white-outline confirm / cancel.
- On confirm → `POST /api/app/uninstall { keep: boolean }`. The tab then shows *"uninstalling… you can close this tab once it finishes."*

### Backend (`ServiceApi.ts`, new `handleAppUninstall`)

- Resolve the launcher helper path (as the service install/teardown already do).
- Spawn a **detached, out-of-cgroup** helper: `systemd-run --user --collect <launcher> --linux-app-uninstall --scope <detected> [--keep|--wipe]`.
- Schedule the local server exit (existing `scheduleExit` pattern) so the helper can reap it.
- Respond `200 { status: 'uninstalling' }`.

### Helper (launcher Rust — new `--linux-app-uninstall` mode, sibling of `--linux-service-teardown`)

Full footprint teardown in **one pass, no relaunch**, Local-Deps tools (resolved via `bindir`):

1. **Kill strays** — server / launcher / tray / escaped adb (after the server has exited).
2. **Service teardown if present** — user and/or system: stop / disable / reset-failed + remove the unit (reuse `teardown_commands` per scope). *This is the cascade — service first, then app.*
3. **`/opt` + `/var/opt`** — remove the machine-wide binary tree and (system) state.
4. **Menu `.desktop` + icon** — remove `/usr/share/applications/ws-scrcpy-web.desktop` and `/usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png`; refresh the caches.
5. **SELinux** — `semanage fcontext -d` the current rules **and** the legacy `/opt/.../data` rule.
6. **Instance lock** — remove `$XDG_RUNTIME_DIR/ws-scrcpy-web.lock`.
7. **Data root — per `keep`:**
   - **wipe (default):** remove `~/.local/share/WsScrcpyWeb` and/or `/var/opt/ws-scrcpy-web` entirely.
   - **keep:** preserve only `config.json` + `logs/` at the mode's location (`~/.local/share/WsScrcpyWeb` for local/user-scope; `/var/opt/ws-scrcpy-web` for system-scope); delete `dependencies/`, staged `bin/`, and `control/` markers; **reset the service-mode markers** in the kept `config.json` (clear `installMode` from `user-service`/`system-service` back to the non-service value — `null`/`user`) so a reinstall/relaunch comes up clean. **Dependencies are always removed** (re-download on reinstall) regardless of `keep`.

### Elevation

A **single pkexec** wraps the privileged steps (system unit, `/opt`, `/var/opt`, the system `.desktop`, the icon, system fcontext) — needed only when a system service OR a machine-wide `/opt`/`/var/opt` exists. A pure home/user install (local or user-scope service) needs **no** prompt (all paths are user-owned). This mirrors the service install/update elevation split (`getuid()===0 ? direct : pkexec`).

**Ordering / decline:** the helper attempts the pkexec **first**; on **decline**, it aborts before removing anything privileged and **relaunches the app in local mode** (the service-teardown rollback pattern) so the user isn't stranded; on **grant**, it proceeds with the full teardown and does **not** relaunch. The user-owned steps (dataRoot, lock, user-scope unit) run regardless.

### Local-Deps

All tools (`systemctl`, `semanage`, `restorecon`, `rm`, `pkill`, `pkexec`, `gtk-update-icon-cache`) are resolved via the launcher's `bindir` (the `systemTools` resolution the service teardown already uses). `clear-install.sh` is **not** shipped into the app.

---

## Data flow (Feature 3)

frontend confirm (+`keep`) → `POST /api/app/uninstall` → backend spawns the detached helper + schedules its own exit → server exits → helper: (pkexec privileged set, if needed) + user-owned set → footprint gone → the tab is already on *"uninstalling… close this tab."*

## Error handling

- **pkexec declined** → abort the privileged set (nothing privileged removed before the grant) + relaunch local; the frontend reconnects to the relaunched instance.
- **Helper step failure** → best-effort `|| true` per step (like the smoke script) so one failure doesn't strand a half-removed install; write a teardown log under a stable path for diagnosis.
- **Headless / no display** → the teardown still runs (not UI-dependent); the "close tab" message is moot.

## Testing

- **Rust unit** — a pure `app_uninstall_commands(scope, machine_wide, keep)` builder (mirror of `teardown_commands`): assert the command vectors for local / user-service / system-service / machine-wide-no-service × keep/wipe. No real filesystem.
- **vitest** — frontend: the button renders Linux-only + always-enabled; the keep-checkbox → POST payload; the confirm-panel behavior. Backend: `handleAppUninstall` spawns the detached helper with the right args + schedules exit (inject `spawnDetached`/`scheduleExit`, as the install tests do).
- **Smoke (new run-sheet rows)** — uninstall from: local, user-service (cascade), system-service (cascade + pkexec), machine-wide-no-service; keep vs wipe (config + logs survive / gone); `semanage fcontext -l | grep ws-scrcpy-web` empty after; zero AVC; dependencies gone in every case.

## Open questions / risks

1. **AppImage icon payload** — confirm where the build exposes an icon the install script can `cp` from `$APPDIR`.
2. **pkexec from the detached `systemd-run --collect` helper** — confirm it has a polkit/session context to prompt (the install-handoff helper runs similarly; the system-service update path already pkexecs — reuse that context).
3. **Endpoint + flag naming** — `/api/app/uninstall` + `--linux-app-uninstall` (finalize in the plan).
4. **Server-exit vs pkexec ordering** — resolve in the plan (the helper must own the pkexec out-of-cgroup so it survives the server exit and can relaunch on decline).

## Out of scope

- Windows uninstall (Add/Remove covers it).
- Changing the first-run system-wide modal.
- Keeping dependencies on uninstall.
