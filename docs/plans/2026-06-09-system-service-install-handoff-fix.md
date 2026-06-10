# System-Service Install Handoff Fix (beta.57) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Linux **system-scope** service install actually serve the app, instead of self-deferring during the install handoff and dying ("service is running but port discovery timed out").

**Architecture:** Two coordinated changes. **(A)** the Rust launcher must never run its "defer to an active system service" path when it *is* the service — gate it on `WS_SCRCPY_SERVICE=1` (which systemd's `ExecStart` already sets). **(B1)** the system-scope install must stop using `systemctl enable --now` (which starts the service while the outgoing local instance still holds the web port) and instead mirror the proven **user-scope F4** pattern: `enable` only, then spawn a **rootful, out-of-cgroup handoff helper** that waits for the local instance to release the port, then starts + verifies the service. The launcher's handoff helper (`run_install_handoff`) is already fully scope-generic (`Scope::System` works), so B1 is almost entirely Node-side (the pkexec script + ServiceApi).

**Tech Stack:** Rust (launcher, `cross test` for the `#[cfg(target_os="linux")]` modules), TypeScript/Node (server, vitest), systemd/pkexec/systemd-run.

**Root-cause evidence:** `docs/smoke-tests` capture bundle `20260609-215133-4.5.tar.gz`; `71-system-launcher.log` = `service-defer: active system service; opening http://localhost:8003`; `23-status-system.txt` = inactive(dead), 120 ms, exit 0/SUCCESS; `10-avc.txt` = no denials. Full trail in `todo_ws_scrcpy_web` task #14.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `launcher/src/linux_service.rs` | service-defer decision (pure) | **(A)** `service_defer_url` gains `running_as_service: bool` → `None` when true. Update tests. |
| `launcher/src/main.rs` | launcher entry / defer block | **(A)** read `WS_SCRCPY_SERVICE`, pass into `service_defer_url`. |
| `src/server/service/SystemdClient.ts` | systemd install scripts | **(B1)** `buildSystemInstallScript`: `enable --now` → `enable` + spawn rootful handoff via `systemd-run`; add `handoffUnit` arg. `install()`: pass `handoffUnit`; root-direct system path → `enable` + spawn handoff. |
| `src/server/api/ServiceApi.ts` | install-flow orchestration | **(B1)** add linux-`system` "shutting-down" branch (mirror user-scope); make the in-handler verify/rollback/15 s-exit **win32-only**. |
| `CHANGELOG.md` | release notes | beta.57 Fixed entry. |

**Reference (do NOT modify — this is the working pattern B1 mirrors):**
- `launcher/src/linux_service.rs:434` `run_install_handoff` — already does wait-for-release → `start_command(scope,…)` → `verify_up` → teardown/relaunch. Scope-generic; `start_command_user_and_system` test already passes for `Scope::System`.
- `src/server/api/ServiceApi.ts:518-544` — the user-scope handoff branch (the contract to mirror: spawn helper / `scheduleExit(1500)` / return `status:'shutting-down'`).

---

## Task 1: (A) Launcher never self-defers when it is the service

**Files:**
- Modify: `launcher/src/linux_service.rs:202-206` (`service_defer_url`) + the test at `:596-602`
- Modify: `launcher/src/main.rs:148-165` (defer block)

- [ ] **Step 1: Update the failing test** in `launcher/src/linux_service.rs` (replace the existing `defer_to_service_only_when_system_service_and_port_live` test, add a self-service case)

```rust
    #[test]
    fn defer_to_service_only_when_system_service_and_port_live() {
        // running_as_service = false: a plain local/home launch may defer to a live system service.
        assert_eq!(service_defer_url(Some("system-service"), Some(8000), true, false),
                   Some("http://localhost:8000".to_string()));
        assert_eq!(service_defer_url(Some("system-service"), Some(8000), false, false), None); // installed but down
        assert_eq!(service_defer_url(Some("user"), Some(8000), true, false), None);            // not service mode
        assert_eq!(service_defer_url(None, None, true, false), None);
    }

    #[test]
    fn never_defers_when_running_as_the_service() {
        // WS_SCRCPY_SERVICE=1 → this process IS the system service; it must start its
        // server, never defer to a "live" port (which, during the install handoff, is
        // just the outgoing local instance). beta.56 self-defer regression guard.
        assert_eq!(service_defer_url(Some("system-service"), Some(8000), true, true), None);
    }
```

- [ ] **Step 2: Run the test, verify it fails to compile** (signature mismatch — 3 args vs 4)

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cross test service_defer`
Expected: FAIL — `this function takes 4 arguments but 3 arguments were supplied` (call sites) / arity error.

- [ ] **Step 3: Implement the guard** in `launcher/src/linux_service.rs` (replace `service_defer_url`)

```rust
/// The service URL to open (then exit) when an ACTIVE system service owns the
/// app, so a local launch doesn't spawn a duplicate. `install_mode` + `web_port`
/// come from the /var/opt system-service config; `port_live` is a TCP-probe
/// result the caller supplies. `running_as_service` is true when THIS process is
/// the systemd service itself (ExecStart sets WS_SCRCPY_SERVICE=1) — in which case
/// it must NEVER defer (it would defer to the outgoing local instance during the
/// install handoff and exit, leaving nothing serving — the beta.56 self-defer). Pure.
pub fn service_defer_url(
    install_mode: Option<&str>,
    web_port: Option<u16>,
    port_live: bool,
    running_as_service: bool,
) -> Option<String> {
    if running_as_service {
        return None;
    }
    match (install_mode, web_port) {
        (Some("system-service"), Some(port)) if port_live => Some(format!("http://localhost:{port}")),
        _ => None,
    }
}
```

- [ ] **Step 4: Update the call site** in `launcher/src/main.rs` (the `#[cfg(target_os = "linux")]` defer block at ~148-165)

```rust
    // Service-defer: if an ACTIVE system-scope service owns the app, open the
    // browser at its URL and exit instead of spawning a duplicate local server.
    // GUARD: never defer when WE ARE the service (systemd ExecStart sets
    // WS_SCRCPY_SERVICE=1) — otherwise, during the system-scope install handoff,
    // the outgoing local instance still holds the port and we'd defer to it, then
    // exit, leaving nothing serving (beta.56 self-defer).
    #[cfg(target_os = "linux")]
    {
        let running_as_service = std::env::var("WS_SCRCPY_SERVICE").as_deref() == Ok("1");
        let cfg = common::config::AppConfig::load(std::path::Path::new("/var/opt/ws-scrcpy-web"));
        if let (Some(mode), Some(port)) = (cfg.install_mode.as_deref(), cfg.web_port) {
            let live = std::net::TcpStream::connect_timeout(
                &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
                std::time::Duration::from_millis(200),
            ).is_ok();
            if let Some(url) = linux_service::service_defer_url(Some(mode), Some(port), live, running_as_service) {
                log::info(&format!("service-defer: active system service; opening {url}"));
                let xdg = format!("{}/xdg-open", linux_service::tool_dir("xdg-open"));
                let _ = std::process::Command::new(&xdg).arg(&url).status();
                std::process::exit(0);
            }
        }
    }
```

- [ ] **Step 5: Run tests + clippy, verify pass**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cross test service_defer && cross clippy -- -D warnings`
Expected: PASS (both tests green, clippy clean).

- [ ] **Step 6: Commit**

```bash
git -C C:/Users/jscha/source/repos/ws-scrcpy-web add launcher/src/linux_service.rs launcher/src/main.rs
git -C C:/Users/jscha/source/repos/ws-scrcpy-web commit -m "fix(linux): launcher never self-defers when it is the system service (A)"
```

---

## Task 2: (B1) System install script — enable-only + spawn rootful handoff

**Files:**
- Modify: `src/server/service/SystemdClient.ts` — `buildSystemInstallScript` (args + the `enable --now` line at ~357-361)
- Test: the existing `buildSystemInstallScript` test in `src/server/service/SystemdClient.test.ts` (read it first to slot assertions)

- [ ] **Step 1: Write/extend the failing test** — assert the script `enable`s (not `--now`) and spawns the system handoff. Add to the `buildSystemInstallScript` describe block:

```ts
it('enables (not --now) and spawns a rootful system handoff helper', () => {
    const script = buildSystemInstallScript(
        { unitTmpPath: '/tmp/u', unitPath: '/etc/systemd/system/WsScrcpyWeb.service',
          name: 'WsScrcpyWeb', handoffUnit: 'wsscrcpy-install-123' },
        (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`,
    );
    // never start under the local instance's live port:
    expect(script).not.toContain('enable --now');
    expect(script).toContain('/usr/bin/systemctl enable WsScrcpyWeb.service');
    // rootful, out-of-cgroup handoff that waits for the port then starts + verifies:
    expect(script).toContain(
        "/usr/bin/systemd-run --collect --unit=wsscrcpy-install-123 --setenv=DATA_ROOT=/var/opt/ws-scrcpy-web " +
        '"/opt/ws-scrcpy-web/ws-scrcpy-web-launcher.exe" --linux-service-install-handoff --scope system --unit WsScrcpyWeb'
    );
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx vitest run src/server/service/SystemdClient.test.ts -t "rootful system handoff"`
Expected: FAIL — `handoffUnit` not in the args type (tsc) / assertions unmet (`enable --now` still present, no `systemd-run`).

- [ ] **Step 3: Implement** in `src/server/service/SystemdClient.ts` — add `handoffUnit` to the args, resolve `systemd-run`, replace the final `enable --now` step:

Add to the `args` object type (after `name: string;`):
```ts
        /** Transient unit name for the rootful install-handoff (e.g. `wsscrcpy-install-<ts>`). */
        handoffUnit: string;
```
Add the tool resolution alongside the others (after `const restorecon = ...`):
```ts
    const systemdRun = binTool('systemd-run');
```
Replace the final `steps.push(...)` tail (the `// 3. install + enable` block) with:
```ts
    steps.push(
        // 2. label bin_t / var_lib_t (best-effort subshell — see above).
        `( ( ${semanage} fcontext -a -t bin_t '${STAGED_SYSTEM_DIR}(/.*)?' && ${semanage} fcontext -a -t var_lib_t '${SYSTEM_STATE_DIR}(/.*)?' && ${restorecon} -Rv "${STAGED_SYSTEM_DIR}" && ${restorecon} -Rv "${SYSTEM_STATE_DIR}" ) || ${chcon} -t bin_t "${staged}" || true )`,
        // 3. install the unit (ExecStart already points at ${staged}).
        `${cp} "${args.unitTmpPath}" "${args.unitPath}"`,
        `${systemctl} daemon-reload`,
        // 4. enable (persist) but DO NOT --now. The local instance that triggered
        //    this install still holds the web port; starting now makes the freshly
        //    forked service probe the live port and self-defer (beta.56), or
        //    EADDRINUSE-loop into StartLimitBurst before the local exits. Instead
        //    spawn a rootful, out-of-cgroup handoff (transient SYSTEM unit, survives
        //    this pkexec via --collect) that waits for the local instance to release
        //    the port, then starts + verifies the service. Mirror of user-scope F4
        //    (ServiceApi spawns the --user handoff there; here it must be rootful, so
        //    it rides inside the pkexec block). DATA_ROOT lets the helper read the
        //    service's web port from /var/opt config (else it defaults to 8000).
        `${systemctl} enable ${args.name}.service`,
        `${systemdRun} --collect --unit=${args.handoffUnit} --setenv=DATA_ROOT=${SYSTEM_STATE_DIR} "${stagedHelper}" --linux-service-install-handoff --scope system --unit ${args.name}`,
    );
    return steps.join(' && ');
```

- [ ] **Step 4: Run the test + tsc, verify pass**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx vitest run src/server/service/SystemdClient.test.ts && npx tsc --noEmit`
Expected: PASS (assertions met, tsc clean).

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/jscha/source/repos/ws-scrcpy-web add src/server/service/SystemdClient.ts src/server/service/SystemdClient.test.ts
git -C C:/Users/jscha/source/repos/ws-scrcpy-web commit -m "fix(linux): system install enables-only + spawns rootful handoff (B1)"
```

---

## Task 3: (B1) `install()` — pass handoffUnit; root-direct system path enables-only + spawns handoff

**Files:**
- Modify: `src/server/service/SystemdClient.ts` — `install()` system pkexec branch (~712-719) + the root-direct `else` branch (~727-750)
- Test: `src/server/service/SystemdClient.test.ts` (or the install integration test) — assert the root-direct system path enables-only

- [ ] **Step 1: Write the failing test** — root-direct (getuid===0) system install must NOT `enable --now`. (Mock `process.getuid` → 0 and a `runSystemctl` spy; assert no `--now` and an `enable` call. Slot into the existing install describe; adapt to the file's existing mock style.)

```ts
it('root-direct system install enables-only (no --now) and defers start to the handoff', async () => {
    const calls: string[][] = [];
    // ... construct SystemdClient with runSystemctl spy pushing args to `calls`,
    //     getuid → 0, systemd-run resolution stubbed ...
    await client.install({ name: 'WsScrcpyWeb', scope: 'system', /* …min opts… */ } as any);
    expect(calls.some((a) => a.includes('--now'))).toBe(false);
    expect(calls.some((a) => a[0] === 'enable' && a[1] === 'WsScrcpyWeb.service')).toBe(true);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx vitest run src/server/service/SystemdClient.test.ts -t "root-direct system"`
Expected: FAIL — current root-direct path runs `enable --now`.

- [ ] **Step 3a: Implement** — pass `handoffUnit` into the pkexec script call (`install()` ~712):

```ts
                const cmd = buildSystemInstallScript({
                    ...(opts.linuxHelperSource ? { sourceHelper: opts.linuxHelperSource } : {}),
                    ...(opts.sourceDeps ? { sourceDeps: opts.sourceDeps } : {}),
                    ...(seedTmpFile ? { seedConfigTmpPath: seedTmpFile } : {}),
                    unitTmpPath: tmpFile,
                    unitPath,
                    name: opts.name,
                    handoffUnit: `wsscrcpy-install-${Date.now()}`,
                });
```

- [ ] **Step 3b: Implement** — the root-direct `else` branch (~739-749). Replace the `if (scope === 'user') {…} else {…}` enable block with enable-only for both, plus a rootful handoff spawn for system:

```ts
            // F4 (user) + B1 (system): never `--now` while the local instance holds
            // the per-user lock / web port — the service would exit "already running"
            // or EADDRINUSE-loop. Just enable (persist); the handoff helper starts it
            // after the local instance exits.
            runSystemctl(
                [...baseArgs, 'enable', `${opts.name}.service`],
                `enable ${opts.name}.service`,
            );
            if (scope === 'system') {
                // Already root (rare): spawn the rootful handoff directly. systemd-run
                // --collect registers a transient SYSTEM unit and returns immediately
                // (fire-and-forget), so execFileSync is fine. The non-root path spawns
                // this from inside the pkexec script instead (buildSystemInstallScript).
                const stagedHelper = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_HELPER}`;
                try {
                    execFileSync(
                        resolveSystemTool('systemd-run'),
                        ['--collect', `--unit=wsscrcpy-install-${Date.now()}`,
                         `--setenv=DATA_ROOT=${SYSTEM_STATE_DIR}`,
                         stagedHelper, '--linux-service-install-handoff', '--scope', 'system', '--unit', opts.name],
                        { stdio: ['ignore', 'pipe', 'pipe'] },
                    );
                } catch (err) {
                    log.warn(`root-direct system handoff spawn failed: ${(err as Error).message}`);
                }
            }
```

- [ ] **Step 4: Run tests + tsc, verify pass**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx vitest run src/server/service/SystemdClient.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/jscha/source/repos/ws-scrcpy-web add src/server/service/SystemdClient.ts src/server/service/SystemdClient.test.ts
git -C C:/Users/jscha/source/repos/ws-scrcpy-web commit -m "fix(linux): pass handoffUnit; root-direct system enables-only + spawns handoff (B1)"
```

---

## Task 4: (B1) ServiceApi — linux-system "shutting-down" branch; verify/rollback becomes win32-only

**Files:**
- Modify: `src/server/api/ServiceApi.ts` — add a `scope === 'system'` linux branch after the user branch (~544); narrow the 15 s-exit condition (~590) to win32
- Test: `src/server/api/ServiceApi.test.ts` (the install-flow tests) — assert linux-system returns `status:'shutting-down'` + schedules an exit and does NOT run the in-handler verify

- [ ] **Step 1: Write the failing test** (slot into the install-flow describe; mirror the existing user-scope shutting-down test):

```ts
it('linux system-scope install hands off (shutting-down) without in-handler verify', async () => {
    // platform 'linux', scope 'system', install() resolves OK, verifyServiceActive is a spy.
    const verify = vi.fn();
    // ... wire api with platform=linux, client.install → resolve, verifyServiceActive=verify,
    //     scheduleExit captured ...
    const res = await postInstall({ scope: 'system' });
    expect(res.body).toMatchObject({ ok: true, status: 'shutting-down', installMode: 'system-service' });
    expect(verify).not.toHaveBeenCalled();          // the handoff helper owns verify/rollback now
    expect(scheduledExitMs).toBe(1500);
});
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx vitest run src/server/api/ServiceApi.test.ts -t "system-scope install hands off"`
Expected: FAIL — current system path calls `verifyServiceActive` and returns `status` from `client.status`, not `shutting-down`.

- [ ] **Step 3: Implement** — insert immediately AFTER the user-scope branch closes (the `}` at ~544, before the F3 verify comment at ~546):

```ts
        // B1: Linux SYSTEM scope mirrors user-scope F4. The install enabled the unit
        // (not --now) and spawned a rootful, out-of-cgroup handoff helper (transient
        // system unit — from inside the pkexec script, or directly when already root)
        // that waits for THIS local instance to release the web port, then starts +
        // verifies the service and rolls back on failure. So we just exit promptly to
        // free the port; the helper owns verify/rollback (no in-handler verify here —
        // that path is now win32-only). Without this, `enable --now` started the
        // service while we still held the port → self-defer / EADDRINUSE (beta.56).
        if (result.platform === 'linux' && scope === 'system') {
            log.info('install-flow(linux system): handoff helper spawned by installer; exiting local to free the port');
            this.scheduleExit(() => {
                log.info('install-flow: local instance exiting (handoff to system service)');
                process.exit(0);
            }, 1_500);
            const disk = this.readDiskConfig();
            const body: ServiceActionSuccess = {
                ok: true,
                status: 'shutting-down',
                installMode: newInstallMode,
                ...(disk.configMtime != null ? { configMtime: disk.configMtime } : {}),
                ...(disk.diskWebPort != null ? { diskWebPort: disk.diskWebPort } : {}),
            };
            res.writeHead(200);
            res.end(JSON.stringify(body));
            return true;
        }
```

- [ ] **Step 3b: Narrow the trailing exit to win32** — update the comment + condition at ~586-595 (linux no longer reaches here; both linux scopes return above):

```ts
        // Schedule local-Node exit (win32 only — both Linux scopes hand off + return
        // above). This instance is useless once the service is running; it also holds
        // the web port. The frontend navigates to the service port once it detects
        // config.json mtime change — this timer is a safety cap, not a timing mechanism.
        if (result.platform === 'win32') {
            this.scheduleExit(() => {
                log.info('install-flow: local instance exiting (service is running)');
                process.exit(0);
            }, 15_000);
        }
```

- [ ] **Step 4: Run tests + tsc, verify pass**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx vitest run src/server/api/ServiceApi.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/jscha/source/repos/ws-scrcpy-web add src/server/api/ServiceApi.ts src/server/api/ServiceApi.test.ts
git -C C:/Users/jscha/source/repos/ws-scrcpy-web commit -m "fix(linux): system-scope install hands off like user-scope; verify now win32-only (B1)"
```

---

## Task 5: Full gate verification

**Files:** none (verification only)

- [ ] **Step 1: Node gates**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web && npx tsc --noEmit && npx vitest run && npm run build`
Expected: tsc 0 errors; full vitest green; webpack build 0 errors.

- [ ] **Step 2: Rust gates**

Run: `cd C:/Users/jscha/source/repos/ws-scrcpy-web/launcher && cross test && cross clippy -- -D warnings`
Expected: all launcher tests green; clippy clean. (Windows leg: `cargo test`/`cargo clippy` for the non-linux modules.)

- [ ] **Step 3: Record counts** — note the resulting vitest count + launcher test count for the breadcrumb/CHANGELOG (remeasure at HEAD, do not assume).

---

## Task 6: CHANGELOG + release prep (beta.57)

**Files:** `CHANGELOG.md`

- [ ] **Step 1: Add the beta.57 entry** under a new version heading (Keep a Changelog format):

```markdown
### Fixed
- **Linux system-scope service install now serves the app.** Installing the system
  service started it via `systemctl enable --now` while the outgoing local instance
  still held the web port, so the freshly forked service probed the live port and
  self-deferred (opened the URL and exit 0) — the service never bound, and the
  install poll reported "service is running but port discovery timed out." System
  scope now mirrors user-scope: `enable` only, then a rootful out-of-cgroup handoff
  helper waits for the local instance to release the port and starts + verifies the
  service. The launcher additionally never self-defers when `WS_SCRCPY_SERVICE=1`.
```

- [ ] **Step 2: Commit**

```bash
git -C C:/Users/jscha/source/repos/ws-scrcpy-web add CHANGELOG.md
git -C C:/Users/jscha/source/repos/ws-scrcpy-web commit -m "docs(changelog): system-service install handoff fix (beta.57)"
```

- [ ] **Step 3: Release** — open a `release:beta` PR per the auto-release convention (Mode 1 cuts the version-bump PR; do NOT manually bump). After merge + CI publish (MSI + AppImage + feeds), the beta.57 AppImage is ready for the #9 system-scope re-smoke. See `reference_wsscrcpy_version_bump` + `master_github_releases`.

---

## Known follow-up / risks (track, don't silently drop)

1. **System-scope rollback relaunch.** `run_install_handoff`'s failure path (`linux_service.rs:475-487`) relaunches the local app via `systemd-run --user`, which won't work from the **root** system-handoff context (root has no `--user` manager session). On a *failed* system install the teardown still runs, but the local app won't auto-relaunch → the user must relaunch manually. Verify `relaunch_target(Scope::System, …)`; if it doesn't already route through the `loginctl` active-graphical-uid discovery (`discover_active_graphical_uid`, same file), wire a `systemd-run --uid=<uid>` relaunch like the uninstall path. Happy-path-independent; address in this PR if small, else a tracked follow-up.
2. **Handoff `wait_port` window.** The helper waits up to 20 s for the port to free and the local instance exits at 1.5 s, so there's ample margin — but confirm on the re-smoke that `verify_up` (12 s) sees the service bind. Watch for `install-handoff: port still held after 20s; starting anyway` in `service.log`.
3. **`servedByService` handoff signal (secondary, beta.48 parity).** The local instance's pre-exit "service is running" detection was historically port-only; with B1 the local exits on a timer (not on a false port probe), so this is moot for the fix — but if any residual flakiness appears, gate that check on `servedByService` too.

---

## Self-Review

- **Spec coverage:** (A) Task 1 ✓; (B1) enable-only Tasks 2+3 ✓, rootful handoff Tasks 2 (pkexec) + 3 (root-direct) ✓, ServiceApi mirror Task 4 ✓; gates Task 5 ✓; release Task 6 ✓.
- **Type consistency:** `handoffUnit` added to `buildSystemInstallScript` args (Task 2) and supplied at both call sites (Task 3); `service_defer_url` 4-arg signature updated at its one call site (Task 1); `ServiceActionSuccess` shape reused verbatim from the user-scope branch (Task 4).
- **No placeholders:** all source steps carry exact code; test steps carry concrete assertions (slot into existing describes — read the test file's mock style first).
