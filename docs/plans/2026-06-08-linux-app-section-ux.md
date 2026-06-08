# Linux App-section UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three Linux-only Settings → App features — an "install for all users" button, the start-menu icon, and an always-available "complete uninstall" — per `docs/specs/2026-06-08-linux-app-section-ux-design.md`.

**Architecture:** ① reuses the existing `POST /api/service/install-system-wide`; ② installs `assets/tray-icon.png` (already shipped in the AppImage via vpk `--icon`) to the hicolor theme dir during the machine-wide install; ③ adds `POST /api/app/uninstall`, which spawns a detached out-of-cgroup launcher helper (`--linux-app-uninstall`) that runs a pure-function-built teardown (cascading through any service), one pkexec when privileged, Local-Deps tools.

**Tech Stack:** TypeScript (frontend `src/app`, server `src/server`), Rust (`launcher/src`), vitest, Rust `#[test]`.

---

## Locked contracts

- **Uninstall endpoint:** `POST /api/service/uninstall-app` with JSON body `{ keep: boolean }` → `200 { ok: true, status: 'uninstalling' }`; `200 { ok:false, reason:'unsupported' }` on non-linux. (Lives under the existing `/api/service/` prefix the `ServiceApi` already owns — avoids a new router.)
- **Helper CLI:** `<launcher> --linux-app-uninstall --scope <user|system|none> --machine-wide <0|1> [--keep|--wipe]`. `scope` = the installed **service** scope (`none` if no service); `--machine-wide 1` when `/opt/ws-scrcpy-web` exists.
- **Status field:** none added — the frontend already has `machineWideInstalled` + `installMode` + `scope` from `/api/service/status`.
- **Icon install path:** `/usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png` (matches the existing `Icon=ws-scrcpy-web`).

## File structure

| File | Change | Responsibility |
|---|---|---|
| `launcher/src/linux_app_uninstall.rs` | **create** | pure `app_uninstall_commands(...)` builder + `dispatch()` (mirror of `linux_service.rs`) |
| `launcher/src/main.rs` (or `lib.rs` dispatch chain) | modify | wire the new `dispatch` into the launcher's arg-dispatch chain |
| `src/server/service/SystemdClient.ts` | modify | add the icon-install lines to `buildMachineWideInstallScript`; export an `appUninstall` helper-arg builder if useful |
| `src/server/api/ServiceApi.ts` | modify | new `handleAppUninstall` + route; spawn the detached helper |
| `src/common/ServiceEvents.ts` | modify | `AppUninstallRequest { keep: boolean }` type |
| `src/app/client/SettingsModal.ts` | modify | the two new App-section rows (install-all-users, uninstall) + confirm panel + gating |
| `scripts/package-linux.mjs` | modify (verify) | confirm the icon lands at a known `$APPDIR` path the install script can `cp` |
| `docs/smoke-tests/v0.1.30-beta.48-checklist.md` | modify | new uninstall smoke rows (final task) |
| `CHANGELOG.md` | modify | Added entries |

---

## Task 1: Rust — pure `app_uninstall_commands` builder

**Files:**
- Create: `launcher/src/linux_app_uninstall.rs`
- Test: same file `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing test** (mirror `linux_service.rs` `teardown_commands` tests). The builder returns ordered argv-vectors; assert the cascade + keep/wipe + machine-wide branching.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn joined(v: &[Vec<String>]) -> Vec<String> { v.iter().map(|c| c.join(" ")).collect() }

    #[test]
    fn local_wipe_removes_dataroot_no_opt_no_units() {
        let c = joined(&app_uninstall_commands(Scope::None, false, false, "/usr/bin", "/home/u/.local/share/WsScrcpyWeb", Some("/run/user/1000")));
        assert!(c.iter().any(|x| x.contains("rm") && x.contains("/home/u/.local/share/WsScrcpyWeb")));
        assert!(!c.iter().any(|x| x.contains("/opt/ws-scrcpy-web")));
        assert!(!c.iter().any(|x| x.contains("systemctl")));
    }

    #[test]
    fn local_keep_spares_config_and_logs_deletes_deps_bin_control() {
        let c = joined(&app_uninstall_commands(Scope::None, false, true, "/usr/bin", "/home/u/.local/share/WsScrcpyWeb", None));
        let dr = "/home/u/.local/share/WsScrcpyWeb";
        assert!(c.iter().any(|x| x.contains(&format!("rm -rf {dr}/dependencies"))));
        assert!(c.iter().any(|x| x.contains(&format!("rm -rf {dr}/bin"))));
        assert!(c.iter().any(|x| x.contains(&format!("rm -rf {dr}/control"))));
        assert!(!c.iter().any(|x| x.ends_with(dr)));              // never rm the whole dataRoot on keep
    }

    #[test]
    fn user_service_cascade_tears_down_user_unit_first() {
        let c = joined(&app_uninstall_commands(Scope::User, false, false, "/usr/bin", "/home/u/.local/share/WsScrcpyWeb", None));
        assert!(c.iter().any(|x| x.contains("systemctl") && x.contains("--user") && x.contains("stop")));
        assert!(c.iter().any(|x| x.contains("rm") && x.contains(".config/systemd/user/WsScrcpyWeb.service")));
    }

    #[test]
    fn system_install_includes_opt_var_opt_and_both_fcontext() {
        let c = joined(&app_uninstall_commands(Scope::System, true, false, "/usr/bin", "/var/opt/ws-scrcpy-web", None));
        assert!(c.iter().any(|x| x.contains("rm -rf /opt/ws-scrcpy-web")));
        assert!(c.iter().any(|x| x.contains("rm -rf /var/opt/ws-scrcpy-web")));
        assert!(c.iter().any(|x| x.contains("semanage fcontext -d") && x.ends_with("/opt/ws-scrcpy-web(/.*)?")));
        assert!(c.iter().any(|x| x.contains("semanage fcontext -d") && x.ends_with("/var/opt/ws-scrcpy-web(/.*)?")));
    }

    #[test]
    fn machine_wide_removes_desktop_and_icon() {
        let c = joined(&app_uninstall_commands(Scope::None, true, false, "/usr/bin", "/home/u/.local/share/WsScrcpyWeb", None));
        assert!(c.iter().any(|x| x.contains("/usr/share/applications/ws-scrcpy-web.desktop")));
        assert!(c.iter().any(|x| x.contains("/usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png")));
    }
}
```

- [ ] **Step 2: Run it, verify it fails** — Rust can't local-compile from Windows under no-`cd` (see spec/breadcrumb). The Rust gate is **CI `cargo test --workspace` + `clippy`**; the executor on a Linux dev box runs `cargo test -p ws-scrcpy-web-launcher app_uninstall`. Expected: FAIL (`app_uninstall_commands` undefined).

- [ ] **Step 3: Implement the pure builder.** Reuse `Scope` + `scope_prefix` + `unit_path` + `sbindir_from` from `linux_service.rs` (make them `pub(crate)` if not already). Order = `clear-install.sh`: kill strays → service teardown (cascade) → `/opt`+`/var/opt` → `.desktop`+icon → fcontext → lock → dataRoot (per keep). Privileged steps (system unit, `/opt`, `/var/opt`, system `.desktop`/icon, fcontext) are emitted as a separate `sudo`-prefixed/pkexec group by the caller (Task 2 wraps them); the builder returns `(privileged: Vec<Vec<String>>, user_owned: Vec<Vec<String>>)`.

```rust
// launcher/src/linux_app_uninstall.rs  (signature — body follows the teardown_commands pattern)
use crate::linux_service::{Scope, scope_prefix, unit_path, sbindir_from};

pub struct UninstallPlan { pub privileged: Vec<Vec<String>>, pub user_owned: Vec<Vec<String>> }

pub fn app_uninstall_commands(
    svc_scope: Scope, machine_wide: bool, keep: bool,
    bindir: &str, data_root: &str, xdg_runtime_dir: Option<&str>,
) -> UninstallPlan { /* build the two ordered vecs per the spec */ }
```

- [ ] **Step 4: Run tests, verify pass** — `cargo test -p ws-scrcpy-web-launcher app_uninstall` → PASS. Also `cargo clippy -p ws-scrcpy-web-launcher -- -D warnings` clean.

- [ ] **Step 5: Commit** — `git -C <repo> add launcher/src/linux_app_uninstall.rs && git -C <repo> commit -m "feat(launcher): pure app_uninstall_commands builder"`

## Task 2: Rust — `--linux-app-uninstall` dispatch + execution (pkexec / elevation)

**Files:** modify `launcher/src/linux_app_uninstall.rs` (+ `main.rs` dispatch chain). Mirror `linux_service.rs::dispatch` (`:209`) + `runPkexec` elevation.

- [ ] **Step 1: Write the failing test** — parse args (`--scope`, `--machine-wide`, `--keep`/`--wipe`) → the right `app_uninstall_commands(...)` inputs. (Pure `parse` fn like `linux_service::parse_args`.)
- [ ] **Step 2: Verify it fails** (`cargo test ... app_uninstall_parse`).
- [ ] **Step 3: Implement** `dispatch(args) -> Option<i32>`: parse → build the `UninstallPlan` → run `user_owned` directly; if `privileged` non-empty, run them under **one** `pkexec sh -c '<joined privileged script>'`; on pkexec decline (exit 126/127) → **relaunch local** (reuse `linux_apply` relaunch-only) and return. Tools resolved via the launcher's bindir (`current_exe`-derived, as `linux_service` does). Wire `dispatch` into the launcher's arg-dispatch chain alongside `linux_service::dispatch` / `linux_apply::dispatch` (`main.rs`).
- [ ] **Step 4: Verify pass** (`cargo test --workspace`, `clippy -D warnings`).
- [ ] **Step 5: Commit** — `feat(launcher): --linux-app-uninstall dispatch + pkexec teardown`

## Task 3: Server — `POST /api/service/uninstall-app`

**Files:** modify `src/common/ServiceEvents.ts`, `src/server/api/ServiceApi.ts` (route at `:106` block; handler near `handleInstallSystemWide` `:789`). Test: `src/server/__tests__/ServiceApi.test.ts`.

- [ ] **Step 1: Write the failing test** (inject `spawnDetached` + `scheduleExit` like the install tests; assert the detached helper is spawned with `--linux-app-uninstall` + the keep flag, and `scheduleExit` is scheduled).

```ts
it('POST /service/uninstall-app spawns the detached helper with keep flag + schedules exit', async () => {
  const spawn = vi.fn();
  const factoryResult: ServiceClientFactoryResult = { client: fakeClient({ status: vi.fn(async () => 'not-installed' as const) }), supported: true, platform: 'linux' };
  const api = new ServiceApi(() => factoryResult, () => 'user', () => true, spawn, () => {});
  const { req, res } = makeReqRes('/api/service/uninstall-app', 'POST', JSON.stringify({ keep: true }));
  await api.handle(req, res);
  expect((res as any).getStatus()).toBe(200);
  const args = spawn.mock.calls[0][1] as string[];
  expect(args).toContain('--linux-app-uninstall');
  expect(args).toContain('--keep');
});
```

- [ ] **Step 2: Verify fail** — `npm --prefix <repo> run test -- ServiceApi` → FAIL (route 404 / handler missing).
- [ ] **Step 3: Implement** `handleAppUninstall(req,res)`: non-linux → `{ok:false,reason:'unsupported'}`; else read `{keep}` (`readJsonBody`), detect service scope (`getInstalledScope`) + `machineWideInstalled` (`existsCheck STAGED_SYSTEM_DIR/...AppImage`), resolve the launcher helper (as `handleInstallSystemWide` `:813` does), `spawnDetached(systemd-run, ['--user','--collect', helper, '--linux-app-uninstall','--scope',scope,'--machine-wide',mw,keep?'--keep':'--wipe'])`, `scheduleExit(()=>process.exit(0),1500)`, respond `200 {ok:true,status:'uninstalling'}`. Add the route in the `/api/service/` block (`:106`).
- [ ] **Step 4: Verify pass** — `npm --prefix <repo> run test -- ServiceApi` → PASS; full `npm test` green; `tsc --noEmit` exit 0.
- [ ] **Step 5: Commit** — `feat(server): POST /api/service/uninstall-app detached teardown`

## Task 4: Frontend — install-for-all-users + uninstall buttons

**Files:** modify `src/app/client/SettingsModal.ts` (`buildAppSection` `:1404`; gate in `renderServiceState` `:1027`). Test: `src/app/client/__tests__/SettingsModal.test.ts`.

- [ ] **Step 1: Write the failing test** — a pure helper `appSectionButtonsState({platform, machineWideInstalled})` returning `{ showInstallAllUsers, installAllUsersDisabled, installAllUsersNote, showUninstall }` (Linux-only; install greyed+note when machine-wide; uninstall always shown+enabled on linux).

```ts
it('install-all-users greyed with note once machine-wide; uninstall always enabled on linux', () => {
  expect(appSectionButtonsState({ platform: 'linux', machineWideInstalled: false }))
    .toEqual({ showInstallAllUsers: true, installAllUsersDisabled: false, installAllUsersNote: null, showUninstall: true });
  const m = appSectionButtonsState({ platform: 'linux', machineWideInstalled: true });
  expect(m.installAllUsersDisabled).toBe(true);
  expect(m.installAllUsersNote).toMatch(/already installed for all users/i);
  expect(m.showUninstall).toBe(true);
  expect(appSectionButtonsState({ platform: 'win32', machineWideInstalled: false }))
    .toEqual({ showInstallAllUsers: false, installAllUsersDisabled: false, installAllUsersNote: null, showUninstall: false });
});
```

- [ ] **Step 2: Verify fail** — `npm --prefix <repo> run test -- SettingsModal` → FAIL.
- [ ] **Step 3: Implement** the pure `appSectionButtonsState` (export, like `stopServerButtonState`) + render the two rows in `buildAppSection` via `buildRow` (icon: reuse the confirm-panel pattern at `:1436` for the uninstall confirm + a `keep my settings & logs` checkbox; on confirm `POST /api/service/uninstall-app {keep}` then show "uninstalling… close this tab"). Install row → `POST /api/service/install-system-wide` then reload. Apply the state from `renderServiceState`.
- [ ] **Step 4: Verify pass** — `npm --prefix <repo> run test -- SettingsModal` → PASS; full `npm test` + `tsc` green.
- [ ] **Step 5: Commit** — `feat(ui): linux App-section install-all-users + uninstall buttons`

## Task 5: Icon install at machine-wide install

**Files:** modify `src/server/service/SystemdClient.ts` (`buildMachineWideInstallScript` `:364`) + add icon-teardown to the system `.desktop` removal; verify `scripts/package-linux.mjs` icon path in the AppImage. Test: `SystemdClient.test.ts`.

- [ ] **Step 1: Write the failing test** — `buildMachineWideInstallScript` output `cp`s the icon to `/usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png` + refreshes the cache.

```ts
it('machine-wide install installs the hicolor icon', () => {
  const s = buildMachineWideInstallScript({ sourceAppImage: '/home/u/App.AppImage', version: '0.1.30-beta.49', iconSource: '/tmp/.mount_x/ws-scrcpy-web.png' }, (t)=>`/usr/bin/${t}`, (t)=>`/usr/sbin/${t}`);
  expect(s).toContain('/usr/share/icons/hicolor/256x256/apps/ws-scrcpy-web.png');
  expect(s).toContain('gtk-update-icon-cache');
});
```

- [ ] **Step 2: Verify fail** — `npm --prefix <repo> run test -- SystemdClient` → FAIL.
- [ ] **Step 3: Implement** — add `iconSource` to the args; emit `mkdir -p .../apps`, `cp "${iconSource}" .../ws-scrcpy-web.png`, `( gtk-update-icon-cache -f /usr/share/icons/hicolor || true )` (best-effort, Local-Deps `binTool`). The caller (`handleInstallSystemWide`) resolves the icon from the AppImage: `path.join(process.env.APPDIR ?? '', '.DirIcon')` (vpk's `--icon` lands the PNG at the AppImage `.DirIcon`). **Verify** on the Linux box that `$APPDIR/.DirIcon` is the 256×256 PNG; if vpk instead nests it, adjust the resolved path (one-line). The system `.desktop` teardown (Task 1 builder) already removes the icon.
- [ ] **Step 4: Verify pass** — `npm --prefix <repo> run test -- SystemdClient` → PASS; full `npm test` + `tsc` green.
- [ ] **Step 5: Commit** — `feat(linux): install the app icon for the start-menu entry`

## Task 6: Smoke rows + CHANGELOG

**Files:** modify `docs/smoke-tests/v0.1.30-beta.48-checklist.md` (+ the `-full.md` reference), `CHANGELOG.md`.

- [ ] **Step 1** — add a new run-sheet batch with rows: uninstall from local / user-service (cascade) / system-service (cascade + pkexec) / machine-wide-no-service; keep vs wipe (config + logs survive / gone; **deps gone in every case**); `semanage fcontext -l | grep ws-scrcpy-web` empty after; zero AVC; start-menu icon present after install; "install for all users" button greyed once on `/opt`.
- [ ] **Step 2** — CHANGELOG `Added`: the three features (user-facing voice).
- [ ] **Step 3: Commit** — `docs: beta.49 uninstall/install/icon smoke rows + changelog`

---

## Self-review

- **Spec coverage:** ① Task 4 (button) + reuse endpoint ✓. ② Task 5 (icon) ✓. ③ Tasks 1–4 (builder, dispatch+pkexec, endpoint, button+modal+keep) ✓. Smoke rows Task 6 ✓. Elevation/Local-Deps/cascade/keep-semantics all in Tasks 1–3.
- **Placeholders:** the one acknowledged investigation is the `$APPDIR` icon path (Task 5 Step 3) — bounded to a one-line adjustment with a verify step, not an open-ended TODO.
- **Type consistency:** `app_uninstall_commands` / `UninstallPlan` / `--linux-app-uninstall` / `/api/service/uninstall-app` / `appSectionButtonsState` used consistently across tasks.

## Open items carried from the spec (resolve during execution)

1. `$APPDIR/.DirIcon` is the right icon source (Task 5 Step 3 verify).
2. pkexec from the detached `systemd-run --collect` helper has a polkit session (the install-handoff + system-update paths already pkexec from similar contexts — reuse).
