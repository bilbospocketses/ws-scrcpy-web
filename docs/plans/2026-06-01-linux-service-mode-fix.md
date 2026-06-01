# Linux Service-Mode Fix (items 32 + 33) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Linux service install/uninstall functional in both scopes — system-scope installs and runs under SELinux (item 33), and uninstall (both scopes) tears down cleanly and returns to local mode (item 32).

**Architecture:** System-scope install stages the AppImage to a root-owned, `bin_t`-labelled `/opt/ws-scrcpy-web/` copy so `init_t` can exec it. Uninstall stops doing `systemctl disable --now` from inside its own cgroup; instead it hands off to an out-of-cgroup helper launched via `systemd-run` (a transient unit) that stops → disables → `reset-failed` → removes the unit (+ `/opt` for system) → reaps the escaped adb daemon → relaunches local (user scope) / cleanly tears down (system scope). This is the systemd analogue of the Windows operation-server/post-stop handoff.

**Tech Stack:** TypeScript (Node server, vitest), Rust (the launcher binary, cargo), systemd (`systemctl`/`systemd-run`), SELinux (`semanage`/`restorecon`/`chcon`), pkexec/polkit.

**Scope guard:** Windows and Linux **local** mode are untouched. Phase 2 (service-mode in-app updates) is a **separate plan**, written only after this one is verified on real Fedora. Spec: `docs/specs/2026-06-01-linux-service-mode-fix-and-update-design.md`.

---

## File Structure

**New files:**
- `src/server/service/systemTools.ts` — pure resolver mapping an OS tool name (`systemctl`, `pkexec`, `loginctl`, `ldconfig`, `systemd-run`) to its first existing absolute path (`/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`), with a documented bare-name fallback. Closes the PATH-hijack surface (Local-Dependencies-Only). One responsibility: tool-path resolution.
- `src/server/service/systemTools.test.ts` — resolver unit tests.
- `launcher/src/linux_service.rs` — `#[cfg(target_os = "linux")]` module: the `--linux-service-teardown` helper. Pure command-sequence builders + a thin exec seam. One responsibility: out-of-cgroup service teardown.

**Modified files:**
- `src/server/service/SystemdClient.ts` — system-scope staging (`/opt` copy + `bin_t` label) inside the pkexec install command; `renderUnitFile`/install render `ExecStart` = staged path for system scope; convert bare-name OS-tool calls to `systemTools`. Add `stagedSystemBinPath()` + `localAppImageMarkerPath()` helpers.
- `src/server/api/ServiceApi.ts` — Linux install: write the `local-appimage` marker (home `$APPIMAGE`, for the user-scope relaunch). Linux uninstall: revert `installMode → local`, then `systemd-run` the teardown helper instead of calling `client.uninstall()` synchronously.
- `launcher/src/main.rs` — dispatch `--linux-service-teardown` (Linux only), before the normal-launch path.
- `src/app/client/SettingsModal.ts` — handle the Linux uninstall response: user scope reconnects to the relaunched local instance; system scope shows a "service removed" message.

**Verification checkpoints (manual, on real Fedora):** after Task 6 (system install runs, no AVC) and after Task 13 (uninstall clean + relaunch).

---

## Task 1: OS-tool absolute-path resolver

**Files:**
- Create: `src/server/service/systemTools.ts`
- Test: `src/server/service/systemTools.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/service/systemTools.test.ts
import { describe, it, expect } from 'vitest';
import { resolveSystemTool } from './systemTools';

describe('resolveSystemTool', () => {
    it('returns the first candidate that exists', () => {
        const exists = (p: string) => p === '/usr/bin/systemctl';
        expect(resolveSystemTool('systemctl', exists)).toBe('/usr/bin/systemctl');
    });

    it('prefers /usr/bin over /bin when both exist', () => {
        const exists = (p: string) => p === '/usr/bin/pkexec' || p === '/bin/pkexec';
        expect(resolveSystemTool('pkexec', exists)).toBe('/usr/bin/pkexec');
    });

    it('checks sbin locations for admin tools (semanage/restorecon)', () => {
        const exists = (p: string) => p === '/usr/sbin/semanage';
        expect(resolveSystemTool('semanage', exists)).toBe('/usr/sbin/semanage');
    });

    it('falls back to the bare name when no absolute path exists', () => {
        const exists = (_p: string) => false;
        expect(resolveSystemTool('systemctl', exists)).toBe('systemctl');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/service/systemTools.test.ts`
Expected: FAIL — `Cannot find module './systemTools'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/server/service/systemTools.ts
/**
 * Resolve an OS tool to its absolute path, scanning the canonical bin/sbin
 * locations in priority order. Closes the PATH-hijack surface required by the
 * Local-Dependencies-Only rule: we never invoke systemctl/pkexec/etc. by bare
 * name (which would resolve via $PATH). Falls back to the bare name only when
 * no absolute candidate exists, so the failure surfaces as a clear ENOENT
 * rather than a silent miss.
 */
import * as fs from 'node:fs';

/** Search order: user bins first (/usr/bin, /bin), then admin bins (/usr/sbin, /sbin). */
const SEARCH_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'] as const;

export function resolveSystemTool(
    tool: string,
    exists: (p: string) => boolean = fs.existsSync,
): string {
    for (const dir of SEARCH_DIRS) {
        const candidate = `${dir}/${tool}`;
        if (exists(candidate)) return candidate;
    }
    return tool;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/service/systemTools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/service/systemTools.ts src/server/service/systemTools.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): absolute-path resolver for OS tools (Local-Deps)"
```

---

## Task 2: SystemdClient — staged system-scope binary path + helpers

**Files:**
- Modify: `src/server/service/SystemdClient.ts`
- Test: `src/server/service/SystemdClient.test.ts`

- [ ] **Step 1: Write the failing test** (append to the existing describe block)

```typescript
// src/server/service/SystemdClient.test.ts
import { SystemdClient, renderUnitFile, STAGED_SYSTEM_DIR } from './SystemdClient';

describe('system-scope staging', () => {
    const baseOpts = {
        name: 'WsScrcpyWeb',
        displayName: 'ws-scrcpy-web',
        description: 'desc',
        binPath: '/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage', // source = home AppImage
        startupDir: '/home/u/Apps',
        startType: 'Automatic' as const,
        maxRestartAttempts: 3,
        envVars: { DEPS_PATH: '/home/u/.local/share/WsScrcpyWeb/dependencies' },
        logPath: '/home/u/.local/share/WsScrcpyWeb/logs/service.log',
    };

    it('stagedSystemBinPath is the fixed /opt path', () => {
        const c = new SystemdClient();
        expect(c.stagedSystemBinPath()).toBe(`${STAGED_SYSTEM_DIR}/WsScrcpyWeb.AppImage`);
    });

    it('system unit ExecStart points at the staged /opt path, not the home AppImage', () => {
        const unit = renderUnitFile(baseOpts, 'system');
        expect(unit).toContain(`ExecStart=${STAGED_SYSTEM_DIR}/WsScrcpyWeb.AppImage`);
        expect(unit).not.toContain('/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage');
    });

    it('user unit ExecStart still points at the home AppImage (unchanged)', () => {
        const unit = renderUnitFile(baseOpts, 'user');
        expect(unit).toContain('ExecStart=/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/service/SystemdClient.test.ts -t "system-scope staging"`
Expected: FAIL — `STAGED_SYSTEM_DIR` / `stagedSystemBinPath` not exported.

- [ ] **Step 3: Write the implementation**

Add the constant near the top of `SystemdClient.ts` (after `TRAY_AUTOSTART_FILE`):

```typescript
/** Root-owned staging dir for the system-scope AppImage (SELinux bin_t — init_t can exec). */
export const STAGED_SYSTEM_DIR = '/opt/ws-scrcpy-web';
/** Stable, channel-agnostic filename for the staged system-scope AppImage. */
export const STAGED_SYSTEM_APPIMAGE = 'WsScrcpyWeb.AppImage';
```

Change `renderUnitFile` so system scope uses the staged path for `ExecStart` + `WorkingDirectory` (the source `opts.binPath` is only the copy source; the unit must reference the staged file):

```typescript
export function renderUnitFile(opts: ServiceInstallOptions, scope: SystemdScope): string {
    const envLines = Object.entries(opts.envVars)
        .map(([k, v]) => `Environment=${k}=${v}`)
        .join('\n');
    const wantedBy = scope === 'user' ? 'default.target' : 'multi-user.target';
    // System scope runs under init_t and may NOT exec a user_home_t AppImage,
    // so the unit references the staged /opt copy (labelled bin_t at install).
    // User scope runs as the unconfined user and execs the home AppImage directly.
    const execStart = scope === 'system'
        ? `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`
        : opts.binPath;
    const workingDir = scope === 'system' ? STAGED_SYSTEM_DIR : opts.startupDir;
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
}
```

Add the public accessor inside the `SystemdClient` class (near `userUnitPath`):

```typescript
    /** Absolute path of the staged system-scope AppImage (system scope ExecStart). */
    public stagedSystemBinPath(): string {
        return path.join(STAGED_SYSTEM_DIR, STAGED_SYSTEM_APPIMAGE);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/service/SystemdClient.test.ts -t "system-scope staging"`
Expected: PASS (3 tests). Re-run the whole file to confirm no regressions: `npx vitest run src/server/service/SystemdClient.test.ts`.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/service/SystemdClient.ts src/server/service/SystemdClient.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): system-scope unit ExecStart points at staged /opt AppImage (item 33)"
```

---

## Task 3: SystemdClient — stage + label the AppImage in the system-scope install

**Files:**
- Modify: `src/server/service/SystemdClient.ts` (the `install()` system-scope branch + `runPkexec` callers use absolute tool paths)
- Test: `src/server/service/SystemdClient.test.ts`

The current system-scope branch (no root) writes the unit to a tmp file and runs one pkexec shell command (`cp tmp unit && daemon-reload && enable`). Extend that single shell command to also stage + label the AppImage **before** writing the unit. Build the command via a pure, testable helper so we can assert its shape without running pkexec.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/service/SystemdClient.test.ts
import { buildSystemInstallScript } from './SystemdClient';

describe('buildSystemInstallScript', () => {
    const args = {
        sourceAppImage: '/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage',
        unitTmpPath: '/tmp/WsScrcpyWeb.service.tmp',
        unitPath: '/etc/systemd/system/WsScrcpyWeb.service',
        name: 'WsScrcpyWeb',
    };

    it('stages the AppImage to /opt, chmods, labels bin_t, then installs the unit', () => {
        const script = buildSystemInstallScript(args);
        // staging
        expect(script).toContain('mkdir -p /opt/ws-scrcpy-web');
        expect(script).toContain('cp "/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage" "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
        expect(script).toContain('chmod 0755 "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
        // SELinux label: persistent semanage rule + restorecon, chcon fallback
        expect(script).toContain("semanage fcontext -a -t bin_t '/opt/ws-scrcpy-web(/.*)?'");
        expect(script).toContain('restorecon -Rv /opt/ws-scrcpy-web');
        expect(script).toContain('chcon -t bin_t "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"');
        // unit install
        expect(script).toContain('cp "/tmp/WsScrcpyWeb.service.tmp" "/etc/systemd/system/WsScrcpyWeb.service"');
        expect(script).toContain('systemctl daemon-reload');
        expect(script).toContain('systemctl enable --now WsScrcpyWeb.service');
    });

    it('staging precedes the unit copy (so ExecStart target exists before enable)', () => {
        const script = buildSystemInstallScript(args);
        expect(script.indexOf('/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage'))
            .toBeLessThan(script.indexOf('enable --now'));
    });

    it('uses absolute tool paths (no bare names)', () => {
        const script = buildSystemInstallScript(args, (t) => `/usr/bin/${t}`, (t) => `/usr/sbin/${t}`);
        expect(script).toContain('/usr/bin/systemctl daemon-reload');
        expect(script).toContain('/usr/sbin/restorecon -Rv');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/service/SystemdClient.test.ts -t "buildSystemInstallScript"`
Expected: FAIL — `buildSystemInstallScript` not exported.

- [ ] **Step 3: Write the implementation**

Add the pure builder (module scope in `SystemdClient.ts`). `semanage`/`restorecon` live in `sbin`; `chcon`/`chmod`/`cp` in `bin`. The `chcon` is a fallback for when `semanage` is absent (`|| chcon …`); `restorecon` is harmless if the semanage rule didn't take. The whole thing is one `&&`-chain so pkexec runs it under a single prompt:

```typescript
import { resolveSystemTool } from './systemTools';

/**
 * Build the privileged shell script for a system-scope install. Runs under a
 * single pkexec prompt. Stages the AppImage into /opt (root-owned), labels it
 * bin_t so init_t may exec it (item 33), then installs + enables the unit.
 * `binTool`/`sbinTool` are injectable for testing; production resolves absolute
 * paths via systemTools (Local-Dependencies-Only — no bare-name $PATH lookup).
 */
export function buildSystemInstallScript(
    args: { sourceAppImage: string; unitTmpPath: string; unitPath: string; name: string },
    binTool: (t: string) => string = (t) => resolveSystemTool(t),
    sbinTool: (t: string) => string = (t) => resolveSystemTool(t),
): string {
    const staged = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
    const cp = binTool('cp');
    const chmod = binTool('chmod');
    const chcon = binTool('chcon');
    const systemctl = binTool('systemctl');
    const semanage = sbinTool('semanage');
    const restorecon = sbinTool('restorecon');
    return [
        // 1. stage the AppImage into /opt (root-owned)
        `mkdir -p ${STAGED_SYSTEM_DIR}`,
        `${cp} "${args.sourceAppImage}" "${staged}"`,
        `${chmod} 0755 "${staged}"`,
        // 2. label bin_t so init_t can exec it. Persistent rule (semanage) when
        //    available; restorecon applies it; chcon is the transient fallback
        //    for minimal images without policycoreutils-python-utils.
        `( ${semanage} fcontext -a -t bin_t '${STAGED_SYSTEM_DIR}(/.*)?' && ${restorecon} -Rv ${STAGED_SYSTEM_DIR} ) || ${chcon} -t bin_t "${staged}"`,
        // 3. install + enable the unit (ExecStart already points at ${staged})
        `${cp} "${args.unitTmpPath}" "${args.unitPath}"`,
        `${systemctl} daemon-reload`,
        `${systemctl} enable --now ${args.name}.service`,
    ].join(' && ');
}
```

Rewrite the system-scope branch of `install()` to use it (replacing the inline `cmd` array). The source AppImage is `opts.binPath` (the home `$APPIMAGE` ServiceApi passes):

```typescript
        if (scope === 'system' && process.getuid?.() !== 0) {
            const tmpFile = path.join(os.tmpdir(), `${opts.name}.service.tmp`);
            fs.writeFileSync(tmpFile, unitContent, { mode: 0o644 });
            try {
                const cmd = buildSystemInstallScript({
                    sourceAppImage: opts.binPath,
                    unitTmpPath: tmpFile,
                    unitPath,
                    name: opts.name,
                });
                await runPkexec(cmd, 'install (system scope)');
            } finally {
                try { fs.unlinkSync(tmpFile); } catch { /* best-effort cleanup */ }
            }
        } else {
```

(The `else` user-scope branch is unchanged in this task.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/service/SystemdClient.test.ts`
Expected: PASS (all, including the new `buildSystemInstallScript` block).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/service/SystemdClient.ts src/server/service/SystemdClient.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): stage + bin_t-label AppImage in system-scope install (item 33)"
```

---

## Task 4: SystemdClient — convert the remaining bare-name OS-tool calls to absolute paths

**Files:**
- Modify: `src/server/service/SystemdClient.ts` (the `runSystemctl`, `loginctl`, `is-active`, user-scope `runPkexec` callers)
- Test: `src/server/service/SystemdClient.test.ts` (assert `runSystemctl` invokes the resolved absolute path)

- [ ] **Step 1: Write the failing test**

```typescript
// SystemdClient.test.ts — verify systemctl is invoked by absolute path.
import { systemctlArgv } from './SystemdClient';

describe('absolute-path OS tools', () => {
    it('systemctlArgv resolves systemctl to an absolute path', () => {
        const argv = systemctlArgv(['--user', 'daemon-reload'], (t) => `/usr/bin/${t}`);
        expect(argv.bin).toBe('/usr/bin/systemctl');
        expect(argv.args).toEqual(['--user', 'daemon-reload']);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/service/SystemdClient.test.ts -t "absolute-path OS tools"`
Expected: FAIL — `systemctlArgv` not exported.

- [ ] **Step 3: Write the implementation**

Add the helper and route `runSystemctl` + the `is-active` call + `loginctl` through it. `execFile`'s first arg becomes the resolved path:

```typescript
/** Resolve systemctl to an absolute path + return the (bin, args) pair for execFile. */
export function systemctlArgv(
    args: string[],
    resolve: (t: string) => string = (t) => resolveSystemTool(t),
): { bin: string; args: string[] } {
    return { bin: resolve('systemctl'), args };
}
```

In `runSystemctl`, replace `execFileSync('systemctl', args, …)` with:

```typescript
    const { bin, args: a } = systemctlArgv(args);
    try {
        return execFileSync(bin, a, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    } catch (err) {
        // …unchanged error handling…
    }
```

In `status()` replace `execFileSync('systemctl', [...])` similarly. In `install()`'s user-scope linger call, replace `execFileSync('loginctl', …)` with `execFileSync(resolveSystemTool('loginctl'), …)`. In `runPkexec`, replace `execFileAsync('pkexec', …)` with `execFileAsync(resolveSystemTool('pkexec'), …)`. In `isLibfuse2Installed`/`libfuse2InstallCmd`, replace `execFileSync('ldconfig', …)` with `execFileSync(resolveSystemTool('ldconfig'), …)`.

Add `import { resolveSystemTool } from './systemTools';` if not already present from Task 3.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/service/SystemdClient.test.ts`
Expected: PASS. Then `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/service/SystemdClient.ts src/server/service/SystemdClient.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "refactor(linux): resolve systemctl/pkexec/loginctl/ldconfig by absolute path (Local-Deps)"
```

---

## Task 5: ServiceApi — record the home AppImage at install (for the user-scope uninstall relaunch)

**Files:**
- Modify: `src/server/api/ServiceApi.ts` (`handleInstall`, Linux branch — after computing `binPath`)
- Modify: `src/server/service/SystemdClient.ts` (add `localAppImageMarkerPath(dataRoot)` helper + a `writeLocalAppImageMarker` static, or inline in ServiceApi)
- Test: `src/server/api/ServiceApi.test.ts`

The teardown (Task 9) relaunches the home AppImage in local mode on user-scope uninstall. The service process won't know that path later (system scope runs `/opt`), so capture it at install time as a `dataRoot/control/local-appimage` marker.

- [ ] **Step 1: Write the failing test**

```typescript
// src/server/api/ServiceApi.test.ts — Linux install records the home AppImage path.
it('linux install writes the local-appimage marker with $APPIMAGE', async () => {
    const writes: Record<string, string> = {};
    // …use the existing ServiceApi test harness (injected factory + fs mock)…
    process.env.APPIMAGE = '/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage';
    // invoke handleInstall with platform 'linux', scope 'user'
    // assert the marker file path + contents:
    expect(writes['<dataRoot>/control/local-appimage'])
        .toBe('/home/u/Apps/WsScrcpyWeb-linux-beta.AppImage');
});
```

(Adapt to the existing `ServiceApi.test.ts` harness — it already injects a fake factory and an `existsCheck`; add an injectable marker-writer or assert via a spy on `fs.writeFileSync`/`fs.promises.writeFile`. Mirror however the existing install tests assert side effects.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/api/ServiceApi.test.ts -t "local-appimage marker"`
Expected: FAIL — marker not written.

- [ ] **Step 3: Write the implementation**

In `ServiceApi.handleInstall`, Linux branch, after `binPath`/`startupDir` are set and before `result.client.install(...)`, write the marker (best-effort; failure logs but doesn't fail the install):

```typescript
        // Record the home AppImage path so a later user-scope uninstall can
        // relaunch the app in local mode. System scope runs the /opt copy and
        // won't know the user's home AppImage otherwise.
        if (result.platform === 'linux') {
            const appImage = process.env['APPIMAGE'];
            if (appImage && appImage.length > 0) {
                const markerPath = path.join(
                    path.dirname(cfg.dependenciesPath), 'control', 'local-appimage',
                );
                try {
                    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
                    fs.writeFileSync(markerPath, appImage, 'utf8');
                } catch (err) {
                    log.warn(`could not write local-appimage marker: ${(err as Error).message}`);
                }
            }
        }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/server/api/ServiceApi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/ServiceApi.ts src/server/api/ServiceApi.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): record home AppImage path at service install (uninstall relaunch)"
```

---

## Task 6: VERIFY ON FEDORA — system-scope install runs under SELinux (item 33)

**Files:** none (manual verification; the implementation must be built + packaged into a beta first).

- [ ] **Step 1: Build + cut a verification beta** (per the project's release-cycle convention — tag a fix beta, let CI publish).

- [ ] **Step 2: On real Fedora (enforcing SELinux), install system scope** via Settings → install → "system". Enter the pkexec password.

- [ ] **Step 3: Confirm the service is active and SELinux is quiet**

Run on Fedora:
```bash
systemctl is-active WsScrcpyWeb.service        # expect: active
ls -Z /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage  # expect: ...:bin_t:...
sudo ausearch -m avc -ts recent | grep -i wsscrcpy   # expect: no new denials
```
Expected: `active`, label `bin_t`, no AVC. **If denied:** capture `ausearch` output; the label or a transition is wrong — adjust Task 3's labelling (this is the spec's flagged verify-on-Fedora item ①) before proceeding.

- [ ] **Step 4: Confirm the app is reachable** on its web port from a browser; the home page loads.

- [ ] **Step 5: No commit** (verification only). Record the result in the PR / breadcrumb.

---

## Task 7: Rust — `--linux-service-teardown` command builders (pure)

**Files:**
- Create: `launcher/src/linux_service.rs`
- Modify: `launcher/src/main.rs` (declare `mod linux_service;` under the existing `#[cfg(target_os = "linux")]`)

Build the teardown as pure, testable command-sequence builders first; wire execution in Task 8.

- [ ] **Step 1: Write the failing test**

```rust
// launcher/src/linux_service.rs  (#[cfg(test)] mod tests)
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_scope_teardown_sequence() {
        let cmds = teardown_commands(Scope::User, "WsScrcpyWeb", "/usr/bin");
        // order: stop -> disable -> reset-failed -> rm unit -> daemon-reload
        let joined: Vec<String> = cmds.iter().map(|c| c.join(" ")).collect();
        assert!(joined[0].contains("--user stop WsScrcpyWeb.service"));
        assert!(joined.iter().any(|c| c.contains("--user disable WsScrcpyWeb.service")));
        assert!(joined.iter().any(|c| c.contains("--user reset-failed WsScrcpyWeb.service")));
        assert!(joined.iter().any(|c| c.contains("--user daemon-reload")));
        // user scope does NOT touch /opt
        assert!(!joined.iter().any(|c| c.contains("/opt/ws-scrcpy-web")));
    }

    #[test]
    fn system_scope_teardown_removes_opt_and_fcontext() {
        let cmds = teardown_commands(Scope::System, "WsScrcpyWeb", "/usr/bin");
        let joined: Vec<String> = cmds.iter().map(|c| c.join(" ")).collect();
        assert!(joined.iter().any(|c| c.contains("stop WsScrcpyWeb.service") && !c.contains("--user")));
        assert!(joined.iter().any(|c| c.contains("rm") && c.contains("/opt/ws-scrcpy-web")));
        assert!(joined.iter().any(|c| c.contains("semanage fcontext -d")));
    }

    #[test]
    fn unit_path_is_scope_correct() {
        assert_eq!(unit_path(Scope::System, "WsScrcpyWeb"),
                   std::path::PathBuf::from("/etc/systemd/system/WsScrcpyWeb.service"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p launcher --lib linux_service` (from `C:/Users/jscha/source/repos/ws-scrcpy-web/launcher` — or `cargo test` at repo root if the workspace wires it).
Expected: FAIL — module/functions don't exist.

> Note: this module is `#[cfg(target_os = "linux")]`; the tests run on the Linux CI leg / a Linux dev box. On Windows the module isn't compiled — that's expected (mirrors `linux_apply.rs`).

- [ ] **Step 3: Write the implementation**

```rust
// launcher/src/linux_service.rs
// §item32 — out-of-cgroup Linux service teardown. Launched via `systemd-run`
// from the Node server so it runs in its OWN transient unit, surviving the
// stop of the service unit it tears down (the service Node lives in that
// cgroup; calling systemctl stop from there kills itself mid-call — the
// root of item 32). Mirrors the Windows operation-server/post-stop handoff.

use std::path::{Path, PathBuf};
use crate::log;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope { User, System }

/// `--user` prefix tokens for user scope, empty for system scope.
fn scope_prefix(scope: Scope) -> Vec<String> {
    match scope {
        Scope::User => vec!["--user".to_string()],
        Scope::System => vec![],
    }
}

pub fn unit_path(scope: Scope, name: &str) -> PathBuf {
    match scope {
        Scope::User => {
            let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
            PathBuf::from(home).join(".config/systemd/user").join(format!("{name}.service"))
        }
        Scope::System => PathBuf::from("/etc/systemd/system").join(format!("{name}.service")),
    }
}

/// Ordered command argv-vectors for the teardown. `bindir` is the resolved
/// absolute bin dir (e.g. "/usr/bin") so we never invoke tools by bare name.
pub fn teardown_commands(scope: Scope, name: &str, bindir: &str) -> Vec<Vec<String>> {
    let systemctl = format!("{bindir}/systemctl");
    let rm = format!("{bindir}/rm");
    let pre = scope_prefix(scope);
    let unit = format!("{name}.service");
    let unit_file = unit_path(scope, name);

    let mut cmds: Vec<Vec<String>> = Vec::new();
    // stop (synchronous; reaps the in-cgroup launcher+Node+children), disable, reset-failed
    cmds.push([vec![systemctl.clone()], pre.clone(), vec!["stop".into(), unit.clone()]].concat());
    cmds.push([vec![systemctl.clone()], pre.clone(), vec!["disable".into(), unit.clone()]].concat());
    cmds.push([vec![systemctl.clone()], pre.clone(), vec!["reset-failed".into(), unit.clone()]].concat());
    // remove the unit file
    cmds.push(vec![rm.clone(), "-f".into(), unit_file.to_string_lossy().into_owned()]);
    // system scope also removes the /opt staging + the semanage fcontext rule
    if scope == Scope::System {
        cmds.push(vec![rm.clone(), "-rf".into(), "/opt/ws-scrcpy-web".into()]);
        cmds.push(vec![
            format!("{bindir}/../sbin/semanage").replace("/bin/../sbin", "/sbin"),
            "fcontext".into(), "-d".into(), "/opt/ws-scrcpy-web(/.*)?".into(),
        ]);
    }
    // reload
    cmds.push([vec![systemctl.clone()], pre.clone(), vec!["daemon-reload".into()]].concat());
    cmds
}

/// Parse `--scope user|system` + `--unit <name>` from argv.
pub fn parse_args(args: &[String]) -> Option<(Scope, String)> {
    let scope = args.iter().position(|a| a == "--scope")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| match s.as_str() {
            "user" => Some(Scope::User),
            "system" => Some(Scope::System),
            _ => None,
        })?;
    let unit = args.iter().position(|a| a == "--unit")
        .and_then(|i| args.get(i + 1))
        .cloned()?;
    Some((scope, unit))
}

let _ = (Path::new("/"), log::info); // keep imports used until Task 8 wires exec
```

> The trailing `let _ = …` line is a placeholder to keep `Path`/`log` imports referenced before Task 8 adds the exec seam; **remove it in Task 8** (it will be replaced by real usage). It exists only so this task compiles in isolation under `-D warnings`.

Add to `main.rs` near the other linux-only module:
```rust
#[cfg(target_os = "linux")]
mod linux_service;
```

- [ ] **Step 4: Run test to verify it passes**

Run (Linux): `cargo test -p launcher --lib linux_service`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/linux_service.rs launcher/src/main.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): service-teardown command builders (item 32, pure)"
```

---

## Task 8: Rust — execute the teardown + relaunch, wire the dispatch

**Files:**
- Modify: `launcher/src/linux_service.rs` (add `handle()` + `run()` exec seam, reap, relaunch)
- Modify: `launcher/src/main.rs` (dispatch `--linux-service-teardown`)

- [ ] **Step 1: Write the failing test**

```rust
// linux_service.rs tests — relaunch decision is scope-gated.
#[test]
fn relaunch_only_for_user_scope_with_marker() {
    // user scope + present marker -> Some(path)
    assert_eq!(
        relaunch_target(Scope::User, Some("/home/u/Apps/App.AppImage".into())),
        Some(std::path::PathBuf::from("/home/u/Apps/App.AppImage"))
    );
    // system scope -> never relaunch
    assert_eq!(relaunch_target(Scope::System, Some("/home/u/Apps/App.AppImage".into())), None);
    // user scope, missing marker -> None
    assert_eq!(relaunch_target(Scope::User, None), None);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run (Linux): `cargo test -p launcher --lib linux_service::tests::relaunch_only_for_user_scope`
Expected: FAIL — `relaunch_target` not defined.

- [ ] **Step 3: Write the implementation**

Replace the `let _ = …` placeholder line from Task 7 with:

```rust
/// User scope relaunches the home AppImage (from the install-time marker) into
/// local mode. System scope never auto-relaunches (headless-dominant; the admin
/// re-launches their own AppImage). Returns the path to spawn, or None.
pub fn relaunch_target(scope: Scope, marker: Option<String>) -> Option<PathBuf> {
    match scope {
        Scope::User => marker.map(PathBuf::from).filter(|p| p.exists() || cfg!(test)),
        Scope::System => None,
    }
}

/// Dispatch: handle `--linux-service-teardown`, return Some(exit_code).
pub fn handle(args: &[String]) -> Option<i32> {
    if !args.iter().any(|a| a == "--linux-service-teardown") {
        return None;
    }
    let (scope, unit) = match parse_args(args) {
        Some(v) => v,
        None => { log::error("linux-service-teardown: missing/invalid --scope or --unit"); return Some(2); }
    };
    Some(run(scope, &unit))
}

fn bindir() -> String {
    for d in ["/usr/bin", "/bin"] {
        if Path::new(&format!("{d}/systemctl")).exists() { return d.to_string(); }
    }
    "/usr/bin".to_string()
}

fn run(scope: Scope, unit: &str) -> i32 {
    let bd = bindir();
    log::info(&format!("linux-service-teardown: scope={scope:?} unit={unit}"));

    // 1. run the teardown sequence (best-effort; log non-zero, keep going)
    for argv in teardown_commands(scope, unit, &bd) {
        let (cmd, rest) = argv.split_first().expect("non-empty argv");
        let status = std::process::Command::new(cmd).args(rest).status();
        match status {
            Ok(s) if s.success() => log::info(&format!("teardown ok: {}", argv.join(" "))),
            Ok(s) => log::error(&format!("teardown non-zero ({:?}): {}", s.code(), argv.join(" "))),
            Err(e) => log::error(&format!("teardown spawn failed: {} ({e})", argv.join(" "))),
        }
    }

    // 2. reap the escaped adb daemon (it daemonizes out of the cgroup; the
    //    cgroup stop above does NOT kill it). Bundled adb, absolute path.
    if let Some(data_root) = common::config::data_root_from_env() {
        let adb = data_root.join("dependencies").join("adb").join("adb");
        if adb.exists() {
            let _ = std::process::Command::new(&adb).arg("kill-server").status();
            log::info("teardown: adb kill-server issued");
        }
    }

    // 3. relaunch local (user scope only)
    let marker = read_local_appimage_marker();
    if let Some(target) = relaunch_target(scope, marker) {
        match std::process::Command::new(&target)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
        {
            Ok(c) => log::info(&format!("teardown: relaunched local {target:?} (pid {})", c.id())),
            Err(e) => log::error(&format!("teardown: relaunch failed: {e}")),
        }
    }
    0
}

fn read_local_appimage_marker() -> Option<String> {
    let data_root = common::config::data_root_from_env()?;
    let p = data_root.join("control").join("local-appimage");
    std::fs::read_to_string(p).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}
```

Add the dispatch in `main.rs` after the `linux_apply::handle` block:
```rust
    #[cfg(target_os = "linux")]
    if let Some(code) = linux_service::handle(&args) {
        log::info(&format!("linux-service-teardown exiting with code {code}"));
        std::process::exit(code);
    }
```

- [ ] **Step 4: Run tests + clippy**

Run (Linux):
```bash
cargo test -p launcher --lib linux_service
cargo clippy -p launcher -- -D warnings
```
Expected: tests PASS; clippy clean (no unused imports — the placeholder line is gone).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add launcher/src/linux_service.rs launcher/src/main.rs
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): execute service teardown + relaunch; wire --linux-service-teardown (item 32)"
```

---

## Task 9: ServiceApi — Linux uninstall hands off via systemd-run (no in-cgroup self-stop)

**Files:**
- Modify: `src/server/api/ServiceApi.ts` (`handleUninstall` — add a Linux branch before the generic `client.uninstall()`)
- Test: `src/server/api/ServiceApi.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// ServiceApi.test.ts — Linux uninstall hands off, never calls client.uninstall().
it('linux uninstall reverts installMode and spawns the systemd-run teardown (no direct uninstall)', async () => {
    const spawned: { cmd: string; args: string[] }[] = [];
    const client = { uninstall: vi.fn(), status: vi.fn().mockResolvedValue('stopped'),
                     getInstalledScope: vi.fn().mockResolvedValue('user') /* + other ServiceClient methods */ };
    // inject a spawn spy + a config spy via the test harness; platform 'linux'.
    // POST /api/service/uninstall …
    expect(client.uninstall).not.toHaveBeenCalled();
    expect(spawned[0].cmd).toMatch(/systemd-run$/);
    expect(spawned[0].args).toContain('--user');
    expect(spawned[0].args.join(' ')).toContain('--linux-service-teardown --scope user --unit WsScrcpyWeb');
    // installMode reverted to local
    // (assert via the config spy: updateAppConfig called with installMode 'user')
});
```

(Adapt to the existing harness. `handleUninstall` currently takes no spawn injection; add an injectable spawn function to the `ServiceApi` constructor — default `(cmd, args) => spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref()` — mirroring how `factory`/`scope`/`existsCheck` are injected, so the test can assert the argv without spawning a real process.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/server/api/ServiceApi.test.ts -t "linux uninstall reverts"`
Expected: FAIL — currently calls `client.uninstall()`.

- [ ] **Step 3: Write the implementation**

In `handleUninstall`, after the resume-token block and BEFORE the generic `try { await result.client.uninstall(...) }`, insert a Linux branch. It reverts `installMode → local`, resolves the scope (filesystem truth), then `systemd-run`s the staged helper out of the cgroup and returns `shutting-down`:

```typescript
        if (result.platform === 'linux') {
            const scope = result.client.getInstalledScope
                ? await result.client.getInstalledScope(WS_SCRCPY_SERVICE_NAME)
                : null;
            if (scope === null) {
                // Not installed — nothing to tear down; report success idempotently.
                const body: ServiceActionSuccess = { ok: true, status: 'not-installed', installMode: 'user' };
                res.writeHead(200); res.end(JSON.stringify(body)); return true;
            }

            // Revert installMode to local BEFORE the teardown so the relaunched
            // local instance reads local mode (mirrors the Windows revert-first).
            const newMode: InstallMode = scope === 'system' ? 'system' : 'user';
            try { cfg.updateAppConfig({ installMode: newMode }); }
            catch (err) { log.warn(`uninstall: installMode revert failed: ${(err as Error).message}`); }

            // Hand off to an OUT-OF-CGROUP helper. The service Node lives in the
            // unit's cgroup; running `systemctl stop` here kills us mid-call
            // (item 32). systemd-run launches the helper in its own transient
            // unit, which survives stopping our unit. User scope uses the user
            // manager; system scope is already root so it uses the system manager.
            const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
            const helper = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher');
            const systemdRun = resolveSystemTool('systemd-run');
            const sdArgs = [
                ...(scope === 'user' ? ['--user'] : []),
                '--collect',
                `--unit=wsscrcpy-teardown-${Date.now()}`,
                helper,
                '--linux-service-teardown', '--scope', scope, '--unit', WS_SCRCPY_SERVICE_NAME,
            ];
            this.spawnDetached(systemdRun, sdArgs);
            log.info(`uninstall(linux): spawned teardown helper via systemd-run (${scope} scope)`);

            const body: ServiceActionSuccess = { ok: true, status: 'shutting-down', installMode: newMode };
            res.writeHead(200); res.end(JSON.stringify(body)); return true;
        }
```

Add `resolveSystemTool` import + an injectable `spawnDetached` on the constructor (default spawns detached + unref). Add `import { resolveSystemTool } from '../service/systemTools';`.

> **Verify-on-Fedora flag (spec item ②/⑤):** the exact `systemd-run` argv — esp. whether `--user` needs `--scope` instead of a transient `--unit` on this cgroup-v2 host, and whether `--collect` is accepted — is confirmed in Task 13. The shape above is the best-known form.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/server/api/ServiceApi.test.ts` then `npx tsc --noEmit`
Expected: PASS; no type errors. Confirm the Windows uninstall tests are unchanged/green (the Linux branch is gated on `result.platform === 'linux'`).

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/server/api/ServiceApi.ts src/server/api/ServiceApi.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): uninstall hands off to out-of-cgroup systemd-run teardown (item 32)"
```

---

## Task 10: Client — handle the Linux uninstall response (reconnect / removed)

**Files:**
- Modify: `src/app/client/SettingsModal.ts` (the uninstall click handler)
- Test: `src/app/client/SettingsModal.test.ts` (if present; else a focused jsdom test for the response handler)

- [ ] **Step 1: Write the failing test**

```typescript
// A focused test for the uninstall-response handler. status 'shutting-down' +
// installMode 'user' -> shows reconnect overlay; 'system' -> shows "service removed".
import { describe, it, expect } from 'vitest';
import { uninstallFollowupMessage } from './SettingsModal';

describe('uninstallFollowupMessage', () => {
    it('user scope → reconnect message', () => {
        expect(uninstallFollowupMessage('user')).toMatch(/relaunch|reconnect|local/i);
    });
    it('system scope → service removed message', () => {
        expect(uninstallFollowupMessage('system')).toMatch(/removed|stopped/i);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/app/client/SettingsModal.test.ts -t "uninstallFollowupMessage"`
Expected: FAIL — function not exported.

- [ ] **Step 3: Write the implementation**

Add an exported pure helper + use it in the uninstall handler where the response `status === 'shutting-down'`:

```typescript
/** Follow-up copy shown after a Linux service uninstall begins, by scope. */
export function uninstallFollowupMessage(mode: 'user' | 'system'): string {
    return mode === 'system'
        ? 'service removed. the system service has been stopped — relaunch the app manually to use local mode.'
        : 'service removed. relaunching the app in local mode — this page will reconnect shortly.';
}
```

In the uninstall handler, when the response is `{ status: 'shutting-down' }` on Linux, render `uninstallFollowupMessage(installMode === 'system-service' || installMode === 'system' ? 'system' : 'user')` and (user scope) begin the existing reconnect/poll used after apply. Keep it lowercase per the app motif.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/app/client/SettingsModal.test.ts` then `npx tsc --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 5: Commit**

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" add src/app/client/SettingsModal.ts src/app/client/SettingsModal.test.ts
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -m "feat(linux): uninstall follow-up UX (reconnect / service-removed)"
```

---

## Task 11: Full suite + build green (regression fence)

**Files:** none (verification).

- [ ] **Step 1: Run the full TS suite**

Run: `npm test`
Expected: all green — **especially the Windows + Linux-local service/apply tests** (the freeze guardrail; the Linux branches are gated, Windows paths untouched).

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Rust suite + clippy (Linux leg)**

Run: `cargo test` and `cargo clippy -- -D warnings`
Expected: green (the new `linux_service` tests run on the Linux leg; the module is `#[cfg(target_os = "linux")]`).

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: webpack builds dist/ with no errors.

- [ ] **Step 5: Commit** (only if any fixups were needed)

```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" commit -am "test: full suite green for linux service-mode fix"
```

---

## Task 12: VERIFY ON FEDORA — uninstall tears down cleanly (item 32)

**Files:** none (manual verification; rebuild + cut the verification beta first).

- [ ] **Step 1: User scope** — with a user-scope service installed and the browser on the service port, click uninstall.

- [ ] **Step 2: Confirm clean teardown + relaunch**

Run on Fedora:
```bash
systemctl --user status WsScrcpyWeb.service    # expect: not-found / inactive (unit removed)
ls ~/.config/systemd/user/WsScrcpyWeb.service  # expect: No such file
pgrep -af 'WsScrcpyWeb|scrcpy-server|adb'       # expect: only the relaunched LOCAL AppImage (+ its adb), no orphans
```
Expected: unit gone, no orphaned service process, the page reconnects to the relaunched local instance.

- [ ] **Step 3: System scope** — install system scope, then uninstall.

Run on Fedora:
```bash
systemctl status WsScrcpyWeb.service           # expect: not-found
ls /opt/ws-scrcpy-web                           # expect: No such file (staging removed)
sudo semanage fcontext -l | grep ws-scrcpy-web  # expect: no rule (fcontext -d ran)
sudo ausearch -m avc -ts recent | grep -i wsscrcpy   # expect: no restart-loop AVC
```
Expected: unit + `/opt` staging + fcontext rule all gone; the restart-loop AVC from item 33 does not recur. Browser shows the "service removed" message.

- [ ] **Step 4:** If the `systemd-run` argv from Task 9 failed (check the launcher log + `journalctl --user -u 'wsscrcpy-teardown-*'`), adjust the flags (cgroup-v2 `--scope` vs transient `--unit`, `--collect` support) and re-verify. This is the spec's verify-on-Fedora item ⑤.

- [ ] **Step 5: No commit** (verification). Record results in the PR / breadcrumb; this gates writing the Phase 2 plan.

---

## Self-Review

- **Spec coverage:** item 33 staging → Tasks 2–3 + Fedora Task 6; item 32 teardown → Tasks 7–9 + Fedora Task 12; Local-Deps absolute paths → Tasks 1, 3, 4, 7–8; user-scope relaunch marker → Tasks 5, 8; client UX → Task 10; regression fence → Task 11. Phase 2 (updates) intentionally excluded — separate plan.
- **Windows/local freeze:** every Linux change is gated (`platform === 'linux'`, `#[cfg(target_os = "linux")]`, `scope`-branched `renderUnitFile`); Task 11 asserts the Windows + Linux-local suites stay green.
- **Type consistency:** `Scope::{User,System}` (Rust) ↔ `'user'|'system'` (TS `scope`); `STAGED_SYSTEM_DIR`/`STAGED_SYSTEM_APPIMAGE` reused across Tasks 2/3; `teardown_commands`/`relaunch_target`/`parse_args` defined Task 7 and used Task 8; `resolveSystemTool` defined Task 1 and used Tasks 3/4/9.
- **Empirical flags:** the SELinux label (Task 6) and the exact `systemd-run` argv (Task 12) are the spec's verify-on-Fedora items; the plan writes the best-known concrete form and gates Phase 2 on confirming them, rather than leaving placeholders.
