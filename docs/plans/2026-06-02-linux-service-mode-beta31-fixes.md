# Linux Service-Mode beta.31 Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the 7 issues found smoke-testing v0.1.30-beta.30's Linux service-mode on real Fedora 44 (SELinux enforcing), plus a bookmark global-dismiss enhancement; ship as v0.1.30-beta.31.

**Architecture:** All changes are TypeScript/CSS/doc — **no Rust, no launcher rebuild**. The system-scope teardown reuses the existing Rust helper, just exec'd from a `bin_t` path in `/opt`. The modal-precedence tree already exists in `src/app/index.ts`; #5 only adds the bookmark global-dismiss.

**Tech Stack:** TypeScript (server + client), Vitest, webpack, CSS. Spec: `docs/specs/2026-06-01-linux-service-mode-beta31-fixes-design.md`.

**PRINCIPLE 0 — Windows stays byte-for-byte identical.** Every fix is Linux-platform-gated or additive. The existing win32 service tests must stay green, unchanged. Branch: `linux-service-mode-beta31-fixes`.

**Commands** (run from repo root `C:/Users/jscha/source/repos/ws-scrcpy-web`, use `git -C`):
- Single test file: `npx vitest run <path>`
- Full suite: `npm test`
- Types: `npm run build:types` · Prod build: `npm run build`
- Rust (no changes expected; confirm at the fence): `cargo test` + `cargo clippy --` in `launcher/` via `cross` per existing CI.

---

## File Structure

| File | Change |
|------|--------|
| `src/server/service/SystemdClient.ts` | #1 `renderUnitFile` (StartLimit→[Unit]); #2 `buildSystemInstallScript` (stage helper) + `install()` system branch (pass helper source) |
| `src/server/api/ServiceApi.ts` | #2 `handleUninstall` system-scope handoff (/opt helper + pkexec); #2 `handleInstall` (resolve+pass helper source); #3 local-exit on Linux |
| `src/app/client/SettingsModal.ts` | #4 install poll reconnect; #5d reset clears global flag |
| `src/common/ConfigEvents.ts` | #5a `bookmarkDismissedGlobally` in `AppConfig` + defaults |
| `src/server/Config.ts` | #5a `FlatConfig` + `validateField` for the new flag |
| `src/app/index.ts` | #5b `maybeShowPortChangeModal` global gate |
| `src/app/client/PortChangeModal.ts` | #5c global checkbox + confirmation dialog |
| `src/style/modal.css` | #6 scope-radio accent-color + disabled opacity |
| `README.md` | #7 unit name + scope-qualified warning |
| `package.json` / `Cargo.toml` | Task 12 version bump (via the bump script) |

---

## Task 1: `StartLimit*` keys → `[Unit]` (#1)

**Files:**
- Modify: `src/server/service/SystemdClient.ts:189-209` (`renderUnitFile`)
- Test: `src/server/service/SystemdClient.test.ts`

Current `renderUnitFile` return (lines 189-209) places `StartLimitBurst`/`StartLimitIntervalSec` in `[Service]`:
```typescript
    return [
        '[Unit]',
        `Description=${opts.description}`,
        'After=network.target',
        '',
        '[Service]',
        'Type=simple',
        `ExecStart=${execStart}`,
        `WorkingDirectory=${workingDir}`,
        'Restart=on-failure',
        'RestartSec=5',
        `StartLimitBurst=${opts.maxRestartAttempts}`,
        'StartLimitIntervalSec=300',
        ...(envLines ? [envLines] : []),
        `StandardOutput=append:${opts.logPath}`,
        `StandardError=append:${opts.logPath}`,
        '',
        '[Install]',
        `WantedBy=${wantedBy}`,
        '',
    ].join('\n');
```

- [ ] **Step 1: Write the failing test** — add to `SystemdClient.test.ts` in the `renderUnitFile` describe block:

```typescript
it('places StartLimit keys in [Unit], not [Service] (systemd ignores them in [Service])', () => {
    const unit = renderUnitFile(baseOpts, 'system');
    const unitSection = unit.slice(unit.indexOf('[Unit]'), unit.indexOf('[Service]'));
    const serviceSection = unit.slice(unit.indexOf('[Service]'), unit.indexOf('[Install]'));
    expect(unitSection).toContain('StartLimitIntervalSec=300');
    expect(unitSection).toContain('StartLimitBurst=3');
    expect(serviceSection).not.toContain('StartLimitIntervalSec');
    expect(serviceSection).not.toContain('StartLimitBurst');
});
```
(Use the existing `baseOpts` fixture in that describe, or construct one with `maxRestartAttempts: 3`, `description`, `logPath`, `binPath`, `startupDir`.)

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/server/service/SystemdClient.test.ts` → fails (keys currently in `[Service]`).

- [ ] **Step 3: Implement** — move the two lines into `[Unit]` (after `After=network.target`):

```typescript
    return [
        '[Unit]',
        `Description=${opts.description}`,
        'After=network.target',
        // systemd reads StartLimit* from [Unit], NOT [Service] (it silently
        // ignores them in [Service] → the restart cap never applies).
        'StartLimitIntervalSec=300',
        `StartLimitBurst=${opts.maxRestartAttempts}`,
        '',
        '[Service]',
        'Type=simple',
        `ExecStart=${execStart}`,
        `WorkingDirectory=${workingDir}`,
        'Restart=on-failure',
        'RestartSec=5',
        ...(envLines ? [envLines] : []),
        `StandardOutput=append:${opts.logPath}`,
        `StandardError=append:${opts.logPath}`,
        '',
        '[Install]',
        `WantedBy=${wantedBy}`,
        '',
    ].join('\n');
```

- [ ] **Step 4: Run — expect PASS.** Also re-run any existing `renderUnitFile` tests (they may assert the unit contains the keys — those still pass since the keys are present, just in a different section).
- [ ] **Step 5: Commit.** `git -C <repo> add src/server/service/SystemdClient.ts src/server/service/SystemdClient.test.ts && git -C <repo> commit -m "fix(linux): move systemd StartLimit* keys to [Unit] (#1)"`

---

## Task 2: Stage the launcher helper into `/opt` at system install (#2 install side)

**Why:** the system-scope teardown must exec a `bin_t` helper; staging it beside the AppImage in `/opt/ws-scrcpy-web/` gets it `bin_t` via the existing fcontext rule.

**Files:**
- Modify: `src/server/service/SystemdClient.ts` (`buildSystemInstallScript` + the `install()` system branch)
- Modify: `src/server/api/ServiceApi.ts` (`handleInstall`: resolve + pass the helper source path)
- Test: `src/server/service/SystemdClient.test.ts`

- [ ] **Step 1: Failing test** — `buildSystemInstallScript` stages the helper. Add:

```typescript
it('stages the launcher helper into /opt alongside the AppImage (bin_t via the fcontext rule)', () => {
    const script = buildSystemInstallScript({
        sourceAppImage: '/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage',
        sourceHelper: '/home/u/.local/share/WsScrcpyWeb/control/operation-server/ws-scrcpy-web-launcher.exe',
        unitTmpPath: '/tmp/WsScrcpyWeb.service.tmp',
        unitPath: '/etc/systemd/system/WsScrcpyWeb.service',
        name: 'WsScrcpyWeb',
    });
    // helper copied to /opt + chmod, BEFORE the relabel so restorecon labels it bin_t
    expect(script).toContain('cp "/home/u/.local/share/WsScrcpyWeb/control/operation-server/ws-scrcpy-web-launcher.exe" "/opt/ws-scrcpy-web/ws-scrcpy-web-launcher.exe"');
    expect(script).toContain('chmod 0755 "/opt/ws-scrcpy-web/ws-scrcpy-web-launcher.exe"');
    const helperCp = script.indexOf('/opt/ws-scrcpy-web/ws-scrcpy-web-launcher.exe');
    const relabel = script.indexOf('restorecon -Rv');
    expect(helperCp).toBeLessThan(relabel);
});

it('omits the helper cp when no sourceHelper is provided (from-source / unavailable)', () => {
    const script = buildSystemInstallScript({
        sourceAppImage: '/a.AppImage', unitTmpPath: '/t', unitPath: '/u', name: 'WsScrcpyWeb',
    });
    expect(script).not.toContain('ws-scrcpy-web-launcher.exe');
});
```

- [ ] **Step 2: Run — expect FAIL** (the `sourceHelper` arg + cp don't exist yet).

- [ ] **Step 3: Implement `buildSystemInstallScript`** — add optional `sourceHelper`; insert the helper cp+chmod after the AppImage chmod, before the relabel. Replace the function body (lines 219-251):

```typescript
export function buildSystemInstallScript(
    args: { sourceAppImage: string; sourceHelper?: string; unitTmpPath: string; unitPath: string; name: string },
    binTool: (t: string) => string = (t) => resolveSystemTool(t),
    sbinTool: (t: string) => string = (t) => resolveSystemTool(t),
): string {
    const staged = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
    const stagedHelper = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_HELPER}`;
    const mkdir = binTool('mkdir');
    const cp = binTool('cp');
    const chmod = binTool('chmod');
    const chcon = binTool('chcon');
    const systemctl = binTool('systemctl');
    const semanage = sbinTool('semanage');
    const restorecon = sbinTool('restorecon');
    const steps = [
        // 1. stage the AppImage into /opt (root-owned)
        `${mkdir} -p ${STAGED_SYSTEM_DIR}`,
        `${cp} "${args.sourceAppImage}" "${staged}"`,
        `${chmod} 0755 "${staged}"`,
    ];
    // 1b. stage the out-of-mount teardown helper into /opt too, so the
    // system-scope uninstall can exec it under init_t (a home-dir copy is
    // data_home_t → init_t exec is SELinux-denied — the beta.30 AVC).
    if (args.sourceHelper) {
        steps.push(`${cp} "${args.sourceHelper}" "${stagedHelper}"`);
        steps.push(`${chmod} 0755 "${stagedHelper}"`);
    }
    steps.push(
        // 2. label bin_t (the rule covers /opt/ws-scrcpy-web(/.*)?, so the helper
        //    copied above is relabelled bin_t too). Isolated best-effort subshell.
        `( ( ${semanage} fcontext -a -t bin_t '${STAGED_SYSTEM_DIR}(/.*)?' && ${restorecon} -Rv "${STAGED_SYSTEM_DIR}" ) || ${chcon} -t bin_t "${staged}" || true )`,
        // 3. install + enable the unit
        `${cp} "${args.unitTmpPath}" "${args.unitPath}"`,
        `${systemctl} daemon-reload`,
        `${systemctl} enable --now ${args.name}.service`,
    );
    return steps.join(' && ');
}
```
Add the constant near `STAGED_SYSTEM_APPIMAGE` (line ~70-72):
```typescript
export const STAGED_SYSTEM_HELPER = 'ws-scrcpy-web-launcher.exe';
```

- [ ] **Step 4: Run — expect PASS.**

- [ ] **Step 5: Plumb the helper source through `install()` + `ServiceApi`.** In `ServiceApi.handleInstall`, the Linux branch already computes `dataRoot`; resolve the home helper path and pass it via a new install opt. After the `binPath`/`startupDir` block (~line 248), add:
```typescript
        // Source for the /opt teardown-helper staging (system scope). The
        // out-of-mount helper is staged at startup under control/operation-server;
        // pass it so SystemdClient can copy it into /opt (bin_t) for the
        // SELinux-safe system-scope uninstall.
        let linuxHelperSource: string | undefined;
        if (result.platform === 'linux') {
            const dr = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
            const cand = path.join(dr, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
            if (this.existsCheck(cand)) linuxHelperSource = cand;
            else log.warn(`linux system install: teardown helper not found at ${cand}; /opt staging skipped (system uninstall may need manual cleanup)`);
        }
```
Add `linuxHelperSource` to the `client.install({...})` call object (after `scope,`). Extend `ServiceInstallOptions` (its type, likely in `src/server/service/types.ts` or `ServiceEvents.ts` — locate) with `linuxHelperSource?: string`. In `SystemdClient.install` system branch (lines 336-365), pass it through:
```typescript
        const cmd = buildSystemInstallScript({
            sourceAppImage: opts.binPath,
            sourceHelper: opts.linuxHelperSource,
            unitTmpPath: tmpFile,
            unitPath,
            name: opts.name,
        });
```

- [ ] **Step 6: Run full server suite** `npx vitest run src/server` — green (existing install tests unaffected; the new opt is optional). Add a `ServiceApi` test asserting `client.install` receives `linuxHelperSource` when the candidate exists (mirror the existing install test, set platform `linux`, create the candidate file in the tmp dataRoot).
- [ ] **Step 7: Commit.** `git -C <repo> commit -am "fix(linux): stage teardown helper into /opt+bin_t at system install (#2 install)"`

---

## Task 3: System-scope uninstall execs the `/opt` helper, elevated (#2 uninstall side)

**Files:**
- Modify: `src/server/api/ServiceApi.ts` (`handleUninstall` Linux branch, lines ~428-441)
- Test: `src/server/__tests__/ServiceApi.test.ts`

Current handoff (lines 428-441):
```typescript
            const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
            const helper = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
            const systemdRun = resolveSystemTool('systemd-run');
            const sdArgs = [
                ...(scope === 'user' ? ['--user'] : []),
                '--collect',
                `--unit=wsscrcpy-teardown-${Date.now()}`,
                helper,
                '--linux-service-teardown', '--scope', scope, '--unit', WS_SCRCPY_SERVICE_NAME,
            ];
            this.spawnDetached(systemdRun, sdArgs);
```

- [ ] **Step 1: Failing tests** — add to `ServiceApi.test.ts` (mirror the existing Linux-uninstall test, which injects `spawnDetached`):

```typescript
it('system-scope uninstall execs the /opt helper (bin_t) via systemd-run --system, root → no pkexec', async () => {
    // factoryResult.platform = 'linux', client.getInstalledScope → 'system'
    // process.getuid stubbed to 0 (root) for this test
    const getuidSpy = vi.spyOn(process, 'getuid').mockReturnValue(0);
    // ... construct api with spawnDetached, installMode system-service ...
    await api.handle(req, res);
    expect(spawnedCmd).toMatch(/systemd-run$/);
    expect(spawnedArgs).not.toContain('--user');
    expect(spawnedArgs).toContain('--system');
    expect(spawnedArgs.some((a) => a.endsWith('/opt/ws-scrcpy-web/ws-scrcpy-web-launcher.exe'))).toBe(true);
    expect(spawnedArgs).toContain('system');
    getuidSpy.mockRestore();
});

it('system-scope uninstall wraps in pkexec when the serving process is NOT root', async () => {
    const getuidSpy = vi.spyOn(process, 'getuid').mockReturnValue(1000);
    // ... system scope ...
    await api.handle(req, res);
    expect(spawnedCmd).toMatch(/pkexec$/);
    expect(spawnedArgs[0]).toMatch(/systemd-run$/);
    expect(spawnedArgs).toContain('--system');
    expect(spawnedArgs.some((a) => a.endsWith('/opt/ws-scrcpy-web/ws-scrcpy-web-launcher.exe'))).toBe(true);
    getuidSpy.mockRestore();
});

it('user-scope uninstall is UNCHANGED (home helper, systemd-run --user, no pkexec)', async () => {
    // existing behavior — keep the existing assertion: --user + the home helper + --scope user
    expect(spawnedCmd).toMatch(/systemd-run$/);
    expect(spawnedArgs).toContain('--user');
    expect(spawnedArgs.some((a) => a.includes('control/operation-server/ws-scrcpy-web-launcher.exe'))).toBe(true);
});
```

- [ ] **Step 2: Run — expect FAIL** (system scope currently uses the home helper, no `--system`/pkexec).

- [ ] **Step 3: Implement** — replace the handoff (lines 428-441) with scope-aware logic. Import `STAGED_SYSTEM_DIR`, `STAGED_SYSTEM_HELPER` from SystemdClient:
```typescript
            const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
            const systemdRun = resolveSystemTool('systemd-run');
            const teardownUnit = `--unit=wsscrcpy-teardown-${Date.now()}`;
            let cmd: string;
            let sdArgs: string[];
            if (scope === 'system') {
                // System scope: exec the /opt-staged helper (bin_t — init_t may
                // exec it, unlike the data_home_t home copy that SELinux blocks),
                // out-of-cgroup via systemd-run --system, elevated by pkexec when
                // the serving process isn't already root (the system service is).
                const optHelper = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_HELPER}`;
                const runArgs = [
                    '--system', '--collect', teardownUnit,
                    optHelper, '--linux-service-teardown', '--scope', 'system', '--unit', WS_SCRCPY_SERVICE_NAME,
                ];
                if (process.getuid?.() === 0) {
                    cmd = systemdRun;
                    sdArgs = runArgs;
                } else {
                    cmd = resolveSystemTool('pkexec');
                    sdArgs = [systemdRun, ...runArgs];
                }
            } else {
                // User scope: UNCHANGED — home helper, user manager, includes relaunch.
                const helper = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
                cmd = systemdRun;
                sdArgs = [
                    '--user', '--collect', teardownUnit,
                    helper, '--linux-service-teardown', '--scope', 'user', '--unit', WS_SCRCPY_SERVICE_NAME,
                ];
            }
            this.spawnDetached(cmd, sdArgs);
```

- [ ] **Step 4: Run — expect PASS** (all three tests, plus the existing Linux-uninstall test still green for user scope).
- [ ] **Step 5: Commit.** `git -C <repo> commit -am "fix(linux): system-scope uninstall execs /opt bin_t helper + pkexec when non-root (#2 uninstall)"`

**Note (no code):** the helper's `rm -rf /opt/ws-scrcpy-web` deletes itself while running — fine on Linux (inode held). The helper's adb-reap may log a benign AVC under init_t; `systemctl stop` already reaps the unit cgroup. Out of scope.

---

## Task 4: Local instance exits after a Linux service install (#3)

**Files:**
- Modify: `src/server/api/ServiceApi.ts:367-372`
- Test: `src/server/__tests__/ServiceApi.test.ts`

Current (lines 363-372):
```typescript
        // Schedule local-Node exit. ... safety cap ...
        if (result.platform === 'win32') {
            setTimeout(() => {
                log.info('install-flow: local instance exiting (service is running)');
                process.exit(0);
            }, 15_000).unref();
        }
```

- [ ] **Step 1: Failing test.** The `process.exit` + `setTimeout` make this awkward to assert directly. Inject the exit scheduler for testability — add a 5th constructor param `scheduleExit: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms).unref(); }` and call `this.scheduleExit(...)`. Then test:
```typescript
it('schedules local-instance exit after a successful install on Linux (mirrors win32)', async () => {
    const scheduled: number[] = [];
    const scheduleExit = vi.fn((_fn: () => void, ms: number) => { scheduled.push(ms); });
    // factoryResult.platform = 'linux', client.install resolves, status 'running'
    const api = new ServiceApi(() => factoryResult, () => 'user', () => true, spawnDetached, scheduleExit);
    await api.handle(req, res);
    expect(scheduleExit).toHaveBeenCalledTimes(1);
    expect(scheduled[0]).toBe(15_000);
});
```
Also keep/confirm the existing win32 behavior with the same injected scheduler.

- [ ] **Step 2: Run — expect FAIL** (Linux currently doesn't schedule).
- [ ] **Step 3: Implement** — add the `scheduleExit` ctor param (default preserves current behavior), and widen the platform gate:
```typescript
        // Schedule local-Node exit. This instance is useless once the service is
        // running. Fires on win32 AND linux — the frontend navigates/reconnects
        // once the service binds; this timer is a safety cap, not the mechanism.
        if (result.platform === 'win32' || result.platform === 'linux') {
            this.scheduleExit(() => {
                log.info('install-flow: local instance exiting (service is running)');
                process.exit(0);
            }, 15_000);
        }
```

- [ ] **Step 4: Run — expect PASS.** Confirm the existing win32 install test still green (byte-identical behavior — win32 still schedules).
- [ ] **Step 5: Commit.** `git -C <repo> commit -am "fix(linux): exit the local instance after a Linux service install (#3)"`

---

## Task 5: Install discovery reconnects on same-port handoff (#4)

**Files:**
- Modify: `src/app/client/SettingsModal.ts` install poll (lines ~977-1012)
- Test: `src/app/client/__tests__/SettingsModal.test.ts` (extract the discovery logic into a testable pure helper)

The poll's `catch` currently errors when the local server drops (lines 1002-1011). Under decision A, the local instance exiting (#3) makes the service take the same port → that drop is now the EXPECTED success path → reconnect-reload instead of error.

- [ ] **Step 1: Extract + test a pure decision helper.** Add an exported helper that classifies a poll tick, so it's unit-testable without timers/DOM:
```typescript
export type PollOutcome =
    | { kind: 'keep-polling' }
    | { kind: 'navigate'; port: number }
    | { kind: 'reconnect' }      // local gone → service taking same port → reload current URL
    | { kind: 'timeout' };
export function classifyInstallPoll(
    args: { reachable: boolean; configMtime: number | null; baselineMtime: number; diskWebPort: number | null; iterations: number; maxIterations: number },
): PollOutcome {
    if (!args.reachable) return { kind: 'reconnect' };   // local server dropped (instance exiting)
    if (args.configMtime != null && args.configMtime !== args.baselineMtime && args.diskWebPort != null)
        return { kind: 'navigate', port: args.diskWebPort };
    if (args.iterations > args.maxIterations) return { kind: 'timeout' };
    return { kind: 'keep-polling' };
}
```
Tests:
```typescript
describe('classifyInstallPoll', () => {
    const base = { reachable: true, configMtime: 100, baselineMtime: 100, diskWebPort: null, iterations: 1, maxIterations: 30 };
    it('navigates when config mtime changed + port known (existing Windows path)', () => {
        expect(classifyInstallPoll({ ...base, configMtime: 200, diskWebPort: 8002 })).toEqual({ kind: 'navigate', port: 8002 });
    });
    it('reconnects (not errors) when the local server becomes unreachable — same-port handoff', () => {
        expect(classifyInstallPoll({ ...base, reachable: false })).toEqual({ kind: 'reconnect' });
    });
    it('keeps polling while reachable + no config change', () => {
        expect(classifyInstallPoll(base)).toEqual({ kind: 'keep-polling' });
    });
    it('times out after maxIterations', () => {
        expect(classifyInstallPoll({ ...base, iterations: 31 })).toEqual({ kind: 'timeout' });
    });
});
```

- [ ] **Step 2: Run — expect FAIL** (`classifyInstallPoll` not defined).
- [ ] **Step 3: Implement** the helper, then rewire the poll body to use it. Replace the poll's per-tick logic (the `try { fetch status… } catch {…}` block) so:
  - `navigate` → `clearInterval(poll); window.location.href = http://localhost:${port}/`
  - `reconnect` → `clearInterval(poll)`, close modal, and after a 2.5s grace reload to the current origin with a small retry budget:
```typescript
                case 'reconnect': {
                    clearInterval(poll);
                    // The local instance is exiting (#3); the service is taking
                    // over the same port. Reload current URL after a grace.
                    modal.setMessage?.('service installed — reconnecting…');
                    setTimeout(() => { window.location.reload(); }, 2500);
                    return;
                }
```
  - `timeout` → existing "port discovery timed out" error.
  - `keep-polling` → return.
  Reachability: wrap the status `fetch` so a thrown/`!ok` fetch sets `reachable=false` for the classifier (the existing `catch` becomes "reachable=false" feeding `classifyInstallPoll`).

- [ ] **Step 4: Run — expect PASS.** Manually re-read the poll to confirm the **navigate** branch is byte-equivalent to today (Windows relies on it).
- [ ] **Step 5: Commit.** `git -C <repo> commit -am "fix(linux): reconnect on same-port service handoff instead of false timeout (#4)"`

---

## Task 6: `bookmarkDismissedGlobally` config field (#5a)

**Files:**
- Modify: `src/common/ConfigEvents.ts` (`AppConfig` line ~20-59, `APP_CONFIG_DEFAULTS` ~99-109)
- Modify: `src/server/Config.ts` (`FlatConfig` ~30-51, `validateField` ~237-243, and the flat↔app mapping)
- Test: `src/server/__tests__/` Config tests (locate the existing Config test)

- [ ] **Step 1: Failing test** — a PATCH of `bookmarkDismissedGlobally: true` round-trips:
```typescript
it('persists bookmarkDismissedGlobally', () => {
    const cfg = Config.getInstance();
    cfg.updateAppConfig({ bookmarkDismissedGlobally: true });
    expect(cfg.getAppConfig().bookmarkDismissedGlobally).toBe(true);
});
```
- [ ] **Step 2: Run — expect FAIL** (field unknown / not persisted).
- [ ] **Step 3: Implement** — add `bookmarkDismissedGlobally: boolean;` to `AppConfig` (next to `bookmarkDismissedForPort`), `bookmarkDismissedGlobally: false` to `APP_CONFIG_DEFAULTS`, `bookmarkDismissedGlobally?: boolean;` to `FlatConfig`, a `validateField` case mirroring `firstRunComplete`/`serviceFirstRunSeen` (boolean validation), and include it in the flat↔app read/write mapping in `Config.ts` (mirror `serviceFirstRunSeen` everywhere it appears).
- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/server` green.
- [ ] **Step 5: Commit.** `git -C <repo> commit -am "feat: add bookmarkDismissedGlobally config flag (#5a)"`

---

## Task 7: Bookmark routing honors the global flag (#5b)

**Files:**
- Modify: `src/app/index.ts` (`maybeShowWelcomeModal` + `maybeShowPortChangeModal`, lines 74-136)
- Test: extract the gate into a pure helper + test it.

`maybeShowPortChangeModal` currently only checks per-port. Gate it on the global flag.

- [ ] **Step 1: Failing test** — pure helper `shouldShowBookmark`:
```typescript
export function shouldShowBookmark(args: { globallyDismissed: boolean; dismissedForPort: number | null; currentPort: number }): boolean {
    if (args.globallyDismissed) return false;
    if (args.dismissedForPort === args.currentPort) return false;
    return true;
}
```
Tests: global set → false; per-port match → false; otherwise → true.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the helper; pass `config.bookmarkDismissedGlobally` into `maybeShowPortChangeModal` and call `shouldShowBookmark(...)` before importing/showing `PortChangeModal`. Both call sites (service-seen branch + local-firstRunComplete branch) pass the flag.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git -C <repo> commit -am "feat: bookmark routing honors the global-dismiss flag (#5b)"`

---

## Task 8: PortChangeModal global-dismiss checkbox + confirmation (#5c)

**Files:**
- Modify: `src/app/client/PortChangeModal.ts`
- Reference (confirm-dialog pattern): `src/app/client/ShellCloseConfirmModal.ts` (white-outline buttons) — reuse its pattern/styles
- Test: `src/app/client/__tests__/PortChangeModal.test.ts` (new)

- [ ] **Step 1: Failing tests** (jsdom): construct `PortChangeModal`, then:
  - both checkboxes render ("for this port" + the new global one);
  - checking the global box disables the per-port box;
  - dismissing with global checked + confirmed PATCHes `{ bookmarkDismissedGlobally: true }`;
  - dismissing with global checked + cancelled does NOT PATCH and leaves the modal open.
  (Mock `fetch`; for the confirmation, stub the confirm-modal to resolve true/false.)
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement.** Add the second checkbox after the existing one (mirror lines 95-106):
```typescript
const globalLabel = document.createElement('label');
globalLabel.style.cssText = dontShowLabel.style.cssText;
const globalCheckbox = document.createElement('input');
globalCheckbox.type = 'checkbox';
globalLabel.appendChild(globalCheckbox);
globalLabel.appendChild(document.createTextNode("don't show again — ever, even when the port changes"));
this.globalCheckbox = globalCheckbox;
container.appendChild(globalLabel);
globalCheckbox.addEventListener('change', () => {
    checkbox.disabled = globalCheckbox.checked;            // grey out per-port when global
    dontShowLabel.style.opacity = globalCheckbox.checked ? '0.5' : '1';
});
```
Update `dismiss()` (lines 109-121): if `globalCheckbox.checked`, await a confirmation dialog; on confirm PATCH `{ bookmarkDismissedGlobally: true }` and close; on cancel, return without closing (modal stays, global box stays checked). Else keep the existing per-port behavior.
```typescript
private async dismiss(): Promise<void> {
    if (this.globalCheckbox?.checked) {
        const ok = await ConfirmModal.confirm({
            title: 'dismiss bookmark reminder',
            message: "You won't see this bookmark helper again, even when the port changes.",
            confirmText: 'OK', cancelText: 'Cancel',
        });
        if (!ok) return;   // back to the bookmark modal, flag NOT committed
        void fetch('/api/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bookmarkDismissedGlobally: true }) }).catch(() => {});
        this.opts.onDismissed?.();
        this.close();
        return;
    }
    if (this.dismissBtn) this.dismissBtn.disabled = true;
    if (this.dontShowCheckbox?.checked) {
        void fetch('/api/config', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bookmarkDismissedForPort: this.opts.webPort }) }).catch(() => {});
    }
    this.opts.onDismissed?.();
    this.close();
}
```
If no reusable `ConfirmModal` exists, create a tiny `src/app/client/ConfirmModal.ts` (extends `Modal`, white-outline buttons mirroring `ShellCloseConfirmModal`, static `confirm(opts): Promise<boolean>`). Confirm the button style class matches the beta.29 white-outline buttons.

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git -C <repo> commit -am "feat: bookmark modal global-dismiss + confirmation (#5c)"`

---

## Task 9: Reset clears the global flag (#5d)

**Files:**
- Modify: `src/app/client/SettingsModal.ts` reset handler (lines 1190-1202) + the label copy (line ~1168-1172)

- [ ] **Step 1: Failing test** — assert the reset PATCH body includes `bookmarkDismissedGlobally: false`. If the handler isn't unit-testable, extract the reset payload into an exported constant/function `resetPromptsPayload()` and test it:
```typescript
export function resetPromptsPayload() {
    return { firstRunComplete: false, serviceFirstRunSeen: false, bookmarkDismissedForPort: null, bookmarkDismissedGlobally: false };
}
it('reset clears all four prompt flags', () => {
    expect(resetPromptsPayload()).toEqual({ firstRunComplete: false, serviceFirstRunSeen: false, bookmarkDismissedForPort: null, bookmarkDismissedGlobally: false });
});
```
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** — use `resetPromptsPayload()` in the reset PATCH (lines 1190-1202) and update the label copy (line ~1168) to mention the global bookmark dismissal too: `'…service-mode modal, per-port bookmark reminder, and the global bookmark dismissal…'`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit.** `git -C <repo> commit -am "fix: reset prompts also clears the global bookmark dismissal (#5d)"`

---

## Task 10: Scope-radio contrast (#6)

**Files:**
- Modify: `src/style/modal.css` (radio rules ~610-629)

- [ ] **Step 1: Implement** (CSS — manual visual test, no unit test). Add `accent-color` to the scope radios and lift the disabled opacity. After the `.settings-radio-label` rule (line ~610-618), add:
```css
dialog.settings-modal .settings-control .settings-radio-label input[type="radio"] {
    accent-color: #5b9aff;   /* match the app's checkboxes/range; keeps the checked dot visible */
}
```
And change the disabled rule (line 626-629) opacity:
```css
dialog.settings-modal .settings-control .settings-radio-label:has(input:disabled) {
    opacity: 0.65;           /* was 0.5 — 0.5 hid the selected dot when muted */
    cursor: not-allowed;
}
```
- [ ] **Step 2: Build** `npm run build` to confirm CSS compiles into the bundle.
- [ ] **Step 3: Commit.** `git -C <repo> commit -am "fix(ui): scope-radio contrast — accent-color + lift disabled opacity (#6)"`

---

## Task 11: README service-name fix (#7)

**Files:**
- Modify: `README.md` (Service Mode section, ~lines 271-292)

- [ ] **Step 1: Implement.** Change `ws-scrcpy-web.service` → `WsScrcpyWeb.service` (user + system unit paths). Scope-qualify the "do not move/rename the AppImage" warning (~line 278): note it applies to **user scope** (ExecStart = home AppImage); **system scope** runs the `/opt/ws-scrcpy-web/` staged copy, so moving the home AppImage doesn't break a system-scope service. Verify against the actual install behavior.
- [ ] **Step 2: Commit.** `git -C <repo> commit -am "docs: correct service unit name (WsScrcpyWeb.service) + scope-qualify AppImage-move warning (#7)"`

---

## Task 12: Regression fence + cut beta.31

- [ ] **Step 1: Full TS suite.** `npm test` — all green, **including the existing win32 service tests unchanged** (Principle 0).
- [ ] **Step 2: Types + build.** `npm run build:types` && `npm run build` — clean.
- [ ] **Step 3: Rust (confirm no regression — no Rust changed).** Per existing CI: launcher `cargo test` + `cargo clippy -- -D warnings` (via `cross`). Expect unchanged-green.
- [ ] **Step 4: Self-review the diff** for any accidental Windows-path behavior change (handleInstall win32 branch, the install-poll navigate branch). Confirm byte-identical.
- [ ] **Step 5: CHANGELOG** — add a `[Unreleased]` section: the 7 fixes + the bookmark global-dismiss.
- [ ] **Step 6: Version bump** via the bump script (`reference_wsscrcpy_version_bump`) → v0.1.30-beta.31; confirm it syncs `Cargo.lock` (item 40 gap — if it doesn't, sync manually).
- [ ] **Step 7: PR** (release:beta label) → auto-release pipeline → beta.31. **Then the user resumes the Fedora smoke** (system-scope uninstall: teardown fires, no AVC, /opt+fcontext gone; single instance after install; same-port reconnect; service modal on first install; bookmark global-dismiss; radio contrast).

---

## Self-Review (writing-plans)

**Spec coverage:** #1 Task 1 · #2 Tasks 2+3 · #3 Task 4 · #4 Task 5 · #5 (precedence already in `index.ts`, verified) Tasks 6-9 (the net-new global-dismiss + storage + reset) · #6 Task 10 · #7 Task 11 · regression+cut Task 12. All spec items covered.

**Type consistency:** `STAGED_SYSTEM_HELPER` (Task 2) reused in Task 3. `linuxHelperSource` opt (Task 2) added to `ServiceInstallOptions`. `bookmarkDismissedGlobally` (Task 6) consumed by Tasks 7/8/9. `classifyInstallPoll` / `shouldShowBookmark` / `resetPromptsPayload` are new exported helpers — names consistent across tasks.

**Open detail flagged for implementation:** the `ServiceInstallOptions` type location (Task 2 — add `linuxHelperSource?`); the exact `Config.ts` flat↔app mapping spots for the new flag (Task 6); whether a reusable `ConfirmModal` exists or must be created (Task 8). Each is a "locate during the task" item, not a placeholder for unspecified behavior.
