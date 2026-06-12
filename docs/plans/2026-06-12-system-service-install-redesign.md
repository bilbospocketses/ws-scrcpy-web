# Linux system-service install redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the in-app `pkexec sh -c "<script>"` (kill-on-timeout) system-service install with one privileged TS core reached via `sudo ./WsScrcpyWeb --install-system-service` (headless) or a single awaited `pkexec ./WsScrcpyWeb --install-system-service` (desktop), removing the `kill EPERM` class by construction.

**Architecture:** The Rust launcher gains `--install-system-service` / `--uninstall-system-service` / `--system-service-status` dispatchers that run the Node server in a one-shot mode (do the op as root, then exit). The privileged work is a self-contained TS core (`installSystemService`/`uninstallSystemService`, assert `euid==0`) behind an injected command-runner. The desktop GUI elevates the whole app with one awaited `pkexec` (no timeout, no kill); the running root service self-manages lifecycle. Spec: `docs/specs/2026-06-12-system-service-install-redesign-design.md`.

**Tech Stack:** TypeScript (Node server, vitest), Rust (launcher, `cargo test`), systemd, SELinux (semanage/restorecon), polkit/pkexec.

---

## Design decisions (read first)

1. **Install core lives in TS, not Rust (spec §5).** Reuses `renderUnitFile`, `buildServiceUnitEnv`, `buildSystemSeedConfig` and the already-root branch of `SystemdClient.install`. *Rejected alternative:* re-implement install as native Rust argv (symmetric with `teardown_commands`). Rejected because it duplicates the unit renderer (user-scope install would still use the TS one) for a one-shot, and is the most new code. The privileged path being "the whole app elevated" is fine — Node already runs as root when it IS the service.
2. **The install is SELF-CONTAINED** — it stages the binary+deps to `/opt`, adds the `bin_t` fcontext **itself** (`semanage fcontext -a -t bin_t`), `restorecon`s, writes the unit, and `enable --now`s. It does NOT depend on a prior machine-wide install having added the `bin_t` rule (the current coupling). A headless admin runs ONE command.
3. **Desktop port takeover uses the unit's `Restart=on-failure`/`RestartSec`** + the local copy self-exiting — NOT the `systemd-run --linux-service-install-handoff` helper, which is no longer used by the system path (user-scope keeps it).
4. **`runPkexec`'s `timeout: 60_000` is deleted.** The install no longer shells `pkexec sh -c` from Node at all; the GUI runs `pkexec <appimage> --install-system-service` and awaits the exit code.
5. **Tests assert real argv issued via an injected runner** (the `master_verification_trust` lesson) — never a generated script string.

## File structure

**Created:**
- `src/server/service/systemServiceCli.ts` — the `installSystemService`/`uninstallSystemService`/`systemServiceStatus` core + the `CommandRunner` injection seam + arg parsing. One file, one responsibility (the privileged one-shot ops).
- `src/server/service/__tests__/systemServiceCli.test.ts` — behavior tests for the core.
- `launcher/src/system_service_cli.rs` — the Rust dispatcher: parse `--install/uninstall/system-service-status`, resolve node+entry, spawn `node dist/index.js <flag>` foreground, propagate the exit code.

**Modified:**
- `src/server/service/SystemdClient.ts` — `renderUnitFile` (new unit fields); delete `buildSystemInstallScript`; delete the `timeout` in `runPkexec`; the system-scope branch of `install()` is removed (the core supersedes it).
- `src/server/index.ts` — one-shot mode dispatch at the very top of startup.
- `src/server/api/ServiceApi.ts` — `handleInstall` system-scope → spawn awaited `pkexec <appimage> --install-system-service`; `handleUninstall` system-scope when served-by-service → run the core in-process.
- `launcher/src/main.rs` — three new `#[cfg(linux)]` dispatcher blocks after `main.rs:164`.
- `src/app/client/SettingsModal.ts` — takeover messaging copy only (the poll already exists).
- `src/server/service/__tests__/SystemdClient.test.ts` — delete `buildSystemInstallScript` tests; add `renderUnitFile` tests.
- `docs/smoke-tests/smoke-checklist.md`, `smoke-full.md` — batch #9 rows for the new CLI + desktop takeover.

---

## Phase 1 — The unit file (`renderUnitFile`)

### Task 1: Add `Restart`/`StartLimit`-in-`[Unit]` and the env to the system unit

**Files:**
- Modify: `src/server/service/SystemdClient.ts:247-284` (`renderUnitFile`)
- Test: `src/server/service/__tests__/SystemdClient.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// in SystemdClient.test.ts
import { renderUnitFile } from '../SystemdClient';

describe('renderUnitFile — system scope unit', () => {
    const sysOpts = {
        name: 'WsScrcpyWeb',
        description: 'ws-scrcpy-web',
        binPath: '/home/u/.local/share/WsScrcpyWeb/bin/WsScrcpyWeb.AppImage',
        startupDir: '/home/u',
        maxRestartAttempts: 10,
        envVars: { DATA_ROOT: '/var/lib/ws-scrcpy-web', DEPS_PATH: '/opt/ws-scrcpy-web/dependencies', WS_SCRCPY_SERVICE: '1', WS_SCRCPY_WEB_PORT: '8000' },
        logPath: '/var/lib/ws-scrcpy-web/logs/service.log',
    } as unknown as Parameters<typeof renderUnitFile>[0];

    it('puts StartLimit* in [Unit], Restart=on-failure/RestartSec in [Service], and execs the /opt binary', () => {
        const unit = renderUnitFile(sysOpts, 'system');
        const unitSection = unit.split('[Service]')[0];
        expect(unitSection).toContain('StartLimitIntervalSec=60');
        expect(unitSection).toContain('StartLimitBurst=10');
        // StartLimit must NOT be in [Service]
        const serviceSection = unit.split('[Service]')[1].split('[Install]')[0];
        expect(serviceSection).not.toContain('StartLimit');
        expect(serviceSection).toContain('Restart=on-failure');
        expect(serviceSection).toContain('RestartSec=2');
        expect(serviceSection).toContain('ExecStart=/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage');
        expect(unit).toContain('WantedBy=multi-user.target');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web run test -- SystemdClient`
Expected: FAIL — current `renderUnitFile` emits `StartLimitIntervalSec=300`/`RestartSec=5` and `StartLimit*` under `[Unit]` already (good) but `StartLimitBurst=opts.maxRestartAttempts` and `RestartSec=5`; the `RestartSec=2` assertion fails.

- [ ] **Step 3: Update `renderUnitFile`**

Replace the array body (`SystemdClient.ts:259-283`) so the `[Unit]` block keeps `StartLimitIntervalSec`/`StartLimitBurst` (already there) but the system path uses a 60s window, and `[Service]` uses `RestartSec=2`:

```ts
    return [
        '[Unit]',
        `Description=${opts.description}`,
        scope === 'system' ? 'After=network-online.target' : 'After=network.target',
        ...(scope === 'system' ? ['Wants=network-online.target'] : []),
        scope === 'system' ? 'StartLimitIntervalSec=60' : 'StartLimitIntervalSec=300',
        `StartLimitBurst=${opts.maxRestartAttempts}`,
        '',
        '[Service]',
        'Type=simple',
        `ExecStart=${execStart}`,
        `WorkingDirectory=${workingDir}`,
        'Restart=on-failure',
        scope === 'system' ? 'RestartSec=2' : 'RestartSec=5',
        ...(envLines ? [envLines] : []),
        `StandardOutput=append:${opts.logPath}`,
        `StandardError=append:${opts.logPath}`,
        '',
        '[Install]',
        `WantedBy=${wantedBy}`,
        '',
    ].join('\n');
```

(`StartLimit*` were already correctly in `[Unit]` — the smoke-checked quirk is preserved. `maxRestartAttempts` is passed as `10` for system scope in Task 6's opts.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web run test -- SystemdClient`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/jscha/source/repos/ws-scrcpy-web add src/server/service/SystemdClient.ts src/server/service/__tests__/SystemdClient.test.ts
git -C C:/Users/jscha/source/repos/ws-scrcpy-web commit -m "feat(service): system unit uses Restart=on-failure/RestartSec=2 for the takeover retry"
```

---

## Phase 2 — The privileged TS core (`systemServiceCli.ts`)

This is the heart. The core asserts `euid==0`, takes an injected `CommandRunner`, and issues the exact privileged argv. It reuses `renderUnitFile`/`buildServiceUnitEnv`/`buildSystemSeedConfig` and the constants from `SystemdClient.ts`.

### Task 2: `CommandRunner` seam + `installSystemService`

**Files:**
- Create: `src/server/service/systemServiceCli.ts`
- Test: `src/server/service/__tests__/systemServiceCli.test.ts`

- [ ] **Step 1: Write the failing test** (asserts the ACTUAL argv issued, in order — behavior, not a script string)

```ts
import { describe, it, expect, vi } from 'vitest';
import { installSystemService, type CommandRunner } from '../systemServiceCli';

function recordingRunner() {
    const calls: string[][] = [];
    const run: CommandRunner = vi.fn(async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: '', stderr: '' }; });
    return { run, calls };
}

describe('installSystemService', () => {
    const deps = {
        getuid: () => 0,
        appImageSource: '/tmp/.mount_x/usr/bin/WsScrcpyWeb.AppImage',
        depsSource: '/home/u/.local/share/WsScrcpyWeb/dependencies',
        tool: (t: string) => `/usr/bin/${t}`,
        sbinTool: (t: string) => `/usr/sbin/${t}`,
        writeFile: vi.fn(),
    };

    it('asserts euid==0, stages /opt, adds bin_t, restorecons, writes the unit, enables --now', async () => {
        const { run, calls } = recordingRunner();
        await installSystemService({ port: 8000 }, { ...deps, run });
        const flat = calls.map((c) => c.join(' '));
        // staging
        expect(flat).toContain('/usr/bin/mkdir -p /opt/ws-scrcpy-web');
        expect(flat).toContain('/usr/bin/mkdir -p /var/lib/ws-scrcpy-web');
        expect(flat.some((c) => c.startsWith('/usr/bin/cp ') && c.includes('/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage'))).toBe(true);
        expect(flat).toContain('/usr/bin/chmod 0755 /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage');
        // SELinux: the install adds bin_t ITSELF, then restorecon
        expect(flat).toContain("/usr/sbin/semanage fcontext -a -t bin_t /opt/ws-scrcpy-web(/.*)?");
        expect(flat.some((c) => c.startsWith('/usr/sbin/restorecon -R') && c.includes('/opt/ws-scrcpy-web'))).toBe(true);
        // NO custom rule for /var/lib (var_lib_t by default) — assert we never add one
        expect(flat.some((c) => c.includes('var_lib_t'))).toBe(false);
        // unit + enable
        expect(deps.writeFile).toHaveBeenCalledWith('/etc/systemd/system/WsScrcpyWeb.service', expect.stringContaining('ExecStart=/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage'), expect.anything());
        expect(flat).toContain('/usr/bin/systemctl daemon-reload');
        expect(flat).toContain('/usr/bin/systemctl enable --now WsScrcpyWeb.service');
    });

    it('throws if not root', async () => {
        const { run } = recordingRunner();
        await expect(installSystemService({ port: 8000 }, { ...deps, getuid: () => 1000, run })).rejects.toThrow(/root|euid|sudo/i);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web run test -- systemServiceCli`
Expected: FAIL — `Cannot find module '../systemServiceCli'`.

- [ ] **Step 3: Write `systemServiceCli.ts`**

```ts
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals
import * as fs from 'fs';
import {
    STAGED_SYSTEM_DIR, STAGED_SYSTEM_APPIMAGE, STAGED_SYSTEM_DEPS_DIR, SYSTEM_STATE_DIR,
    renderUnitFile, buildServiceUnitEnv, buildSystemSeedConfig,
} from './SystemdClient';
import { resolveSystemTool } from './systemTools';
import { WS_SCRCPY_SERVICE_NAME, WS_SCRCPY_SERVICE_DESCRIPTION } from '../../common/ServiceEvents';
import { Logger } from '../Logger';

const log = Logger.for('systemServiceCli');

export interface CommandResult { code: number; stdout: string; stderr: string; }
export type CommandRunner = (argv: string[]) => Promise<CommandResult>;

export interface CoreDeps {
    getuid: () => number;
    run: CommandRunner;
    writeFile: (path: string, content: string, opts: { mode: number }) => void;
    appImageSource: string;   // the running AppImage path ($APPIMAGE)
    depsSource: string;       // the user's dependencies dir to seed into /opt
    tool: (t: string) => string;       // /usr/bin resolver
    sbinTool: (t: string) => string;   // /usr/sbin resolver (semanage/restorecon)
}

const UNIT_PATH = `/etc/systemd/system/${WS_SCRCPY_SERVICE_NAME}.service`;
const STAGED_BIN = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
const FCONTEXT_SPEC = `${STAGED_SYSTEM_DIR}(/.*)?`;

function assertRoot(getuid: () => number): void {
    if (getuid() !== 0) {
        throw new Error('--install-system-service must run as root (use sudo, or the desktop installer which elevates via pkexec).');
    }
}

export async function installSystemService(opts: { port: number }, d: CoreDeps): Promise<void> {
    assertRoot(d.getuid);
    const mkdir = d.tool('mkdir'), cp = d.tool('cp'), chmod = d.tool('chmod'), systemctl = d.tool('systemctl');
    const semanage = d.sbinTool('semanage'), restorecon = d.sbinTool('restorecon');

    // 1. stage binary + deps into /opt (root-owned bin_t)
    await d.run([mkdir, '-p', STAGED_SYSTEM_DIR]);
    await d.run([mkdir, '-p', SYSTEM_STATE_DIR]);
    await d.run([cp, d.appImageSource, STAGED_BIN]);
    await d.run([chmod, '0755', STAGED_BIN]);
    await d.run([mkdir, '-p', STAGED_SYSTEM_DEPS_DIR]);
    await d.run([cp, '-a', `${d.depsSource}/.`, `${STAGED_SYSTEM_DEPS_DIR}/`]);

    // 2. SELinux: add bin_t for /opt (self-contained — NOT a machine-wide prerequisite),
    //    then apply. /var/lib needs NO rule (var_lib_t by the policy default).
    await d.run([semanage, 'fcontext', '-a', '-t', 'bin_t', FCONTEXT_SPEC]);
    await d.run([restorecon, '-R', STAGED_SYSTEM_DIR]);
    await d.run([restorecon, '-R', SYSTEM_STATE_DIR]);

    // 3. seed config + write the unit, then enable --now (the unit's Restart=on-failure
    //    handles the desktop takeover retry; headless binds immediately).
    const seed = buildSystemSeedConfig(opts.port);
    d.writeFile(`${SYSTEM_STATE_DIR}/config.json`, JSON.stringify(seed, null, 2) + '\n', { mode: 0o644 });
    const envVars = { ...buildServiceUnitEnv('linux', 'system', STAGED_SYSTEM_DEPS_DIR), WS_SCRCPY_WEB_PORT: String(opts.port) };
    const unit = renderUnitFile({
        name: WS_SCRCPY_SERVICE_NAME, description: WS_SCRCPY_SERVICE_DESCRIPTION,
        binPath: STAGED_BIN, startupDir: STAGED_SYSTEM_DIR, maxRestartAttempts: 10,
        envVars, logPath: `${SYSTEM_STATE_DIR}/logs/service.log`,
    } as unknown as Parameters<typeof renderUnitFile>[0], 'system');
    d.writeFile(UNIT_PATH, unit, { mode: 0o644 });
    await d.run([systemctl, 'daemon-reload']);
    await d.run([systemctl, 'enable', '--now', `${WS_SCRCPY_SERVICE_NAME}.service`]);
    log.info('system service installed + enabled');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web run test -- systemServiceCli`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git -C C:/Users/jscha/source/repos/ws-scrcpy-web add src/server/service/systemServiceCli.ts src/server/service/__tests__/systemServiceCli.test.ts
git -C C:/Users/jscha/source/repos/ws-scrcpy-web commit -m "feat(service): installSystemService core (self-contained, injected runner, euid==0)"
```

### Task 3: `uninstallSystemService` (+ `--keep-state`) and `systemServiceStatus`

**Files:**
- Modify: `src/server/service/systemServiceCli.ts`
- Test: `src/server/service/__tests__/systemServiceCli.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { uninstallSystemService, systemServiceStatus } from '../systemServiceCli';

describe('uninstallSystemService', () => {
    it('disables, removes unit, semanage -d /opt, restorecon, rm trees; keepState preserves config+logs', async () => {
        const { run, calls } = recordingRunner();
        await uninstallSystemService({ keepState: false }, { ...deps, run, removeFile: vi.fn() });
        const flat = calls.map((c) => c.join(' '));
        expect(flat).toContain('/usr/bin/systemctl disable --now WsScrcpyWeb.service');
        expect(flat).toContain('/usr/bin/systemctl daemon-reload');
        expect(flat).toContain('/usr/sbin/semanage fcontext -d /opt/ws-scrcpy-web(/.*)?');
        expect(flat).toContain('/usr/bin/rm -rf /opt/ws-scrcpy-web');
        expect(flat).toContain('/usr/bin/rm -rf /var/lib/ws-scrcpy-web');
    });
    it('keepState removes only dependencies/bin/control under /var/lib, not config/logs', async () => {
        const { run, calls } = recordingRunner();
        await uninstallSystemService({ keepState: true }, { ...deps, run, removeFile: vi.fn() });
        const flat = calls.map((c) => c.join(' '));
        expect(flat).toContain('/usr/bin/rm -rf /var/lib/ws-scrcpy-web/dependencies');
        expect(flat).toContain('/usr/bin/rm -rf /var/lib/ws-scrcpy-web/bin');
        expect(flat).toContain('/usr/bin/rm -rf /var/lib/ws-scrcpy-web/control');
        expect(flat).not.toContain('/usr/bin/rm -rf /var/lib/ws-scrcpy-web');
    });
});

describe('systemServiceStatus', () => {
    it('reports installed+active from systemctl is-active', async () => {
        const run: CommandRunner = vi.fn(async () => ({ code: 0, stdout: 'active\n', stderr: '' }));
        const r = await systemServiceStatus({ ...deps, run, existsCheck: () => true });
        expect(r).toEqual({ installed: true, active: true });
    });
});
```

- [ ] **Step 2: Run to verify fail** — `npm --prefix ... run test -- systemServiceCli` → FAIL (functions undefined).

- [ ] **Step 3: Implement** (append to `systemServiceCli.ts`; extend `CoreDeps` with `removeFile` and `existsCheck`)

```ts
export async function uninstallSystemService(opts: { keepState: boolean }, d: CoreDeps & { removeFile: (p: string) => void }): Promise<void> {
    assertRoot(d.getuid);
    const systemctl = d.tool('systemctl'), rm = d.tool('rm'), semanage = d.sbinTool('semanage'), restorecon = d.sbinTool('restorecon');
    await d.run([systemctl, 'disable', '--now', `${WS_SCRCPY_SERVICE_NAME}.service`]).catch(() => undefined);
    d.removeFile(UNIT_PATH);
    await d.run([systemctl, 'daemon-reload']);
    await d.run([semanage, 'fcontext', '-d', FCONTEXT_SPEC]).catch(() => undefined);
    await d.run([restorecon, '-R', STAGED_SYSTEM_DIR]).catch(() => undefined);
    await d.run([rm, '-rf', STAGED_SYSTEM_DIR]);
    if (opts.keepState) {
        for (const sub of ['dependencies', 'bin', 'control']) await d.run([rm, '-rf', `${SYSTEM_STATE_DIR}/${sub}`]);
    } else {
        await d.run([rm, '-rf', SYSTEM_STATE_DIR]);
    }
    log.info(`system service uninstalled (keepState=${opts.keepState})`);
}

export async function systemServiceStatus(d: CoreDeps & { existsCheck: (p: string) => boolean }): Promise<{ installed: boolean; active: boolean }> {
    const installed = d.existsCheck(UNIT_PATH);
    if (!installed) return { installed: false, active: false };
    const r = await d.run([d.tool('systemctl'), 'is-active', `${WS_SCRCPY_SERVICE_NAME}.service`]).catch(() => ({ code: 1, stdout: '', stderr: '' } as CommandResult));
    return { installed: true, active: r.stdout.trim() === 'active' };
}
```

(Note the `restorecon` after `rm -rf /opt` is harmless — it is a no-op once the path is gone; ordering keeps the fcontext-removed state consistent. Reorder if smoke shows a warning.)

- [ ] **Step 4: Run to verify pass** — PASS.

- [ ] **Step 5: Commit** — `git ... commit -m "feat(service): uninstallSystemService (+keepState) and systemServiceStatus"`

### Task 4: Arg parsing entry (`runSystemServiceCli`)

**Files:**
- Modify: `src/server/service/systemServiceCli.ts`
- Test: `src/server/service/__tests__/systemServiceCli.test.ts`

- [ ] **Step 1: Failing test** — parse `['--install-system-service','--port','9000']` → `{ op:'install', port:9000 }`; `['--uninstall-system-service','--keep-state']` → `{ op:'uninstall', keepState:true }`; `['--system-service-status']` → `{ op:'status' }`; unknown → `null`.

```ts
import { parseSystemServiceArgs } from '../systemServiceCli';
it('parses the three subcommands', () => {
    expect(parseSystemServiceArgs(['--install-system-service', '--port', '9000'])).toEqual({ op: 'install', port: 9000 });
    expect(parseSystemServiceArgs(['--uninstall-system-service', '--keep-state'])).toEqual({ op: 'uninstall', keepState: true });
    expect(parseSystemServiceArgs(['--system-service-status'])).toEqual({ op: 'status' });
    expect(parseSystemServiceArgs(['node', 'dist/index.js'])).toBeNull();
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `parseSystemServiceArgs(argv): { op:'install', port:number } | { op:'uninstall', keepState:boolean } | { op:'status' } | null` (default port reads from config in `runSystemServiceCli`; parse only what's present). Also add a `runSystemServiceCli(argv, deps)` that dispatches to the three fns, prints status as JSON for `status`, and returns an exit code.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git ... commit -m "feat(service): system-service CLI arg parsing + dispatch"`

---

## Phase 3 — Node one-shot mode (`index.ts`)

### Task 5: Detect the flags at startup and run the core, then exit

**Files:**
- Modify: `src/server/index.ts` (top of startup, BEFORE `VelopackApp.build()...run()` at line 49)
- Test: covered by Phase 2 (the core) + a manual smoke; add a thin unit test for the guard if `index.ts` is import-safe, else rely on the Rust integration.

- [ ] **Step 1:** At the very top of `index.ts` startup (before any server construction), add:

```ts
import { parseSystemServiceArgs, runSystemServiceCli, makeProductionCoreDeps } from './service/systemServiceCli';

const ssArgs = parseSystemServiceArgs(process.argv);
if (ssArgs) {
    // One-shot privileged mode: do the op as root, print result, exit. Never start the server.
    runSystemServiceCli(ssArgs, makeProductionCoreDeps())
        .then((code) => process.exit(code))
        .catch((err) => { console.error(String(err?.message ?? err)); process.exit(1); });
} else {
    // ... the existing VelopackApp.build()...run() + server start chain, wrapped so it only runs in the else branch ...
}
```

`makeProductionCoreDeps()` (add to `systemServiceCli.ts`) wires the real `CommandRunner` (`execFile` awaited, NO timeout), `process.getuid`, `fs.writeFileSync`/`unlinkSync`/`existsSync`, `resolveSystemTool` for `tool`/`sbinTool` (sbin via `resolveSystemTool` too), `process.env['APPIMAGE']` for `appImageSource`, and `Config.getInstance().dependenciesPath` for `depsSource`.

- [ ] **Step 2:** Build to verify the bundle still compiles: `npm --prefix C:/Users/jscha/source/repos/ws-scrcpy-web run build` → Expected: webpack success, no type errors.
- [ ] **Step 3:** `npx tsc --noEmit` (via `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`) → 0 errors.
- [ ] **Step 4: Commit** — `git ... commit -m "feat(server): one-shot --install/uninstall/status mode in index.ts"`

---

## Phase 4 — Rust launcher dispatchers (`system_service_cli.rs`)

### Task 6: Launcher routes the flags → spawns `node dist/index.js <flag>` foreground

**Files:**
- Create: `launcher/src/system_service_cli.rs`
- Modify: `launcher/src/main.rs` (add three blocks after line 164; add `mod system_service_cli;`)
- Test: `launcher/src/system_service_cli.rs` `#[cfg(test)]` (pure arg-detection)

- [ ] **Step 1: Failing test** (pure: which flag a given argv owns)

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detects_install_uninstall_status() {
        assert_eq!(owned_op(&svec(&["--install-system-service", "--port", "9000"])), Some(Op::Install));
        assert_eq!(owned_op(&svec(&["--uninstall-system-service", "--keep-state"])), Some(Op::Uninstall));
        assert_eq!(owned_op(&svec(&["--system-service-status"])), Some(Op::Status));
        assert_eq!(owned_op(&svec(&["ws-scrcpy-web-launcher"])), None);
    }
    fn svec(a: &[&str]) -> Vec<String> { a.iter().map(|s| s.to_string()).collect() }
}
```

- [ ] **Step 2: Run → FAIL** — `cross test -p ws-scrcpy-web-launcher` (or `cargo test` from `launcher/`) fails (module missing).
- [ ] **Step 3: Implement `system_service_cli.rs`** — `Op` enum, `owned_op(args)`, and `handle(args) -> Option<i32>` that, when an op is owned: resolves node + `dist/index.js` (reuse `spawn::resolve_node_with` / `resolve_server_entry_with`), runs `Command::new(node).arg(entry).args(forwarded_flags).status()` **foreground, inheriting stdio**, and returns `Some(status.code().unwrap_or(1))`. Forward the original `--port`/`--keep-state` flags through to node verbatim.

```rust
use crate::spawn::{resolve_node_with, resolve_server_entry_with};
use std::process::Command;

#[derive(Debug, PartialEq, Clone, Copy)]
pub enum Op { Install, Uninstall, Status }

pub fn owned_op(args: &[String]) -> Option<Op> {
    if args.iter().any(|a| a == "--install-system-service") { Some(Op::Install) }
    else if args.iter().any(|a| a == "--uninstall-system-service") { Some(Op::Uninstall) }
    else if args.iter().any(|a| a == "--system-service-status") { Some(Op::Status) }
    else { None }
}

pub fn handle(args: &[String]) -> Option<i32> {
    owned_op(args)?;
    let exe = std::env::current_exe().ok()?;
    let work_dir = exe.parent()?.to_path_buf();
    let node = resolve_node_with(None, &work_dir).ok()?;
    let entry = resolve_server_entry_with(&work_dir).ok()?;
    // forward everything after the program name (the flags) to node
    let forwarded: Vec<&String> = args.iter().skip(1).collect();
    let status = Command::new(&node).arg(&entry).args(&forwarded).current_dir(&work_dir).status();
    match status {
        Ok(s) => Some(s.code().unwrap_or(1)),
        Err(e) => { crate::log::error(&format!("system-service-cli: spawn node failed: {e}")); Some(1) }
    }
}
```

(Verify `resolve_node_with`/`resolve_server_entry_with` visibility — if `pub(crate)`, fine; else make them `pub(crate)`.)

- [ ] **Step 4: Add the dispatcher blocks** in `main.rs` after line 164 (`handle_elevated`), before the service-defer block (172):

```rust
#[cfg(target_os = "linux")]
if let Some(code) = system_service_cli::handle(&args) {
    log::info(&format!("system-service-cli exiting with code {code}"));
    std::process::exit(code);
}
```

And add `mod system_service_cli;` near the other `mod` lines.

- [ ] **Step 5: Run → PASS + build** — `cross test -p ws-scrcpy-web-launcher` PASS; `cross clippy -p ws-scrcpy-web-launcher -- -D warnings` clean.
- [ ] **Step 6: Commit** — `git ... commit -m "feat(launcher): --install/uninstall/system-service-status dispatchers spawn node one-shot"`

---

## Phase 5 — `ServiceApi`: desktop GUI path → awaited `pkexec <appimage>`

### Task 7: `handleInstall` system-scope spawns awaited `pkexec` (no timeout/kill), then the takeover

**Files:**
- Modify: `src/server/api/ServiceApi.ts:435-555` (the system-scope `client.install` + B1 branch)
- Test: `src/server/__tests__/ServiceApi.test.ts`

- [ ] **Step 1: Failing test** (assert the argv issued via an injected runner; assert NO timeout/kill option)

```ts
it('linux system-scope install runs `pkexec <appimage> --install-system-service --port N`, awaited, then exits local', async () => {
    Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    let elevArgv: string[] = [];
    const runElevated = vi.fn(async (argv: string[]) => { elevArgv = argv; return { code: 0, stdout: '', stderr: '' }; });
    const client = fakeClient({ status: vi.fn(async () => 'stopped' as const), getInstalledScope: vi.fn(async () => null) });
    const api = new ServiceApi(() => ({ client, supported: true, platform: 'linux' }),
        () => 'system', () => true, vi.fn(), vi.fn(), runPkexecUnused, defaultVerify, runElevated /* NEW injected runner */);
    const { req, res } = makeReqRes('/api/service/install', 'POST', { scope: 'system' });
    await api.handle(req, res);
    expect(elevArgv[0]).toMatch(/pkexec$/);
    expect(elevArgv).toContain('--install-system-service');
    expect(elevArgv).toContain('--port');
    const body = JSON.parse((res as any).getBody());
    expect(body.status).toBe('shutting-down');
});
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Add a constructor-injected `runElevated: (argv) => Promise<CommandResult>` (default: `execFile` awaited, NO `timeout`, resolving `pkexec` + `process.env['APPIMAGE']`). In `handleInstall`, the `result.platform === 'linux' && scope === 'system'` path no longer calls `client.install(...)`; instead:

```ts
if (result.platform === 'linux' && scope === 'system') {
    const appImage = process.env['APPIMAGE'] ?? process.execPath;
    const port = cfg.getAppConfig().webPort;
    // single AWAITED pkexec — no timeout, no kill (the kill EPERM class is gone)
    const r = await this.runElevated([resolveSystemTool('pkexec'), appImage, '--install-system-service', '--port', String(port)]);
    if (r.code === 126) { /* respond cancelled */ }
    if (r.code !== 0) { /* revert installMode, respond error */ }
    // success: enable+start issued; exit local so the unit's retry binds the port
    this.scheduleExit(() => process.exit(0), 1_500);
    /* respond { ok:true, status:'shutting-down', installMode:'system-service', ... } */
}
```

(Headless never reaches this — it enters via the Rust CLI, not the HTTP API.)

- [ ] **Step 4: Run → PASS** (`npm --prefix ... run test -- ServiceApi`).
- [ ] **Step 5: Commit** — `git ... commit -m "feat(api): system-scope install via awaited pkexec <appimage> --install-system-service (no kill)"`

### Task 8: `handleUninstall` system-scope when served-by-service → in-process core

**Files:**
- Modify: `src/server/api/ServiceApi.ts:618-706`
- Test: `ServiceApi.test.ts`

- [ ] **Step 1: Failing test** — when `process.env['WS_SCRCPY_SERVICE']==='1'` (served by the root service) and `getuid()===0`, uninstall runs `uninstallSystemService` in-process (assert via injected core fn), responds `shutting-down`; otherwise (desktop local, not root) it spawns awaited `pkexec <appimage> --uninstall-system-service`.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** — inject the uninstall core; branch on `servedByService && getuid()===0` (in-process) vs non-root (awaited `pkexec`). Keep the desktop fall-back relaunch (`loginctl`) only for the served-by-service desktop case (gate on an active session; headless skips).
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** — `git ... commit -m "feat(api): system-scope uninstall self-managed by the root service; pkexec fallback when stopped"`

---

## Phase 6 — Remove the dead mechanism

### Task 9: Delete `buildSystemInstallScript`, the `runPkexec` timeout, and the system branch of `install()`

**Files:**
- Modify: `src/server/service/SystemdClient.ts` (delete `buildSystemInstallScript` 293-385; delete `timeout: 60_000` at 155; remove the `scope==='system' && getuid!==0` pkexec-sh-c branch of `install()` 635-664 — system installs now go through the CLI core)
- Modify: `src/server/service/__tests__/SystemdClient.test.ts` (delete the `buildSystemInstallScript` describe blocks)

- [ ] **Step 1:** Delete `buildSystemInstallScript` and its tests. Delete the `timeout: 60_000` line in `runPkexec` (the user-scope/machine-wide pkexec paths that remain now await with no timeout). Remove the system-scope non-root branch of `install()` (lines 635-664); leave the user-scope and already-root branches.
- [ ] **Step 2:** Grep to confirm no remaining references: `grep -rn "buildSystemInstallScript\|timeout: 60_000" src/` → empty.
- [ ] **Step 3:** Run the full suite + tsc: `npm --prefix ... run test` (expect green, lower count by the deleted tests) and `tsc --noEmit` (0).
- [ ] **Step 4: Commit** — `git ... commit -m "refactor(service): delete buildSystemInstallScript + runPkexec timeout (superseded by the CLI core)"`

---

## Phase 7 — Frontend takeover copy + smoke docs

### Task 10: `SettingsModal` install/uninstall messaging

**Files:**
- Modify: `src/app/client/SettingsModal.ts` (`onInstallService` success copy → "switching to the system service…"; `uninstallFollowupMessage` already exists)
- Test: `src/app/client/__tests__/SettingsModal.test.ts`

- [ ] **Step 1:** Failing test asserting the takeover status copy is rendered while polling. **Step 2:** Run → FAIL. **Step 3:** Update the copy (reuse `classifyInstallPoll`; no logic change). **Step 4:** Run → PASS. **Step 5:** Commit `git ... commit -m "feat(ui): system-service install shows 'switching over' takeover copy"`.

### Task 11: Smoke-doc batch #9 update

**Files:**
- Modify: `docs/smoke-tests/smoke-checklist.md` + `smoke-full.md` (#9 / 4.2-system)

- [ ] **Step 1:** Replace the 4.2-system rows to exercise BOTH paths: (a) headless `sudo ./WsScrcpyWeb --install-system-service` → 2.2 `ls -Z /var/lib`=`var_lib_t`, 2.3 only the `/opt` bin_t rule, service survives reboot, zero AVC; (b) desktop `pkexec` install → automatic takeover (one tab, ≤ a few seconds), uninstall-while-served → auto local fallback; `--keep-state` reinstall reuses the port. Add the Ubuntu pass row (SELinux steps no-op).
- [ ] **Step 2: Commit** — `git ... commit -m "docs(smoke): batch #9 — CLI + desktop-takeover system install"`

---

## Self-review (run after writing all tasks)

- **Spec coverage:** §4 architecture → Phases 2-4; §5 changes table → Tasks 2-9; §6 unit → Task 1; §7 install flow (headless + takeover) → Tasks 5-7; §8 uninstall → Tasks 3,8; §9 SELinux → Task 2 (bin_t add + restorecon, no var_lib rule); §10 errors (126/non-zero/no-kill) → Tasks 7-8; §11 testing → every task's behavior tests + Task 11 smoke. ✓
- **Type consistency:** `CommandRunner`/`CommandResult`/`CoreDeps` names are stable across Phases 2-5; `Op` enum (Rust) matches the three flags; `runElevated` injected into `ServiceApi` matches the `CommandRunner` shape.
- **No placeholders:** the `/* respond ... */` comments in Task 7 are the only shorthand — the engineer mirrors the existing `ServiceActionSuccess`/`ServiceActionError` response shapes already in `handleInstall` (lines 538-555 / 562-604 in the current file); spell those out at implementation time from the adjacent code.

## Open verification (the real gate)

CI cannot exercise SELinux/systemd/pkexec. The runtime smoke (Task 11) on a Fedora-enforcing VM (headless + desktop) and an Ubuntu VM is the acceptance gate — `tsc`/`vitest`/`cargo`/`clippy` green is necessary but not sufficient.
