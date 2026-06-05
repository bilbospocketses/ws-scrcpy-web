# Machine-wide `/opt` Install — Phases 2 & 3 Implementation Plan (consolidated)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Each Rust task: `cross test`/`cross clippy` (Docker; plain cargo fails — no Linux linker). Each TS task: `npm test -- <file>` AND **`npx tsc --noEmit` (0 errors — vitest does NOT type-check)**. `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web"`; no push; branch `path2-machine-wide-install`. Verify each task's on-disk diff + the type-check yourself; IDE mid-edit diagnostics are often stale.

**Goal:** Phase 2 — a system-scope uninstall relaunches the app for the active desktop user on the exact port their browser is on. Phase 3 — machine-wide installs update via one pkexec, existing beta.40 system installs migrate, and the bootstrapper is version-aware.

**Architecture:** Reuse the established pure-fn-+-thin-exec-seam pattern in `linux_service.rs`/`linux_apply.rs` and the `buildMachineWideInstallScript`/`runPkexec` builders from Phase 1. Phase 2 adds loginctl discovery + a `systemd-run --uid` relaunch + a `WS_SCRCPY_WEB_PORT` server override. Phase 3 routes machine-wide updates through the install builder under pkexec, adds migration detect→reinstall, and makes the bootstrapper version-compare.

**Tech Stack:** Rust launcher (`cross … x86_64-unknown-linux-gnu`), TS server (vitest + `tsc`), frontend.

**Spec:** `docs/specs/2026-06-05-machine-wide-opt-install-phases2-3-design.md`.

---

## File structure
- `launcher/src/linux_service.rs` — loginctl parsers + `system_relaunch_command` + `run()` System relaunch branch (P2); version-compare in `bootstrap_target` (P3c).
- `launcher/src/main.rs` — pass the running version into the bootstrap seam (P3c).
- `src/server/PortPicker.ts` (or wherever webPort resolves) — honor `WS_SCRCPY_WEB_PORT` (P2-3).
- `src/server/UpdateService.ts` — machine-wide-no-service update branch (P3b).
- `src/server/api/ServiceApi.ts` — migration-detect status flag + reinstall endpoint (P3a); version-newer flag + offer endpoint (P3c).
- `src/app/client/SettingsModal.ts` / `src/app/index.ts` — migration notice + [reinstall now]; "update the system-wide install" offer (P3a/P3c).

---

# PHASE 2 — loginctl uninstall→relaunch

## Task P2-1: loginctl discovery parsers (pure)

**Files:** `launcher/src/linux_service.rs` (+ tests). Run: `cross test -p ws-scrcpy-web-launcher --target x86_64-unknown-linux-gnu linux_service`.

- [ ] **Step 1 — failing tests** (add to `mod tests`):
```rust
#[test]
fn parses_session_ids_from_list() {
    let list = "   3 1000 jamie seat0 tty2\n  c1 0 root  -    -\n";
    assert_eq!(parse_session_ids(list), vec!["3".to_string(), "c1".to_string()]);
}
#[test]
fn active_graphical_uid_only_when_active_and_graphical() {
    assert_eq!(active_graphical_uid_from_show("Active=yes\nType=wayland\nUser=1000\nDisplay="), Some(1000));
    assert_eq!(active_graphical_uid_from_show("Active=yes\nType=x11\nUser=1001\nDisplay=:0"), Some(1001));
    assert_eq!(active_graphical_uid_from_show("Active=no\nType=x11\nUser=1000\nDisplay=:0"), None);
    assert_eq!(active_graphical_uid_from_show("Active=yes\nType=tty\nUser=1000\nDisplay="), None);
}
```
- [ ] **Step 2 — run, verify FAIL.**
- [ ] **Step 3 — implement** (near `relaunch_target`):
```rust
/// First column of each `loginctl list-sessions --no-legend` line = session id.
pub fn parse_session_ids(list_output: &str) -> Vec<String> {
    list_output.lines().filter_map(|l| l.split_whitespace().next()).map(str::to_string).collect()
}
/// uid of the session from a `loginctl show-session <id> -p Active -p Type -p User -p Display`
/// block, IFF it is active AND graphical (x11/wayland). We don't need DISPLAY — the
/// relaunched app is a server the browser reconnects to.
pub fn active_graphical_uid_from_show(show_output: &str) -> Option<u32> {
    let (mut active, mut kind, mut uid) = (false, String::new(), None::<u32>);
    for line in show_output.lines() {
        if let Some((k, v)) = line.split_once('=') {
            match k.trim() {
                "Active" => active = v.trim() == "yes",
                "Type" => kind = v.trim().to_string(),
                "User" => uid = v.trim().parse().ok(),
                _ => {}
            }
        }
    }
    if active && (kind == "x11" || kind == "wayland") { uid } else { None }
}
```
- [ ] **Step 4 — run PASS + `cross clippy … -- -D warnings` clean. Paste both.**
- [ ] **Step 5 — commit:** `feat(linux): loginctl active-graphical-session parsers (Phase 2)`

## Task P2-2: `system_relaunch_command` builder (pure)

**Files:** `launcher/src/linux_service.rs` (+ test).

- [ ] **Step 1 — failing test:**
```rust
#[test]
fn system_relaunch_command_runs_as_user_on_service_port() {
    assert_eq!(
        system_relaunch_command("/usr/bin/systemd-run", 1000, "/home/jamie", 8000, "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"),
        vec!["/usr/bin/systemd-run", "--uid=1000", "--setenv=HOME=/home/jamie",
             "--setenv=WS_SCRCPY_WEB_PORT=8000", "--collect", "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"]
    );
}
```
- [ ] **Step 2 — run, verify FAIL.**
- [ ] **Step 3 — implement:**
```rust
/// `systemd-run --uid=<uid> --setenv=HOME=<home> --setenv=WS_SCRCPY_WEB_PORT=<port>
/// --collect <appimage>` — relaunch the shared /opt binary AS the user, with HOME
/// (mandatory — else data_root_for_linux panics) and the service's port (so the
/// browser reconnects). No DISPLAY (it's a server). Pure.
pub fn system_relaunch_command(systemd_run: &str, uid: u32, home: &str, web_port: u16, appimage: &str) -> Vec<String> {
    vec![
        systemd_run.to_string(),
        format!("--uid={uid}"),
        format!("--setenv=HOME={home}"),
        format!("--setenv=WS_SCRCPY_WEB_PORT={web_port}"),
        "--collect".to_string(),
        appimage.to_string(),
    ]
}
```
- [ ] **Step 4 — run PASS + clippy clean.**
- [ ] **Step 5 — commit:** `feat(linux): system_relaunch_command (run as user, service port) (Phase 2)`

## Task P2-3: server honors `WS_SCRCPY_WEB_PORT` override

**Files:** READ how webPort resolves (grep `src/server` for `webPort`/`PortPicker`/`reconcileWebPort`); add the override at the front of resolution. Test: the relevant resolver's vitest. Run: `npm test -- <that test>` + `npx tsc --noEmit`.

- [ ] **Step 1 — failing test:** assert that when `process.env.WS_SCRCPY_WEB_PORT` is a valid port, the resolved desired webPort is exactly that (overriding the config value); when unset/invalid, behavior is unchanged. (Mirror the existing PortPicker/webPort resolver test; set/restore the env in the test.)
- [ ] **Step 2 — run, verify FAIL.**
- [ ] **Step 3 — implement:** in the webPort resolver, before reading config: `const ov = Number(process.env['WS_SCRCPY_WEB_PORT']); if (Number.isInteger(ov) && ov > 0 && ov < 65536) return ov;` (force this exact port — do NOT auto-shift; it's free post-uninstall). Keep the existing config/default + PortPicker path for the unset case. The bound port still persists via the existing write-back.
- [ ] **Step 4 — run PASS + `npx tsc --noEmit` 0 errors.**
- [ ] **Step 5 — commit:** `feat(server): WS_SCRCPY_WEB_PORT one-shot port override (Phase 2)`

## Task P2-4: wire System-scope relaunch into `run()`

**Files:** `launcher/src/linux_service.rs` — the `run()` relaunch section (currently: `relaunch_target(scope, marker)` → `systemd-run --user --collect` for User; System is `None` → no relaunch). Imperative seam: compile/clippy here, **Fedora-verified**.

- [ ] **Step 1 — read** the current `run()` relaunch block + `relaunch_target`.
- [ ] **Step 2 — implement** — keep the **User** path exactly as-is; add a **System** branch + an imperative discovery helper:
```rust
/// Best-effort: the active graphical session's uid via loginctl (absolute paths,
/// Local-Deps). Pure parsers (P2-1) do the work; this is the exec seam.
fn discover_active_graphical_uid() -> Option<u32> {
    let loginctl = format!("{}/loginctl", tool_dir("loginctl"));
    let list = std::process::Command::new(&loginctl).args(["list-sessions", "--no-legend"]).output().ok()?;
    for id in parse_session_ids(&String::from_utf8_lossy(&list.stdout)) {
        if let Ok(show) = std::process::Command::new(&loginctl)
            .args(["show-session", &id, "-p", "Active", "-p", "Type", "-p", "User", "-p", "Display"]).output() {
            if let Some(uid) = active_graphical_uid_from_show(&String::from_utf8_lossy(&show.stdout)) {
                return Some(uid);
            }
        }
    }
    None
}
/// Resolve a uid's home dir from `getent passwd <uid>` (field 6). Absolute path.
fn home_for_uid(uid: u32) -> Option<String> {
    let getent = format!("{}/getent", tool_dir("getent"));
    let out = std::process::Command::new(&getent).args(["passwd", &uid.to_string()]).output().ok()?;
    String::from_utf8_lossy(&out.stdout).lines().next()?.split(':').nth(5).map(str::to_string)
}
```
  In `run()`, replace the relaunch block with a scope branch — **User** = the existing `relaunch_target` + `systemd-run --user --collect`; **System** =:
```rust
    if scope == Scope::System {
        let systemd_run = format!("{}/systemd-run", tool_dir("systemd-run"));
        let appimage = "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage";
        let web_port = common::config::AppConfig::load(std::path::Path::new("/var/opt/ws-scrcpy-web")).web_port;
        match (discover_active_graphical_uid(), web_port) {
            (Some(uid), Some(port)) => match home_for_uid(uid) {
                Some(home) => {
                    let argv = system_relaunch_command(&systemd_run, uid, &home, port, appimage);
                    let (cmd, rest) = argv.split_first().expect("non-empty argv");
                    match std::process::Command::new(cmd).args(rest).status() {
                        Ok(s) => log::info(&format!("system uninstall: relaunched {appimage} as uid {uid} on port {port} (exit {:?})", s.code())),
                        Err(e) => log::error(&format!("system uninstall: relaunch failed: {e}")),
                    }
                }
                None => log::error(&format!("system uninstall: no home for uid {uid}; skipping relaunch")),
            },
            _ => log::info("system uninstall: no active graphical session / no service port — skipping relaunch (manual fallback)"),
        }
    }
```
- [ ] **Step 3 — verify:** `cross test … linux_service` (all green) + `cross clippy … -- -D warnings`. Paste both.
- [ ] **Step 4 — commit:** `feat(linux): system-scope uninstall relaunches the active user on the service port (Phase 2)`

---

# PHASE 3 — updates + migration

## Task P3a-1: migration detect + status flag

**Files:** `src/server/api/ServiceApi.ts` (`handleStatus`) + a detect helper + `src/common/ServiceEvents.ts` (status field). Test: `src/server/__tests__/ServiceApi.test.ts`. Run vitest + `npx tsc --noEmit`.

- [ ] **Step 1 — failing test:** a pure `systemServiceNeedsMigration({ dataRootEnv, oldDataDirExists })` returns true when `dataRootEnv === '/opt/ws-scrcpy-web/data'` OR `oldDataDirExists`, else false; and `handleStatus` (linux, system service installed) includes `serviceMigrationNeeded: boolean` from `this.existsCheck('/opt/ws-scrcpy-web/data')`.
- [ ] **Step 2 — run, verify FAIL.**
- [ ] **Step 3 — implement:** export `systemServiceNeedsMigration(input: { dataRootEnv?: string; oldDataDirExists: boolean }): boolean` (`input.dataRootEnv === '/opt/ws-scrcpy-web/data' || input.oldDataDirExists`); add `serviceMigrationNeeded?: boolean` to `ServiceStatusResponse`; in `handleStatus` (linux) set it from `this.existsCheck('/opt/ws-scrcpy-web/data')`.
- [ ] **Step 4 — run PASS + tsc 0.**
- [ ] **Step 5 — commit:** `feat(api): detect legacy /opt/.../data system install (migration flag) (Phase 3)`

## Task P3a-2: reinstall endpoint (uninstall→reinstall, carry config)

**Files:** `src/server/api/ServiceApi.ts` — `POST /api/service/migrate-system` that reads the current service config (webPort, installMode), runs the existing uninstall, then the existing system install carrying those. Test: ServiceApi.test.ts. **READ** `handleUninstall` + `handleInstall` to reuse them (don't duplicate). If the uninstall/install internals aren't cleanly callable, factor the shared core into a private method rather than copy-paste — note it in your report.

- [ ] **Step 1 — failing test:** `POST /api/service/migrate-system` (linux, old layout) triggers uninstall then a system-scope install whose seed carries the prior `webPort` + `installMode`. Use the existing test seams (injected client/existsCheck/pkexec).
- [ ] **Step 2 — run, verify FAIL.**
- [ ] **Step 3 — implement** the route + handler reusing the uninstall + install paths; carry `webPort`/`installMode` (+ audit other persisted service-config keys and carry them too — list what you carried in your report).
- [ ] **Step 4 — run PASS + tsc 0.**
- [ ] **Step 5 — commit:** `feat(api): migrate-system endpoint (uninstall→reinstall at /var/opt) (Phase 3)`

## Task P3b-1: machine-wide-no-service update via pkexec

**Files:** `src/server/UpdateService.ts` — the Linux apply path. **READ** how it currently spawns `--linux-apply` (local vs `--service-restart`). Add a branch: when the install is **machine-wide-no-service** (target AppImage under `/opt/ws-scrcpy-web` AND not root AND no service), instead of the plain swap, run `buildMachineWideInstallScript({ sourceAppImage: <staged>, version: <new> })` via `runPkexec` (reuse the Phase 1 builders), then relaunch `/opt` in the user's context (the existing `linux_apply` relaunch pattern — `systemd-run --user --collect /opt/.../WsScrcpyWeb.AppImage`, NOT under pkexec). Test: `src/server/__tests__/UpdateService.test.ts`. Run vitest + tsc.

- [ ] **Step 1 — failing test:** for a machine-wide `/opt` target (mock/inject the "running from /opt, no service" condition), `applyUpdate` invokes the injected pkexec runner with a script containing `cp "<staged>" "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"` + `bin_t`, and does NOT run the pkexec under which the relaunch happens (relaunch is separate/user-context). Mirror the existing UpdateService apply tests + their injection seams.
- [ ] **Step 2 — run, verify FAIL.**
- [ ] **Step 3 — implement** the branch (detect `/opt` target + no-service → pkexec install-script swap + user-context relaunch). Reuse `buildMachineWideInstallScript` + the exported `runPkexec`. If detecting "running from /opt, no service" needs a new signal, derive it from `process.env.APPIMAGE` starting with `/opt/ws-scrcpy-web/` + the installMode not being a service mode.
- [ ] **Step 4 — run PASS + tsc 0.**
- [ ] **Step 5 — commit:** `feat(server): machine-wide-no-service update via one pkexec swap + user relaunch (Phase 3)`

## Task P3c-1: bootstrapper version-compare

**Files:** `launcher/src/linux_service.rs` — extend `bootstrap_target`; `launcher/src/main.rs` — pass the running version. cross test/clippy.

- [ ] **Step 1 — failing test** (add to `mod tests`):
```rust
#[test]
fn bootstrap_decides_by_version() {
    let opt = "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage";
    // /opt present, /opt newer-or-equal -> exec /opt
    assert_eq!(bootstrap_decision(true, Some("/home/u/App.AppImage"), "0.1.30", Some("0.1.31")), BootstrapAction::ExecOpt(opt.into()));
    assert_eq!(bootstrap_decision(true, Some("/home/u/App.AppImage"), "0.1.31", Some("0.1.31")), BootstrapAction::ExecOpt(opt.into()));
    // /opt present but HOME appimage is NEWER -> run home + offer
    assert_eq!(bootstrap_decision(true, Some("/home/u/App.AppImage"), "0.1.32", Some("0.1.31")), BootstrapAction::RunHomeOfferUpdate);
    // we ARE /opt -> RunHome (normal /opt run)
    assert_eq!(bootstrap_decision(true, Some(opt), "0.1.31", Some("0.1.31")), BootstrapAction::RunHome);
    // no /opt -> RunHome
    assert_eq!(bootstrap_decision(false, Some("/home/u/App.AppImage"), "0.1.31", None), BootstrapAction::RunHome);
    // missing/garbage /opt VERSION -> treat /opt as present-but-unknown -> ExecOpt (don't block)
    assert_eq!(bootstrap_decision(true, Some("/home/u/App.AppImage"), "0.1.31", None), BootstrapAction::ExecOpt(opt.into()));
}
```
- [ ] **Step 2 — run, verify FAIL.**
- [ ] **Step 3 — implement** — add a small semver-ish compare (handle `X.Y.Z-beta.N`: numeric core compare; a `-beta.N` pre-release sorts BEFORE the same core release, and by N among betas) and:
```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BootstrapAction { ExecOpt(PathBuf), RunHomeOfferUpdate, RunHome }

/// `self_version` = the running (home) AppImage's version; `opt_version` = parsed
/// /opt/VERSION (None if absent/unreadable). Pure.
pub fn bootstrap_decision(opt_exists: bool, appimage_env: Option<&str>, self_version: &str, opt_version: Option<&str>) -> BootstrapAction {
    let opt = PathBuf::from("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage");
    let is_self_opt = appimage_env.map(|p| p == opt.to_string_lossy()).unwrap_or(false);
    if !opt_exists || appimage_env.is_none() || is_self_opt { return BootstrapAction::RunHome; }
    match opt_version {
        Some(ov) if version_cmp(self_version, ov) == std::cmp::Ordering::Greater => BootstrapAction::RunHomeOfferUpdate,
        _ => BootstrapAction::ExecOpt(opt),  // /opt >= home, or unknown /opt version -> run /opt
    }
}
```
  Wire `main.rs`: read `/opt/ws-scrcpy-web/VERSION` (if present), pass `env!("CARGO_PKG_VERSION")` as `self_version`; on `ExecOpt(p)` exec it (existing behavior); `RunHome` → continue normal launch; `RunHomeOfferUpdate` → continue normal launch but set an env/marker the frontend reads to offer the /opt update. (Keep `bootstrap_target` as a thin wrapper over `bootstrap_decision` if other call sites use it, or migrate the seam.)
- [ ] **Step 4 — verify** cross test + clippy. Paste.
- [ ] **Step 5 — commit:** `feat(linux): version-aware bootstrapper (offer /opt update when home is newer) (Phase 3)`

## Task P3c-2: frontend offers — migration reinstall + system-wide update

**Files:** `src/app/index.ts` / `src/app/client/SettingsModal.ts`. Wiring (compile + runtime-verified). READ the existing first-run/status-driven UI (the C2/C3 SystemWideInstallModal + status reads) and mirror it.

- [ ] **Step 1 — failing test (the testable slice):** a pure helper `migrationNotice(status: { serviceMigrationNeeded?: boolean })` returns the notice + an action flag when true, nothing when false (mirror `systemServiceInstallGate`). Add the vitest.
- [ ] **Step 2 — run, verify FAIL.**
- [ ] **Step 3 — implement** the helper, then wire: when `serviceMigrationNeeded` → show the notice + [reinstall now] → `POST /api/service/migrate-system` → reload. When the launcher flagged a newer-home version (the P3c-1 marker, surfaced via status) → show "update the system-wide install? [update]" → `POST /api/service/install-system-wide` (reuses B3, which sources `$APPIMAGE` = the newer home one) → reload.
- [ ] **Step 4 — `npm test` (full) green + `npx tsc --noEmit` 0 errors.**
- [ ] **Step 5 — commit:** `feat(ui): migration reinstall notice + system-wide update offer (Phase 3)`

---

## Self-review (against the spec)
- **Phase 2 §:** discovery (P2-1) · relaunch-as-user-with-HOME-on-service-port (P2-2) · `WS_SCRCPY_WEB_PORT` override (P2-3) · run() System wiring + headless fallback (P2-4). ✓ No DISPLAY anywhere. ✓
- **Phase 3 §:** migration detect (P3a-1) + reinstall (P3a-2) · machine-wide-no-service pkexec update (P3b-1) · version-compare bootstrapper (P3c-1) + the two frontend offers (P3c-2). ✓
- **Type consistency:** `active_graphical_uid_from_show`, `system_relaunch_command(systemd_run, uid, home, web_port, appimage)`, `bootstrap_decision(...) -> BootstrapAction`, `systemServiceNeedsMigration`, `WS_SCRCPY_WEB_PORT`, `serviceMigrationNeeded`, `migrate-system` used identically across tasks.
- **Risks (from spec) to verify on Fedora, not unit-coverable:** systemd-run `--uid`+`--setenv=HOME` → `~/.local` dataRoot; the port override forcing the exact free port; semver on `-beta.N`; the migration carry-over completeness.

## Exit criteria — Fedora (runtime, owed before ship)
Per the spec's two "Exit criteria" blocks: system uninstall (same-user + different-admin) → reappears on the same port with a visible wait; headless → manual fallback. Machine-wide-no-service update → one pkexec → relaunch-as-user. Newer home AppImage over older /opt → offered + accepted. beta.40 system install upgrade → migration notice → reinstall at /var/opt, config carried, zero AVC.
