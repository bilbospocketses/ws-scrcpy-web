# Machine-wide `/opt` Install — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the machine-wide Linux layout — `/opt/ws-scrcpy-web` (binary, `bin_t`) ÷ `/var/opt/ws-scrcpy-web` (system-service state, `var_lib_t`) ÷ `~/.local/share/WsScrcpyWeb` (per-user) — plus the auto-first-launch bootstrapper, the machine-wide binary install, and the service-install gating.

**Architecture:** Extend the existing beta.40 builders (`SystemdClient.ts`) and the launcher teardown (`linux_service.rs`), following their pure-function-+-unit-test pattern. The system-service install retargets its state from `/opt/ws-scrcpy-web/data` to the FHS-correct `/var/opt/ws-scrcpy-web`; the launcher gains a bootstrapper that execs the shared `/opt` binary when present; a new machine-wide-install operation (pkexec) stages just the binary; the frontend gates system-scope service install behind machine-wide install.

**Tech Stack:** TypeScript (Node server, vitest) · Rust (`ws-scrcpy-web-launcher`, `cross test --target x86_64-unknown-linux-gnu`) · systemd / SELinux (`semanage`/`restorecon`, Fedora enforcing) · pkexec/polkit.

**Design spec:** `docs/specs/2026-06-05-machine-wide-opt-install-design.md`.

**Phasing:** Phase 1 = Foundation (this doc). Phase 2 = `loginctl` uninstall→relaunch. Phase 3 = updates + migration. Version-compare / update-offer in the bootstrapper is **Phase 3** — out of scope here.

---

## File structure

**Modify:**
- `src/server/service/SystemdClient.ts` — retarget system state → `/var/opt`; add `buildMachineWideInstallScript` (binary-only); `.desktop` + VERSION emit.
- `src/server/service/SystemdClient.test.ts` — update + add builder tests.
- `launcher/src/linux_service.rs` — teardown removes **both** `/opt` (`bin_t`) and `/var/opt` (`var_lib_t`) rules + both trees (folds fix (a)); new `bootstrap_target` pure fn.
- `launcher/src/main.rs` — wire the bootstrapper exec seam (Linux, normal-launch path).
- `src/server/api/ServiceApi.ts` — `install-system-wide` + `decline-system-wide` endpoints; machine-wide-install gate on system-scope service install.
- `src/app/client/SettingsModal.ts` — `systemServiceInstallGate` pure fn + render wiring.
- `src/app/client/__tests__/SettingsModal.test.ts` — gate test.

**Create:**
- `src/app/client/SystemWideInstallModal.ts` — first-run "install system-wide?" modal (mirrors `WelcomeModal.ts`).
- `src/app/client/__tests__/SystemWideInstallModal.test.ts`.

**Constants introduced (in `SystemdClient.ts`):**
```ts
export const SYSTEM_STATE_DIR = '/var/opt/ws-scrcpy-web';   // replaces STAGED_SYSTEM_DATA_DIR's role
export const SYSTEM_OPT_VERSION_FILE = `${STAGED_SYSTEM_DIR}/VERSION`;
export const SYSTEM_DESKTOP_FILE = '/usr/share/applications/ws-scrcpy-web.desktop';
export const DECLINE_MARKER_NAME = 'system-install-declined'; // under <dataRoot>/control/
```

---

## Build / test commands

- **TS unit:** `npm test -- src/server/service/SystemdClient.test.ts` (vitest; `npm test` for the full suite).
- **Rust unit (cfg-gated Linux modules need cross):** from the repo root —
  `cross test -p ws-scrcpy-web-launcher --target x86_64-unknown-linux-gnu <filter>` (Docker Desktop must be running).
- **Rust lint:** `cross clippy -p ws-scrcpy-web-launcher --target x86_64-unknown-linux-gnu -- -D warnings`.
- **Frontend unit:** `npm test -- src/app/client/__tests__/SettingsModal.test.ts`.

> Multi-session git discipline: all git ops use `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web"`. Work on branch `path2-machine-wide-install` (already created; the design spec is committed there).

---

## Group A — `/var/opt` layout retarget + SELinux teardown (folds fix (a))

### Task A1: Retarget system-service state to `/var/opt`

**Files:**
- Modify: `src/server/service/SystemdClient.ts` (constants ~70-92; `buildServiceUnitEnv` 101-110; `buildSystemInstallScript` 271-339)
- Test: `src/server/service/SystemdClient.test.ts`

- [ ] **Step 1: Write the failing tests** — add to `SystemdClient.test.ts`:

```ts
import { buildServiceUnitEnv, buildSystemInstallScript, SYSTEM_STATE_DIR } from '../SystemdClient';

it('system-scope unit env points DATA_ROOT at /var/opt (not /opt/.../data)', () => {
    const env = buildServiceUnitEnv('linux', 'system', '/home/u/.local/share/WsScrcpyWeb/dependencies');
    expect(env.DATA_ROOT).toBe('/var/opt/ws-scrcpy-web');
    expect(env.DEPS_PATH).toBe('/opt/ws-scrcpy-web/dependencies');
});

it('system install seeds config + labels state under /var/opt (var_lib_t)', () => {
    const script = buildSystemInstallScript(
        { sourceAppImage: '/home/u/App.AppImage', seedConfigTmpPath: '/tmp/seed.json',
          unitTmpPath: '/tmp/u.service', unitPath: '/etc/systemd/system/WsScrcpyWeb.service', name: 'WsScrcpyWeb' },
        (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`,
    );
    expect(script).toContain('mkdir -p /var/opt/ws-scrcpy-web');
    expect(script).toContain('cp "/tmp/seed.json" "/var/opt/ws-scrcpy-web/config.json"');
    expect(script).toContain("semanage fcontext -a -t var_lib_t '/var/opt/ws-scrcpy-web(/.*)?'");
    expect(script).toContain('restorecon -Rv "/var/opt/ws-scrcpy-web"');
    // state no longer lives under /opt/.../data:
    expect(script).not.toContain('/opt/ws-scrcpy-web/data');
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npm test -- src/server/service/SystemdClient.test.ts`
Expected: FAIL — `DATA_ROOT` is still `/opt/ws-scrcpy-web/data`; the `/var/opt` strings are absent.

- [ ] **Step 3: Implement** — in `SystemdClient.ts`:
  - Add `export const SYSTEM_STATE_DIR = '/var/opt/ws-scrcpy-web';` near the other staged constants (keep `STAGED_SYSTEM_DEPS_DIR` = `/opt/.../dependencies`; deps stay in `/opt` per the deps-follow-run-context decision). Remove `STAGED_SYSTEM_DATA_DIR` (replaced by `SYSTEM_STATE_DIR`).
  - `buildServiceUnitEnv` system branch → `{ DATA_ROOT: SYSTEM_STATE_DIR, DEPS_PATH: STAGED_SYSTEM_DEPS_DIR }`.
  - `buildSystemInstallScript`: change the data-dir `mkdir`/seed-config target from `STAGED_SYSTEM_DATA_DIR` → `SYSTEM_STATE_DIR`; in the SELinux step replace the `var_lib_t '${STAGED_SYSTEM_DATA_DIR}(/.*)?'` rule with `var_lib_t '${SYSTEM_STATE_DIR}(/.*)?'`, and add `&& ${restorecon} -Rv "${SYSTEM_STATE_DIR}"` after the `/opt` restorecon (the `/var/opt` tree is outside `/opt`, so the existing `restorecon -Rv /opt/...` does not cover it). Keep `mkdir -p ${SYSTEM_STATE_DIR}` before the seed `cp`.

- [ ] **Step 4: Run, verify pass**

Run: `npm test -- src/server/service/SystemdClient.test.ts`
Expected: PASS (all builder tests, including the existing `bin_t`/restorecon assertions retargeted as needed).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/service/SystemdClient.ts src/server/service/SystemdClient.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): retarget system-service state to /var/opt (FHS) with var_lib_t"
```

### Task A2: Teardown removes BOTH SELinux rules + both trees (folds fix (a))

**Files:**
- Modify: `launcher/src/linux_service.rs` (`teardown_commands`, System branch ~64-74)
- Test: same file's `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing test** — add to `linux_service.rs` tests:

```rust
#[test]
fn system_scope_teardown_removes_opt_and_var_opt() {
    let cmds = teardown_commands(Scope::System, "WsScrcpyWeb", "/usr/bin");
    let joined: Vec<String> = cmds.iter().map(|c| c.join(" ")).collect();
    let removes_dir = |d: &str| joined.iter().any(|c| c.contains("rm") && c.contains(d));
    let removes_fcontext = |spec: &str|
        joined.iter().any(|c| c.contains("semanage fcontext -d") && c.ends_with(spec));
    assert!(removes_dir("/opt/ws-scrcpy-web"));
    assert!(removes_dir("/var/opt/ws-scrcpy-web"));
    assert!(removes_fcontext("/opt/ws-scrcpy-web(/.*)?"));      // bin_t tree
    assert!(removes_fcontext("/var/opt/ws-scrcpy-web(/.*)?"));  // var_lib_t state (the fix-(a) rule)
}
```

- [ ] **Step 2: Run, verify fail**

Run: `cross test -p ws-scrcpy-web-launcher --target x86_64-unknown-linux-gnu linux_service`
Expected: FAIL on the `/var/opt` assertions (today only the single `/opt/...` rule + tree are removed).

- [ ] **Step 3: Implement** — in `teardown_commands`, System branch, replace the single `rm`/`-d` with both trees and both rules:

```rust
if scope == Scope::System {
    let semanage = format!("{}/semanage", sbindir_from(bindir));
    for dir in ["/opt/ws-scrcpy-web", "/var/opt/ws-scrcpy-web"] {
        cmds.push(vec![rm.clone(), "-rf".into(), dir.into()]);
    }
    // remove BOTH fcontext rules the install added: the /opt bin_t tree rule
    // AND the /var/opt var_lib_t state rule (the beta.40 regression — install
    // adds the state rule, teardown never did → `semanage fcontext -l | grep
    // ws-scrcpy-web` stayed non-empty after uninstall).
    for pathspec in ["/opt/ws-scrcpy-web(/.*)?", "/var/opt/ws-scrcpy-web(/.*)?"] {
        cmds.push(vec![semanage.clone(), "fcontext".into(), "-d".into(), pathspec.to_string()]);
    }
}
```

- [ ] **Step 4: Run, verify pass + lint**

Run: `cross test -p ws-scrcpy-web-launcher --target x86_64-unknown-linux-gnu linux_service`
Then: `cross clippy -p ws-scrcpy-web-launcher --target x86_64-unknown-linux-gnu -- -D warnings`
Expected: PASS (incl. the existing `system_scope_teardown_removes_opt_and_fcontext`); clippy clean.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/linux_service.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "fix(linux): teardown removes both /opt bin_t and /var/opt var_lib_t fcontext rules"
```

---

## Group B — Machine-wide binary install + bootstrapper

### Task B1: `buildMachineWideInstallScript` (binary-only relocate to `/opt`)

Stages **only** the AppImage into `/opt` (deps stay per-user `~/.local`), labels `bin_t`, writes `VERSION`, drops the `.desktop`. Mirrors `buildSystemInstallScript`'s pkexec-script shape (`SystemdClient.ts:271-339`) but is the smaller binary-only variant used by the first-launch "install system-wide" path.

**Files:** Modify `SystemdClient.ts`; Test `SystemdClient.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { buildMachineWideInstallScript, STAGED_SYSTEM_DIR } from '../SystemdClient';

it('machine-wide install stages just the binary + label + desktop + VERSION', () => {
    const s = buildMachineWideInstallScript(
        { sourceAppImage: '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage', version: '0.1.31-beta.1' },
        (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`,
    );
    expect(s).toContain('mkdir -p /opt/ws-scrcpy-web');
    expect(s).toContain('cp "/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage" "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
    expect(s).toContain('chmod 0755 "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
    expect(s).toContain("semanage fcontext -a -t bin_t '/opt/ws-scrcpy-web(/.*)?'");
    expect(s).toContain('restorecon -Rv "/opt/ws-scrcpy-web"');
    expect(s).toContain('/opt/ws-scrcpy-web/VERSION');           // VERSION written (Phase-3 version-compare reads it)
    expect(s).toContain('/usr/share/applications/ws-scrcpy-web.desktop');
    // binary-only: NO deps copy, NO unit install
    expect(s).not.toContain('dependencies');
    expect(s).not.toContain('systemctl');
});
```

- [ ] **Step 2: Run, verify fail** — `npm test -- src/server/service/SystemdClient.test.ts` → FAIL (`buildMachineWideInstallScript` undefined).

- [ ] **Step 3: Implement** — add to `SystemdClient.ts`, reusing the `binTool`/`sbinTool` injectable pattern from `buildSystemInstallScript`. Use `printf > VERSION` and a here-doc-free `.desktop` write (single-quoted to survive `sh -c`). Wrap the SELinux step in the same `( ( … ) || chcon … || true )` best-effort subshell as the existing builder. The `.desktop` content:
```
[Desktop Entry]\nType=Application\nName=ws-scrcpy-web\nExec=/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage\nIcon=ws-scrcpy-web\nCategories=Utility;
```
Steps joined with ` && `: `mkdir -p /opt/ws-scrcpy-web` · `cp <src> <staged>` · `chmod 0755 <staged>` · `printf '%s' '<version>' > /opt/ws-scrcpy-web/VERSION` · the bin_t label subshell + `restorecon -Rv /opt/ws-scrcpy-web` · write `.desktop` (best-effort, trailing `|| true`).

- [ ] **Step 4: Run, verify pass** — `npm test -- src/server/service/SystemdClient.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/service/SystemdClient.ts src/server/service/SystemdClient.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): buildMachineWideInstallScript (binary-only /opt relocate)"
```

### Task B2: Launcher bootstrapper — exec the `/opt` binary when present

Pure decision fn + exec seam. On Linux normal launch, if the shared `/opt` AppImage exists and we are NOT already it, re-exec `/opt` and exit. (No version-compare — Phase 3.)

**Files:** Modify `launcher/src/linux_service.rs` (or a sibling `linux_bootstrap.rs` — keep it in `linux_service.rs` to avoid a new module); wire in `launcher/src/main.rs`.

- [ ] **Step 1: Write the failing test** (pure fn) — add to `linux_service.rs` tests:

```rust
#[test]
fn bootstrap_target_execs_opt_when_present_and_not_self() {
    let opt = "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage";
    // /opt present, we are a home AppImage -> Some(/opt)
    assert_eq!(bootstrap_target(true, Some("/home/u/App.AppImage")), Some(PathBuf::from(opt)));
    // /opt present but we ARE /opt -> None (don't re-exec ourselves)
    assert_eq!(bootstrap_target(true, Some(opt)), None);
    // /opt absent -> None (run in place; first-run modal handles the prompt)
    assert_eq!(bootstrap_target(false, Some("/home/u/App.AppImage")), None);
    // no $APPIMAGE (from-source) -> None
    assert_eq!(bootstrap_target(true, None), None);
}
```

- [ ] **Step 2: Run, verify fail** — `cross test -p ws-scrcpy-web-launcher --target x86_64-unknown-linux-gnu linux_service` → FAIL (`bootstrap_target` undefined).

- [ ] **Step 3: Implement** — add to `linux_service.rs`:

```rust
/// Pure bootstrapper decision. `opt_exists` = the shared /opt AppImage is
/// present; `appimage_env` = $APPIMAGE (the file we were launched from, if any).
/// Returns the /opt binary to re-exec, or None to continue the in-place launch
/// (the frontend's first-run modal offers the system-wide install when /opt is
/// absent and the decline-marker is unset). No version-compare here — updates
/// are Phase 3.
pub fn bootstrap_target(opt_exists: bool, appimage_env: Option<&str>) -> Option<PathBuf> {
    let opt = PathBuf::from("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage");
    match appimage_env {
        Some(p) if opt_exists && p != opt.to_string_lossy() => Some(opt),
        _ => None,
    }
}
```

- [ ] **Step 4: Run, verify pass** — `cross test … linux_service` → PASS.

- [ ] **Step 5: Wire the exec seam in `main.rs`** — after the early sub-command dispatches (the `#[cfg(target_os="linux")]` block that handles `linux_apply`/`linux_service` teardown, ~main.rs:93-103) and BEFORE the normal supervisor start, add:

```rust
#[cfg(target_os = "linux")]
{
    let opt = std::path::Path::new("/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage");
    let appimage = std::env::var("APPIMAGE").ok();
    if let Some(target) = linux_service::bootstrap_target(opt.exists(), appimage.as_deref()) {
        log::info(&format!("bootstrap: exec'ing machine-wide /opt binary {target:?}"));
        let status = std::process::Command::new(&target).status();
        let code = status.ok().and_then(|s| s.code()).unwrap_or(0);
        std::process::exit(code);
    }
}
```

- [ ] **Step 6: Commit**
```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/linux_service.rs launcher/src/main.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): bootstrapper execs the shared /opt binary when present"
```

### Task B3: `ServiceApi` — `install-system-wide` + `decline-system-wide` endpoints

The first-run modal POSTs here. `install-system-wide` runs `buildMachineWideInstallScript` via the existing `runPkexec` (graphical auth); on success the next launch's bootstrapper execs `/opt`. `decline-system-wide` writes `<dataRoot>/control/system-install-declined`.

**Files:** Modify `src/server/api/ServiceApi.ts`; Test `src/server/__tests__/ServiceApi.test.ts`.

- [ ] **Step 1: Write failing tests** — assert (a) `POST /api/service/install-system-wide` invokes pkexec with a script containing the `/opt` cp + bin_t label (inject the pkexec runner, mirroring the existing `runPkexec` seam used in `SystemdClient`), and (b) `POST /api/service/decline-system-wide` creates the marker file at `<dataRoot>/control/system-install-declined`. Mirror the routing + injection style already in `ServiceApi.test.ts` (see the existing `--linux-service-teardown` / install tests, ~lines 646-711, 933).

- [ ] **Step 2: Run, verify fail** — `npm test -- src/server/__tests__/ServiceApi.test.ts` → FAIL (routes 404 / handlers absent).

- [ ] **Step 3: Implement** — add two routes to the `ServiceApi` request switch (follow the existing route-dispatch + `res.writeHead/end(JSON)` pattern in this file). `install-system-wide`: resolve `process.env.APPIMAGE` (400 if unset — from-source/non-AppImage can't relocate), read the app version from `package.json`/the version constant, build the script via `buildMachineWideInstallScript`, run it through the same pkexec helper `SystemdClient` uses (export/reuse `runPkexec`), 200 on success / 403 on auth-dismiss (exit 126) / 500 otherwise. `decline-system-wide`: `fs.mkdirSync(<dataRoot>/control, {recursive:true})` + `fs.writeFileSync(<dataRoot>/control/system-install-declined, '')`, 200.

- [ ] **Step 4: Run, verify pass** — `npm test -- src/server/__tests__/ServiceApi.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/ServiceApi.ts src/server/__tests__/ServiceApi.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(api): install-system-wide + decline-system-wide endpoints"
```

---

## Group C — Service-install gating + first-run modal (frontend)

### Task C1: `systemServiceInstallGate` pure fn

Gates the **system**-scope service install button on machine-wide install. Mirrors the existing pure fns in `SettingsModal.ts` (`scopeRadioState` 102-117, `stopServerButtonState` 121-137).

**Files:** Modify `src/app/client/SettingsModal.ts`; Test `src/app/client/__tests__/SettingsModal.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { systemServiceInstallGate } from '../SettingsModal';

it('system service install is gated on machine-wide install', () => {
    // not machine-wide -> install disabled with the explainer
    expect(systemServiceInstallGate({ machineWideInstalled: false })).toEqual({
        enabled: false,
        note: 'system service install requires installing system-wide for all users first.',
    });
    // machine-wide installed -> enabled, no note
    expect(systemServiceInstallGate({ machineWideInstalled: true })).toEqual({ enabled: true, note: null });
});
```

- [ ] **Step 2: Run, verify fail** — `npm test -- src/app/client/__tests__/SettingsModal.test.ts` → FAIL (undefined).

- [ ] **Step 3: Implement** — add to `SettingsModal.ts` near `stopServerButtonState`:

```ts
export interface SystemServiceInstallGate { enabled: boolean; note: string | null; }
/** System-scope service install requires a machine-wide /opt install first
 *  (the root service execs the /opt binary; it can't exist without it). */
export function systemServiceInstallGate(input: { machineWideInstalled: boolean }): SystemServiceInstallGate {
    return input.machineWideInstalled
        ? { enabled: true, note: null }
        : { enabled: false, note: 'system service install requires installing system-wide for all users first.' };
}
```

- [ ] **Step 4: Run, verify pass** — `npm test -- src/app/client/__tests__/SettingsModal.test.ts` → PASS.

- [ ] **Step 5: Commit**
```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/SettingsModal.ts src/app/client/__tests__/SettingsModal.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(ui): systemServiceInstallGate — gate system service on machine-wide install"
```

### Task C2: First-run `SystemWideInstallModal`

Shown on first run (Linux, no `/opt`, no decline-marker) before/around the existing WelcomeModal. Two actions: **install** (`POST /api/service/install-system-wide` → on 200, reload so the bootstrapper execs `/opt`) and **not now** (`POST /api/service/decline-system-wide` → close, continue local). Mirror `WelcomeModal.ts` structure + the project's modal conventions (scroll-lock per `feedback_modal_scroll_lock`; lowercase UI text; DOM-built, not `html\`\``).

**Files:** Create `src/app/client/SystemWideInstallModal.ts` + `__tests__/SystemWideInstallModal.test.ts`.

- [ ] **Step 1: Write the failing test** — assert the modal renders the two buttons (lowercase labels "install for all users" / "not now") and that clicking each calls the injected `onInstall` / `onDecline` callbacks. Mirror `WelcomeModal.test.ts` / the existing modal tests' DOM-query + click style.
- [ ] **Step 2: Run, verify fail** — `npm test -- src/app/client/__tests__/SystemWideInstallModal.test.ts` → FAIL (module absent).
- [ ] **Step 3: Implement** — create `SystemWideInstallModal.ts` mirroring `WelcomeModal.ts` (same base/DOM helpers, scroll-lock, lowercase copy). Copy: *"run ws-scrcpy-web for all users on this machine? installs the app to /opt (one administrator prompt). you can keep using it just for yourself instead."* Buttons wired to injected callbacks.
- [ ] **Step 4: Run, verify pass** — PASS.
- [ ] **Step 5: Commit**
```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/SystemWideInstallModal.ts src/app/client/__tests__/SystemWideInstallModal.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(ui): first-run system-wide install modal"
```

### Task C3: Render wiring — apply the gate + show the modal

**Files:** Modify `src/app/client/SettingsModal.ts` (service-section render) + the first-run entry (`src/app/index.ts`, where WelcomeModal/ServiceFirstRunModal are gated).

- [ ] **Step 1: Write the failing test** — extend `SettingsModal.test.ts`: when the rendered status reports `machineWideInstalled:false` and the system radio is selected, the install button carries the `disabled`-equivalent state + the gate note (assert via the same render-snapshot/DOM approach the existing service-section tests use).
- [ ] **Step 2: Run, verify fail** — FAIL (render ignores the gate).
- [ ] **Step 3: Implement** — in the service-section render, call `systemServiceInstallGate({ machineWideInstalled })` (read `machineWideInstalled` from the service status response — add the boolean to the status payload server-side: `/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage` exists) and apply `enabled`/`note` to the install button when the system radio is active. In `index.ts`, show `SystemWideInstallModal` on first run when Linux + `!machineWideInstalled` + decline-marker unset (server-reported), ahead of the local WelcomeModal.
- [ ] **Step 4: Run, verify pass + full suite** — `npm test` (whole vitest suite) → PASS; `npx tsc --noEmit` clean.
- [ ] **Step 5: Commit**
```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/SettingsModal.ts src/app/index.ts src/server/api/ServiceApi.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(ui): wire system-wide gate + first-run modal into render/first-run flow"
```

---

## Phase-1 exit criteria (runtime — Fedora VM, SELinux enforcing)

Not unit-coverable; run on the Hyper-V Fedora VM after the unit work is green:

- Fresh AppImage, first run → **system-wide install modal**; **install** → app relocates to `/opt`, `.desktop` appears, relaunches from `/opt`, `ls -Z /opt/ws-scrcpy-web` → `bin_t`; **not now** → runs in place, marker written, **no re-prompt** next launch.
- System-scope service install **gated** until machine-wide install is done (greyed + modal); after machine-wide install, the system service installs, state lands in **`/var/opt/ws-scrcpy-web`** (`ls -Z` → `var_lib_t`), config persists across reboot, **zero AVC**.
- Uninstall the system service → `semanage fcontext -l | grep ws-scrcpy-web` is **empty** (both rules gone — fix (a)); `/opt` + `/var/opt` removed.

---

## Self-review

- **Spec coverage:** §1 layout/SELinux → A1, A2, B1 (labels) + exit criteria. §2 install/bootstrap → B1, B2, B3, C2, C3 (elevation = pkexec via existing `runPkexec`; service-gating → C1/C3). §2 deps-follow-run-context → A1 keeps `DEPS_PATH=/opt/.../dependencies` for the service while machine-wide install copies **no** deps (B1). §3 relaunch + §4 migration → **Phases 2 & 3** (out of scope, stated). Fix (a) → A2. ✓
- **Placeholder scan:** none — every code step shows the function/test; "mirror function X at file:line" references point at concrete existing code to copy a pattern (the established way to extend this codebase), not vague TODOs.
- **Type consistency:** `SYSTEM_STATE_DIR`, `buildMachineWideInstallScript(args, binTool, sbinTool)`, `bootstrap_target(opt_exists, appimage_env)`, `systemServiceInstallGate({machineWideInstalled})` are used identically across tasks and tests.

## Notes for the implementer

- The first-run modal's `install`/`decline` and the gate all key off **`machineWideInstalled`** = `/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage` exists; add that boolean to the service-status payload (C3) so the frontend doesn't probe the filesystem directly.
- `runPkexec` currently lives inside `SystemdClient.ts` (private). Export it (or a thin wrapper) for `ServiceApi` reuse in B3 rather than duplicating the pkexec error-mapping.
- Per-user dataRoot casing is `~/.local/share/WsScrcpyWeb` (PascalCase, per `data_root_for_linux`); `/opt` + `/var/opt` use lowercase-hyphen `ws-scrcpy-web`. Don't unify them — both are load-bearing.
