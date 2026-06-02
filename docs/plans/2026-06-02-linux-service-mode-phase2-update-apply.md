# Linux Service-Mode In-App Update Apply (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make in-app updates apply + restart the systemd service in **both** `user-service` and `system-service` modes on Linux, reusing the shipped beta.27 download→verify→swap machinery instead of Velopack's (broken-on-AppImage) apply.

**Architecture:** Today `UpdateService.applyUpdate` early-returns *all* service mode into Velopack (`waitExitThenApplyUpdate`), so Linux service updates silently no-op. Phase 2 narrows that early-return to **win32 only**, so Linux service mode falls through into the existing `platform !== 'win32'` download→verify→stage→`systemd-run`-helper block. Within that block we branch by `installMode`: local mode keeps `--wait-pid` + bare relaunch; service mode hands the launcher helper a new `--service-restart <user|system> --unit <name> [--relabel]` directive. The helper (out-of-cgroup, launched via `systemd-run`) does `systemctl [--user] stop` → settle → `swap_appimage` → (relabel `bin_t` for system) → `systemctl [--user] start`, instead of relaunching a bare process. User scope needs no privilege (user manager, home AppImage); system scope runs as **root** (the service has no `User=`), so it does the privileged `/opt` swap + relabel directly — **no pkexec, headless-capable**.

**Tech Stack:** TypeScript (Node server, vitest) + Rust (`ws-scrcpy-web-launcher`, cargo tests). systemd (`systemctl`, `systemd-run`), SELinux (`restorecon`/`chcon`). Local-Dependencies-Only: all OS tools resolved to absolute paths (`resolveSystemTool` / `linux_service::tool_dir`).

## Status of prerequisites (do NOT re-implement)

- **Phase 1 SHIPPED (beta.32, verified Fedora 44 enforcing):** item 33 (system install stages to `/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage`, labelled `bin_t`), item 32 (out-of-cgroup `--linux-service-teardown` via `systemd-run`). `linux_service.rs` (`Scope`, `teardown_commands`, `tool_dir`, `sbindir_from`, `scope_prefix`) is the model to mirror.
- **#27 local apply SHIPPED (beta.33/35, validated Fedora beta.35→36):** `linux_apply.rs` (`swap_appimage`, `relaunch` via `.status()` under systemd, `under_systemd`, `cleanup_apply_artifacts`) + `systemTools.buildDetachedSpawn`. This is the download→verify→swap machinery Phase 2 reuses.

## Hard constraints (Principle 0 — the regression fence)

- **Windows frozen.** The win32 `applyUpdate` early-return, operation-server path, `handleInstall`/`handleUninstall` Windows branches: byte-for-byte unchanged. The existing vitest test asserting Windows service mode still hits `waitExitThenApplyUpdate` is the guardrail — it MUST stay green.
- **Linux local mode frozen.** `installMode === 'user'` keeps the exact current path (`--linux-apply --staged --target --wait-pid` + bare relaunch). No behavior change.
- **Local-Dependencies-Only.** Every OS tool (`systemctl`, `systemd-run`, `restorecon`, `chcon`) resolved to an absolute path. No bare-name spawns.
- **Full vitest + cargo suites stay green** at every commit.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/server/service/systemTools.ts` | spawn-plan builders | `buildDetachedSpawn` gains an opt to target the **system** manager (omit `--user`) for root system-scope applies. |
| `launcher/src/linux_service.rs` | service lifecycle builders (Phase 1) | Promote `scope_prefix` + `sbindir_from` to `pub(crate)` so `linux_apply` reuses them. No behavior change. |
| `launcher/src/linux_apply.rs` | Linux apply helper | Add `--service-restart <user\|system> --unit <name> [--relabel]`: pure command builders + a `run()` branch that does stop→settle→swap→(relabel)→start instead of bare relaunch. |
| `src/server/UpdateService.ts` | apply orchestration | Narrow the service early-return to win32; branch the Linux block by `installMode` to pass `--service-restart`/target. |
| `launcher/src/main.rs` | dispatch | No change — `linux_apply::handle` already dispatches `--linux-apply`; the new args are parsed inside `run()`. |

---

## Task 1: `buildDetachedSpawn` — system-manager option

System-scope apply runs as root; its `systemd-run` must use the **system** manager (no `--user`). User scope keeps `--user`.

**Files:**
- Modify: `src/server/service/systemTools.ts:47-67`
- Create: `src/server/service/__tests__/systemTools.test.ts` (no test file exists for this module yet)

- [ ] **Step 1: Write the failing test**

Create `src/server/service/__tests__/systemTools.test.ts` (new — this module has no tests yet):

```typescript
import { describe, it, expect } from 'vitest';
import { buildDetachedSpawn } from '../systemTools';

describe('buildDetachedSpawn', () => {
    it('omits --user for the system manager when opts.system is true', () => {
        const plan = buildDetachedSpawn('/h/launcher.exe', ['--x'], { system: true, unit: 'u' },
            (t) => (t === 'systemd-run' ? '/usr/bin/systemd-run' : t));
        expect(plan).toEqual({
            cmd: '/usr/bin/systemd-run',
            args: ['--collect', '--unit=u', '/h/launcher.exe', '--x'],
            viaSystemd: true,
        });
    });

    it('keeps --user for the default (user manager)', () => {
        const plan = buildDetachedSpawn('/h/launcher.exe', ['--x'], { unit: 'u' },
            (t) => (t === 'systemd-run' ? '/usr/bin/systemd-run' : t));
        expect(plan.args).toEqual(['--user', '--collect', '--unit=u', '/h/launcher.exe', '--x']);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- systemTools`
Expected: FAIL — the `system: true` case still emits `--user`.

- [ ] **Step 3: Implement**

In `src/server/service/systemTools.ts`, extend the opts type and the systemd branch:

```typescript
export function buildDetachedSpawn(
    program: string,
    programArgs: string[],
    opts: { unit?: string; system?: boolean } = {},
    resolve: (t: string) => string = (t) => resolveSystemTool(t),
): DetachedSpawnPlan {
    const systemdRun = resolve('systemd-run');
    if (systemdRun.startsWith('/')) {
        const scopeArg = opts.system ? [] : ['--user'];
        const unitArg = opts.unit ? [`--unit=${opts.unit}`] : [];
        return {
            cmd: systemdRun,
            args: [...scopeArg, '--collect', ...unitArg, program, ...programArgs],
            viaSystemd: true,
        };
    }
    const setsid = resolve('setsid');
    if (setsid.startsWith('/')) {
        return { cmd: setsid, args: [program, ...programArgs], viaSystemd: false };
    }
    return { cmd: program, args: programArgs, viaSystemd: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- systemTools`
Expected: PASS (all existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/service/systemTools.ts src/server/service/__tests__/systemTools.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): buildDetachedSpawn system-manager option for root system-scope apply"
```

---

## Task 2: Promote `linux_service` helpers to `pub(crate)`

`linux_apply` will reuse the scope→systemctl-prefix mapping and the bin→sbin derivation. Promote them; no behavior change.

**Files:**
- Modify: `launcher/src/linux_service.rs:18` (`scope_prefix`), `:39` (`sbindir_from`)

- [ ] **Step 1: Promote visibility**

In `launcher/src/linux_service.rs` change `fn scope_prefix` → `pub(crate) fn scope_prefix` and `fn sbindir_from` → `pub(crate) fn sbindir_from`. (Both already have tests in this file; no new test — pure visibility change.)

- [ ] **Step 2: Verify the workspace still compiles + tests pass**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" -p ws-scrcpy-web-launcher`
Expected: PASS (unchanged count). A `dead_code` warning is acceptable here; it disappears once Task 3 consumes them.

- [ ] **Step 3: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/linux_service.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "refactor(launcher): expose scope_prefix/sbindir_from to crate for service-apply reuse"
```

---

## Task 3: `linux_apply` — service-restart command builders + arg parsing

Pure builders (unit-tested) for the service-mode apply sequence. Orchestration is Task 4.

**Files:**
- Modify: `launcher/src/linux_apply.rs` (add builders + tests in the existing `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing tests**

Add to `launcher/src/linux_apply.rs` test module:

```rust
#[test]
fn service_unit_command_user_scope() {
    assert_eq!(
        service_unit_command(linux_service::Scope::User, "stop", "WsScrcpyWeb", "/usr/bin"),
        vec!["/usr/bin/systemctl", "--user", "stop", "WsScrcpyWeb.service"]
    );
    assert_eq!(
        service_unit_command(linux_service::Scope::User, "start", "WsScrcpyWeb", "/usr/bin"),
        vec!["/usr/bin/systemctl", "--user", "start", "WsScrcpyWeb.service"]
    );
}

#[test]
fn service_unit_command_system_scope_has_no_user_flag() {
    assert_eq!(
        service_unit_command(linux_service::Scope::System, "stop", "WsScrcpyWeb", "/usr/bin"),
        vec!["/usr/bin/systemctl", "stop", "WsScrcpyWeb.service"]
    );
}

#[test]
fn relabel_command_prefers_restorecon_then_chcon() {
    // restorecon present -> use it (re-applies the persistent fcontext rule).
    assert_eq!(
        relabel_command(Path::new("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"), "/usr/bin", true),
        vec!["/usr/sbin/restorecon", "-v", "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"]
    );
    // restorecon absent -> chcon -t bin_t fallback (bin dir).
    assert_eq!(
        relabel_command(Path::new("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"), "/usr/bin", false),
        vec!["/usr/bin/chcon", "-t", "bin_t", "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"]
    );
}

#[test]
fn parse_service_restart_reads_scope_unit_relabel() {
    let args: Vec<String> = ["--linux-apply", "--service-restart", "system", "--unit", "WsScrcpyWeb", "--relabel"]
        .iter().map(|s| s.to_string()).collect();
    assert_eq!(parse_service_restart(&args), Some((linux_service::Scope::System, "WsScrcpyWeb".to_string(), true)));

    let user: Vec<String> = ["--linux-apply", "--service-restart", "user", "--unit", "WsScrcpyWeb"]
        .iter().map(|s| s.to_string()).collect();
    assert_eq!(parse_service_restart(&user), Some((linux_service::Scope::User, "WsScrcpyWeb".to_string(), false)));

    // absent -> None (the local-mode path)
    let local: Vec<String> = ["--linux-apply", "--staged", "/a", "--target", "/b"].iter().map(|s| s.to_string()).collect();
    assert_eq!(parse_service_restart(&local), None);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" -p ws-scrcpy-web-launcher service_`
Expected: FAIL to compile — `service_unit_command`, `relabel_command`, `parse_service_restart` not defined.

- [ ] **Step 3: Implement the builders**

Add to `launcher/src/linux_apply.rs` (near `relaunch_command`). Reuse `linux_service::{Scope, scope_prefix, sbindir_from, tool_dir}`:

```rust
use crate::linux_service::{self, Scope};

/// `systemctl [--user] <action> <unit>.service`. Pure — unit-tested.
pub fn service_unit_command(scope: Scope, action: &str, unit: &str, bindir: &str) -> Vec<String> {
    let systemctl = format!("{bindir}/systemctl");
    let pre = linux_service::scope_prefix(scope);
    [vec![systemctl], pre, vec![action.to_string(), format!("{unit}.service")]].concat()
}

/// Re-apply the `bin_t` SELinux label to a system-staged target after swap.
/// `restorecon` (sbin) re-applies the persistent fcontext rule set at install;
/// when absent fall back to `chcon -t bin_t` (bin). `restorecon_present` is the
/// resolved availability (probed by the caller). Pure — unit-tested.
pub fn relabel_command(target: &Path, bindir: &str, restorecon_present: bool) -> Vec<String> {
    let t = target.to_string_lossy().into_owned();
    if restorecon_present {
        let sbindir = linux_service::sbindir_from(bindir);
        vec![format!("{sbindir}/restorecon"), "-v".into(), t]
    } else {
        vec![format!("{bindir}/chcon"), "-t".into(), "bin_t".into(), t]
    }
}

/// Parse `--service-restart <user|system> --unit <name> [--relabel]`. Returns
/// None when `--service-restart` is absent (the local-mode apply path). Pure.
pub fn parse_service_restart(args: &[String]) -> Option<(Scope, String, bool)> {
    let scope = arg_value(args, "--service-restart").and_then(|s| match s {
        "user" => Some(Scope::User),
        "system" => Some(Scope::System),
        _ => None,
    })?;
    let unit = arg_value(args, "--unit")?.to_string();
    let relabel = args.iter().any(|a| a == "--relabel");
    Some((scope, unit, relabel))
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" -p ws-scrcpy-web-launcher service_ ; cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" -p ws-scrcpy-web-launcher parse_service_restart relabel_command`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/linux_apply.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): service-restart command builders for Linux service-mode apply"
```

---

## Task 4: `linux_apply::run()` — service-restart orchestration

Branch `run()`: when `--service-restart` is present, do stop → settle → swap → (relabel) → start, and SKIP the bare relaunch (the unit start brings the app back).

**Files:**
- Modify: `launcher/src/linux_apply.rs:25-64` (`run`)

- [ ] **Step 1: Implement the branch**

Replace the body of `run()` after the `staged`/`target` parsing so the service path diverges before `wait_pid`/`swap`/`relaunch`:

```rust
    // Service-mode apply (Phase 2): the helper stops the unit (synchronous, reaps
    // the in-cgroup app), settles for the FUSE unmount, swaps, relabels (system
    // scope), and starts the unit — no --wait-pid, no bare relaunch. Reached for
    // both user-service (user manager, home $APPIMAGE) and system-service (system
    // manager, root, /opt staged path + bin_t relabel). See the Phase 2 spec.
    if let Some((scope, unit, relabel)) = parse_service_restart(args) {
        return run_service_restart(&staged, &target, scope, &unit, relabel);
    }

    // Local-mode apply (unchanged #27 path): wait for the app pid, swap, relaunch.
    let wait_pid = arg_value(args, "--wait-pid").and_then(|s| s.parse::<u32>().ok());
    log::info(&format!("linux-apply(local): staged={staged:?} target={target:?} wait_pid={wait_pid:?}"));
    if let Some(pid) = wait_pid {
        wait_for_pid_exit(pid, Duration::from_secs(60));
    }
    let code = match swap_appimage(&staged, &target) {
        Ok(()) => { log::info("linux-apply: swap ok, relaunching"); relaunch(&target); 0 }
        Err(e) => { log::error(&format!("linux-apply: swap failed: {e}")); 1 }
    };
    cleanup_apply_artifacts(&staged);
    code
```

Add the orchestrator (a thin exec seam over the Task-3 builders):

```rust
fn run_service_restart(staged: &Path, target: &Path, scope: Scope, unit: &str, relabel: bool) -> i32 {
    let bindir = linux_service::tool_dir("systemctl");
    log::info(&format!("linux-apply(service): scope={scope:?} unit={unit} target={target:?} relabel={relabel}"));

    // 1. Stop the unit (synchronous -> reaps the in-cgroup launcher+Node+children,
    //    unmounts the running AppImage so its file becomes swappable).
    run_cmd(&service_unit_command(scope, "stop", unit, &bindir));

    // 2. Settle: poll until the swap succeeds (FUSE unmount may lag the stop).
    let mut last_err = None;
    let start = Instant::now();
    loop {
        match swap_appimage(staged, target) {
            Ok(()) => break,
            Err(e) => {
                last_err = Some(e);
                if start.elapsed() >= Duration::from_secs(15) {
                    log::error(&format!("linux-apply(service): swap failed after settle: {last_err:?}"));
                    cleanup_apply_artifacts(staged);
                    // Do NOT start into a broken binary; swap_appimage restored the .bak.
                    return 1;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
    }

    // 3. System scope: re-apply the bin_t label so init_t may exec the swapped /opt copy.
    if relabel {
        let restorecon = format!("{}/restorecon", linux_service::sbindir_from(&bindir));
        let present = Path::new(&restorecon).exists();
        run_cmd(&relabel_command(target, &bindir, present));
    }

    // 4. Start the unit on the new version.
    run_cmd(&service_unit_command(scope, "start", unit, &bindir));
    cleanup_apply_artifacts(staged);
    0
}

/// Run one argv vector, logging the outcome (best-effort). Shared by the service path.
fn run_cmd(argv: &[String]) {
    let (cmd, rest) = match argv.split_first() { Some(v) => v, None => return };
    match std::process::Command::new(cmd).args(rest).status() {
        Ok(s) if s.success() => log::info(&format!("linux-apply(service) ok: {}", argv.join(" "))),
        Ok(s) => log::error(&format!("linux-apply(service) non-zero ({:?}): {}", s.code(), argv.join(" "))),
        Err(e) => log::error(&format!("linux-apply(service) spawn failed: {} ({e})", argv.join(" "))),
    }
}
```

- [ ] **Step 2: Verify the suite + clippy**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" -p ws-scrcpy-web-launcher && cargo clippy --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" -p ws-scrcpy-web-launcher --all-targets -- -D warnings`
Expected: PASS, no clippy warnings. (The Task-3 builder tests cover the argv; `run_service_restart`/`run_cmd` are the thin exec seam — runtime-verified on Fedora, see Verification.)

- [ ] **Step 3: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/linux_apply.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(launcher): linux-apply service-restart orchestration (stop/settle/swap/relabel/start)"
```

---

## Task 5: `UpdateService.applyUpdate` — win32-narrow early-return + Linux service branch

**Files:**
- Modify: `src/server/UpdateService.ts:447-450` (early-return), `:499-503` (helper args + spawn scope)
- Test: `src/server/__tests__/UpdateService.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/server/__tests__/UpdateService.test.ts` (follow the file's existing `applyUpdate` setup — injected `fetch`/`fs`/`spawn`, `Config` installMode). Three cases:

```typescript
it('Windows service mode still early-returns to Velopack waitExitThenApplyUpdate (FROZEN)', async () => {
    // platform win32 + installMode user-service -> the Velopack path, NOT a download/spawn.
    const svc = makeServiceForApply({ platform: 'win32', installMode: 'user-service' });
    await svc.applyUpdate();
    expect(mgr.waitExitThenApplyUpdate).toHaveBeenCalledTimes(1);
    expect(spawnSpy).not.toHaveBeenCalled();
});

it('Linux user-service apply downloads, verifies, and systemd-runs the helper with --service-restart user', async () => {
    const svc = makeServiceForApply({ platform: 'linux', installMode: 'user-service', appImage: '/home/u/App.AppImage' });
    await svc.applyUpdate();
    expect(mgr.waitExitThenApplyUpdate).not.toHaveBeenCalled();
    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args).toContain('--service-restart');
    expect(args[args.indexOf('--service-restart') + 1]).toBe('user');
    expect(args).toContain('--unit');
    expect(args[args.indexOf('--unit') + 1]).toBe('WsScrcpyWeb');
    expect(args).toContain('/home/u/App.AppImage'); // target = $APPIMAGE
    expect(args).not.toContain('--relabel');
    expect(args).toContain('--user'); // user-manager systemd-run wrapper
});

it('Linux system-service apply targets /opt, passes --relabel, and uses the system manager (no --user)', async () => {
    const svc = makeServiceForApply({ platform: 'linux', installMode: 'system-service', appImage: '/home/u/App.AppImage' });
    await svc.applyUpdate();
    const args = spawnSpy.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--service-restart') + 1]).toBe('system');
    expect(args).toContain('--target');
    expect(args[args.indexOf('--target') + 1]).toBe('/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage');
    expect(args).toContain('--relabel');
    expect(args).not.toContain('--user'); // system-manager systemd-run wrapper (root)
});
```

> If `makeServiceForApply`/`spawnSpy` helpers don't exist verbatim, adapt to the existing harness in `UpdateService.test.ts` (it already exercises the Linux local apply — reuse its injected `fetch`/`spawn`/`fs` and `Config` mock; add an `installMode` knob).

- [ ] **Step 2: Run to verify it fails**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- UpdateService`
Expected: FAIL — Linux service mode currently early-returns to Velopack (the two Linux cases see no spawn / wrong args).

- [ ] **Step 3: Narrow the early-return**

`src/server/UpdateService.ts:447`:

```typescript
        // Windows service mode keeps Velopack's apply (operation-server handoff,
        // below). Linux service mode falls through to the download-based apply.
        if (isServiceMode && this.platform === 'win32') {
            this.mgr.waitExitThenApplyUpdate(this.state.pendingUpdate, true, false);
            return { redirectPort: null };
        }
```

- [ ] **Step 4: Branch the Linux block by installMode**

In the `if (this.platform !== 'win32')` block, replace the `appImagePath`/`helperArgs`/`plan` section (`:488-503`). Import the unit-name constant at the top of the file: `import { WS_SCRCPY_SERVICE_NAME } from '../common/ServiceEvents';`

```typescript
            const homeAppImage = process.env['APPIMAGE'] ?? '';
            const helperPath = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');

            // installMode selects the apply shape:
            //  - local ('user'): swap $APPIMAGE, wait for our pid, bare relaunch (#27).
            //  - user-service:  stop/swap/start the --user unit; target = home $APPIMAGE.
            //  - system-service: stop/swap/relabel/start the system unit (root); target
            //    = the /opt staged copy; system-manager systemd-run (no --user).
            const STAGED_SYSTEM_TARGET = '/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage';
            let target: string;
            let helperArgs: string[];
            let spawnSystem = false;
            if (installMode === 'system-service') {
                target = STAGED_SYSTEM_TARGET;
                helperArgs = ['--linux-apply', '--staged', stagedPath, '--target', target,
                    '--service-restart', 'system', '--unit', WS_SCRCPY_SERVICE_NAME, '--relabel'];
                spawnSystem = true;
            } else if (installMode === 'user-service') {
                target = homeAppImage;
                helperArgs = ['--linux-apply', '--staged', stagedPath, '--target', target,
                    '--service-restart', 'user', '--unit', WS_SCRCPY_SERVICE_NAME];
            } else {
                target = homeAppImage;
                helperArgs = ['--linux-apply', '--staged', stagedPath, '--target', target,
                    '--wait-pid', String(process.pid)];
            }
            const plan = buildDetachedSpawn(helperPath, helperArgs,
                { unit: `wsscrcpy-apply-${Date.now()}`, system: spawnSystem });
```

The existing `plan.viaSystemd` spawn/await block (`:504-524`) and `return { redirectPort: null }` are unchanged — they already AWAIT `systemd-run` registration (the #27 fix), which is exactly what both service scopes need.

- [ ] **Step 5: Run to verify it passes**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test -- UpdateService`
Expected: PASS (Windows-frozen case + both Linux service cases + the unchanged local case).

- [ ] **Step 6: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/UpdateService.ts src/server/__tests__/UpdateService.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): apply in-app updates in service mode (user + system scope)"
```

---

## Task 6: Regression fence + build

- [ ] **Step 1: Full vitest suite**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run test`
Expected: all green (baseline 810 + new tests). Confirms Windows + Linux-local tests (the freeze fence) still pass.

- [ ] **Step 2: Full cargo suite + clippy**

Run: `cargo test --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" --workspace && cargo clippy --manifest-path "C:/Users/jscha/source/repos/ws-scrcpy-web/Cargo.toml" --workspace --all-targets -- -D warnings`
Expected: PASS, zero warnings.

- [ ] **Step 3: Build**

Run: `npm --prefix "C:/Users/jscha/source/repos/ws-scrcpy-web" run build`
Expected: webpack + build:types succeed.

- [ ] **Step 4: Cut beta via the release:beta PR**

Open the PR with the `release:beta` label (NO manual version bump — auto-release Mode 1 cuts the next beta). Squash-merge only (signed repo). Then run the **Fedora verification** below on the published beta.

---

## Verification (real Fedora — the oracle; cannot be unit-tested)

These are the spec's open-risk runtime checks. Run on the Hyper-V Fedora 44 VM (SELinux enforcing) against the published beta, folded into the full smoke pass:

1. **user-scope update:** install user-service → in-app update beta.N→N+1 → the `--user` unit stops, the home `$APPIMAGE` swaps, the unit restarts on the same web port, the browser reconnects via the `UpgradingOverlay` (`mode:'reconnect'`). No prompt.
2. **system-scope update (headless, the open risk):** install system-service → in-app update → **no pkexec prompt** (root self-update) → `/opt` copy swaps, `restorecon` re-applies `bin_t`, the unit restarts, no AVC. **If SELinux blocks `init_t`/the transient unit writing `/opt` or relabeling:** ship a *narrow, targeted* policy for this path only — NEVER broad `audit2allow`.
3. **out-of-cgroup survival:** confirm the `systemd-run` apply helper survives `systemctl stop` of the service unit (the unit it is restarting) — the same property proven for the #27 local apply and the item-32 teardown.
4. **settle timing:** confirm the FUSE unmount settles within the 15s swap-retry window on the VM; widen if needed.

---

## Self-Review

**Spec coverage:**
- Phase 2A (user-scope) → Tasks 1, 3, 4, 5. ✓
- Phase 2B (system-scope: /opt target, relabel, root/system-manager, no pkexec) → Tasks 1 (system spawn), 3 (relabel_command), 4 (relabel in run), 5 (target + --relabel + system spawn). ✓
- Narrow early-return to win32 → Task 5 Step 3. ✓
- Reuse download→verify→stage → Task 5 (unchanged machinery above the branch). ✓
- Reuse out-of-cgroup `systemd-run` survival → Task 1 + the unchanged await-registration block. ✓
- Local-Dependencies-Only (absolute tool paths) → `service_unit_command`/`relabel_command` use `bindir`/`sbindir` from `tool_dir`/`sbindir_from`; `resolveSystemTool` for systemd-run. ✓
- Error handling: swap-fail restores `.bak` and does NOT start a broken binary (Task 4 Step 1, the settle loop returns 1 without start). ✓
- Windows frozen / Linux-local frozen → explicit freeze test (Task 5) + the unchanged local branch. ✓
- Phase 1 (items 32/33) and #27 → prerequisites, not re-implemented. ✓

**Placeholder scan:** every code step has complete code; test steps have concrete assertions; commands are exact. The one acknowledged gap — `run_service_restart`/`run_cmd` exec orchestration — is explicitly runtime-verified on Fedora (the spec calls it an oracle-only check), with the argv builders fully unit-tested. ✓

**Type/name consistency:** `service_unit_command(scope, action, unit, bindir)`, `relabel_command(target, bindir, restorecon_present)`, `parse_service_restart → (Scope, String, bool)`, `buildDetachedSpawn(_, _, {unit, system}, _)`, `WS_SCRCPY_SERVICE_NAME = 'WsScrcpyWeb'`, system target `/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage` — used identically across tasks. ✓
