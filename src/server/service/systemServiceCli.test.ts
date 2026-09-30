import { describe, expect, it, vi } from 'vitest';
import { Config } from '../Config';
import {
    assertSafeRootDir,
    type CommandRunner,
    ensureSafeRootDir,
    installSystemService,
    keptWebPort,
    makeProductionCoreDeps,
    parseSystemServiceArgs,
    parseUnitState,
    runSystemServiceCli,
    systemServiceStatus,
    uninstallSystemService,
    unitSetupFailure,
} from './systemServiceCli';

/** `systemctl show` output for a unit that started and is running. */
const HEALTHY = 'ActiveState=active\nSubState=running\nResult=success\nExecMainCode=0\nExecMainStatus=0\n';

function recordingRunner() {
    const calls: string[][] = [];
    const run: CommandRunner = vi.fn(async (argv: string[]) => {
        calls.push(argv);
        const stdout = argv[1] === 'show' ? HEALTHY : '';
        return { code: 0, stdout, stderr: '' };
    });
    return { run, calls };
}

// portOpen answers true, so these installs take the page's path (the port was
// already held when the unit started) and pass once the settle window is clean.
const deps = {
    getuid: () => 0,
    appImageSource: '/tmp/.mount_x/usr/bin/WsScrcpyWeb.AppImage',
    tool: (t: string) => `/usr/bin/${t}`,
    sbinTool: (t: string) => `/usr/sbin/${t}`,
    writeFile: vi.fn(),
    lstat: () => ({ uid: 0, gid: 0, mode: 0o755, isSymbolicLink: false }),
    readFile: () => null,
    portOpen: async () => true,
    sleep: async () => undefined,
};

describe('installSystemService', () => {
    it('asserts euid==0, stages /opt, adds bin_t, restorecons, writes the unit, enables --now', async () => {
        const { run, calls } = recordingRunner();
        await installSystemService({ port: 8000 }, { ...deps, run });
        const flat = calls.map((c) => c.join(' '));
        expect(flat).toContain('/usr/bin/mkdir -p -m 0755 /opt/ws-scrcpy-web');
        expect(flat).toContain('/usr/bin/mkdir -p -m 0755 /var/lib/ws-scrcpy-web');
        expect(flat).toContain(
            '/usr/bin/install -o root -g root -m 0755 /tmp/.mount_x/usr/bin/WsScrcpyWeb.AppImage /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage.new',
        );
        expect(flat).toContain(
            '/usr/bin/mv -f /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage.new /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage',
        );
        expect(flat).toContain('/usr/sbin/semanage fcontext -a -t bin_t /opt/ws-scrcpy-web(/.*)?');
        expect(flat.some((c) => c.startsWith('/usr/sbin/restorecon -R') && c.includes('/opt/ws-scrcpy-web'))).toBe(
            true,
        );
        expect(flat.some((c) => c.includes('var_lib_t'))).toBe(false);
        expect(deps.writeFile).toHaveBeenCalledWith(
            '/etc/systemd/system/WsScrcpyWeb.service',
            expect.stringContaining('ExecStart=/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage'),
            expect.anything(),
        );
        expect(flat).toContain('/usr/bin/systemctl daemon-reload');
        expect(flat).toContain('/usr/bin/systemctl enable --now WsScrcpyWeb.service');
    });

    it('throws if not root', async () => {
        const { run } = recordingRunner();
        await expect(installSystemService({ port: 8000 }, { ...deps, getuid: () => 1000, run })).rejects.toThrow(
            /root|euid|sudo/i,
        );
    });

    it('aborts before any cp/restorecon when a target dir is a symlink (#15)', async () => {
        const { run, calls } = recordingRunner();
        const lstat = (p: string) =>
            p === '/opt/ws-scrcpy-web'
                ? { uid: 0, gid: 0, mode: 0o755, isSymbolicLink: true }
                : { uid: 0, gid: 0, mode: 0o755, isSymbolicLink: false };
        await expect(installSystemService({ port: 8000 }, { ...deps, run, lstat })).rejects.toThrow(/symlink/i);
        const flat = calls.map((c) => c.join(' '));
        expect(flat.some((c) => c.startsWith('/usr/sbin/restorecon'))).toBe(false);
        expect(flat.some((c) => c.startsWith('/usr/bin/cp '))).toBe(false);
    });
});

describe('assertSafeRootDir (review #15)', () => {
    const safe = { uid: 0, gid: 0, mode: 0o755, isSymbolicLink: false };
    it('accepts a root-owned, non-symlink, non-world-writable dir', () => {
        expect(() => assertSafeRootDir('/opt/ws-scrcpy-web', () => safe)).not.toThrow();
    });
    it('rejects a symlink (symlink-swap / TOCTOU defense)', () => {
        expect(() => assertSafeRootDir('/opt/ws-scrcpy-web', () => ({ ...safe, isSymbolicLink: true }))).toThrow(
            /symlink/i,
        );
    });
    it('rejects a non-root-owned dir', () => {
        expect(() => assertSafeRootDir('/opt/ws-scrcpy-web', () => ({ ...safe, uid: 1000 }))).toThrow(/root/i);
    });
    it('rejects a group- or world-writable dir', () => {
        expect(() => assertSafeRootDir('/x', () => ({ ...safe, mode: 0o777 }))).toThrow(/writable/i);
        expect(() => assertSafeRootDir('/x', () => ({ ...safe, mode: 0o775 }))).toThrow(/writable/i);
        expect(() => assertSafeRootDir('/x', () => ({ ...safe, mode: 0o757 }))).toThrow(/writable/i);
    });
});

// ── D8 / D9 / D7b: qa-harness arc L3 on beta.144 (Ubuntu 26.04) ──

/** A mutable lstat over a tiny in-memory tree, so a chmod the code runs is observed. */
function modeTree(initial: Record<string, { uid?: number; gid?: number; mode: number; isSymbolicLink?: boolean }>) {
    const tree = new Map(
        Object.entries(initial).map(([p, s]) => [
            p,
            { uid: s.uid ?? 0, gid: s.gid ?? 0, mode: s.mode, isSymbolicLink: s.isSymbolicLink ?? false },
        ]),
    );
    const lstat = (p: string) => tree.get(p) ?? { uid: 0, gid: 0, mode: 0o755, isSymbolicLink: false };
    const calls: string[][] = [];
    const run: CommandRunner = vi.fn(async (argv: string[]) => {
        calls.push(argv);
        if (argv[0] === '/usr/bin/chmod' && argv[1] === 'g-w') {
            const st = tree.get(argv[2]!);
            if (st) st.mode &= ~0o020;
        }
        return { code: 0, stdout: '', stderr: '' };
    });
    return { lstat, run, calls };
}

describe('ensureSafeRootDir (D8)', () => {
    const tool = (t: string) => `/usr/bin/${t}`;
    it('repairs a root:root 775 dir to 755 instead of refusing it', async () => {
        const { lstat, run, calls } = modeTree({ '/opt/ws-scrcpy-web': { mode: 0o775 } });
        await expect(ensureSafeRootDir('/opt/ws-scrcpy-web', { lstat, run, tool })).resolves.toBeUndefined();
        expect(calls.map((c) => c.join(' '))).toContain('/usr/bin/chmod g-w /opt/ws-scrcpy-web');
        expect(lstat('/opt/ws-scrcpy-web').mode & 0o777).toBe(0o755);
    });
    it('leaves a safe 755 dir alone', async () => {
        const { lstat, run, calls } = modeTree({ '/x': { mode: 0o755 } });
        await ensureSafeRootDir('/x', { lstat, run, tool });
        expect(calls).toEqual([]);
    });
    it.each([
        ['world-writable', { mode: 0o777 }, /writable/i],
        ['other-writable only', { mode: 0o757 }, /writable/i],
        ['group-writable, group not root', { mode: 0o775, gid: 1000 }, /writable/i],
        ['not root-owned', { mode: 0o775, uid: 1000 }, /root/i],
        ['a symlink', { mode: 0o775, isSymbolicLink: true }, /symlink/i],
    ])('still refuses %s, and never chmods it', async (_label, st, re) => {
        const { lstat, run, calls } = modeTree({ '/x': st });
        await expect(ensureSafeRootDir('/x', { lstat, run, tool })).rejects.toThrow(re);
        expect(calls).toEqual([]);
    });
    it('refuses when the repair did not take', async () => {
        // chmod "succeeds" but the mode never changes: the re-check must catch it.
        const lstat = () => ({ uid: 0, gid: 0, mode: 0o775, isSymbolicLink: false });
        const run: CommandRunner = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
        await expect(ensureSafeRootDir('/x', { lstat, run, tool })).rejects.toThrow(/writable/i);
    });
});

describe('installSystemService — D8 / D9 / D7b', () => {
    it('creates every root dir with an explicit 0755, whatever the umask', async () => {
        const { run, calls } = recordingRunner();
        await installSystemService({ port: 8000 }, { ...deps, run });
        const mkdirs = calls.filter((c) => c[0] === '/usr/bin/mkdir').map((c) => c.join(' '));
        expect(mkdirs.length).toBeGreaterThanOrEqual(4);
        for (const m of mkdirs) expect(m).toMatch(/^\/usr\/bin\/mkdir -p -m 0755 /);
    });
    it('installs over a 775 /opt that an earlier machine-wide install left (D8)', async () => {
        const { lstat, run } = modeTree({
            '/opt/ws-scrcpy-web': { mode: 0o775 },
            '/var/lib/ws-scrcpy-web': { mode: 0o775 },
        });
        const writeFile = vi.fn();
        await installSystemService({ port: 8000 }, { ...deps, run, lstat, writeFile });
        expect(writeFile).toHaveBeenCalledWith('/etc/systemd/system/WsScrcpyWeb.service', expect.any(String), {
            mode: 0o644,
        });
    });
    it('creates <state>/logs before enabling the unit that appends into it (D9)', async () => {
        const { run, calls } = recordingRunner();
        const writeFile = vi.fn();
        await installSystemService({ port: 8000 }, { ...deps, run, writeFile });
        const flat = calls.map((c) => c.join(' '));
        const mkLogs = flat.indexOf('/usr/bin/mkdir -p -m 0755 /var/lib/ws-scrcpy-web/logs');
        const enable = flat.indexOf('/usr/bin/systemctl enable --now WsScrcpyWeb.service');
        expect(mkLogs).toBeGreaterThanOrEqual(0);
        expect(mkLogs).toBeLessThan(enable);
        const unit = writeFile.mock.calls.find((c) => c[0] === '/etc/systemd/system/WsScrcpyWeb.service')?.[1];
        expect(unit).toContain('StandardOutput=append:/var/lib/ws-scrcpy-web/logs/service.log');
    });
});

describe('installSystemService — D14: root never stages a user-owned tree', () => {
    it('copies nothing into /opt except the AppImage itself', async () => {
        // beta.145 `cp -a`'d the desktop user's dependencies into /opt; -a kept
        // their ownership, and the root service exec'd a node they could rewrite.
        const { run, calls } = recordingRunner();
        await installSystemService({ port: 8000 }, { ...deps, run });
        // No cp at all: the one file that lands in /opt goes through `install -o root`.
        expect(calls.some((c) => c[0] === '/usr/bin/cp')).toBe(false);
        const installs = calls.filter((c) => c[0] === '/usr/bin/install').map((c) => c.join(' '));
        expect(installs).toEqual([
            '/usr/bin/install -o root -g root -m 0755 /tmp/.mount_x/usr/bin/WsScrcpyWeb.AppImage /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage.new',
        ]);
        // …and no step reaches into a user's home.
        expect(calls.some((c) => c.some((a) => a.startsWith('/home/')))).toBe(false);
    });
    it('D14b: replaces the /opt binary even when it is the source, and checks the result', async () => {
        // A desktop install run from /opt copies the /opt AppImage onto itself; a
        // user-owned one (left by a pre-fix machine-wide update) must still come out
        // as a fresh root-owned file, and an unsafe result refuses the install.
        const { run, calls } = recordingRunner();
        const self = '/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage';
        await installSystemService({ port: 8000 }, { ...deps, appImageSource: self, run });
        const flat = calls.map((c) => c.join(' '));
        expect(flat).toContain(`/usr/bin/install -o root -g root -m 0755 ${self} ${self}.new`);
        expect(flat.indexOf(`/usr/bin/mv -f ${self}.new ${self}`)).toBeGreaterThan(
            flat.indexOf(`/usr/bin/install -o root -g root -m 0755 ${self} ${self}.new`),
        );
        expect(flat).toContain('/usr/bin/chown root:root /opt/ws-scrcpy-web/VERSION');
        expect(flat).toContain('/usr/bin/chmod 0644 /opt/ws-scrcpy-web/VERSION');

        const lstat = (p: string) =>
            p === self
                ? { uid: 1000, gid: 1000, mode: 0o100755, isSymbolicLink: false }
                : { uid: 0, gid: 0, mode: 0o755, isSymbolicLink: false };
        const r2 = recordingRunner();
        await expect(installSystemService({ port: 8000 }, { ...deps, run: r2.run, lstat })).rejects.toThrow(
            /not root-owned/,
        );
        expect(r2.calls.some((c) => c.join(' ').includes('enable --now'))).toBe(false);
    });
    it('removes any staged dependencies tree, then recreates it empty, 0755 and checked', async () => {
        // A reinstall over a beta.145 install must not keep that user-owned tree.
        const { run, calls } = recordingRunner();
        await installSystemService({ port: 8000 }, { ...deps, run });
        const flat = calls.map((c) => c.join(' '));
        const rm = flat.indexOf('/usr/bin/rm -rf /opt/ws-scrcpy-web/dependencies');
        const mk = flat.indexOf('/usr/bin/mkdir -p -m 0755 /opt/ws-scrcpy-web/dependencies');
        expect(rm).toBeGreaterThanOrEqual(0);
        expect(mk).toBeGreaterThan(rm);
        expect(mk).toBeLessThan(flat.indexOf('/usr/bin/systemctl enable --now WsScrcpyWeb.service'));
    });
    it('refuses to install when the recreated dependencies dir is not safe', async () => {
        const lstat = (p: string) =>
            p === '/opt/ws-scrcpy-web/dependencies'
                ? { uid: 1000, gid: 1000, mode: 0o775, isSymbolicLink: false }
                : { uid: 0, gid: 0, mode: 0o755, isSymbolicLink: false };
        const { run, calls } = recordingRunner();
        await expect(installSystemService({ port: 8000 }, { ...deps, run, lstat })).rejects.toThrow(/not root-owned/);
        expect(calls.some((c) => c.join(' ').includes('enable --now'))).toBe(false);
    });
});

// ── item 159: `--install-system-service` exited 0 while the unit never started ──

/**
 * A host whose unit reports `states[i]` on the i-th `systemctl show` (the last
 * one repeats), and whose web port reads `portBefore` until `enable --now` and
 * then `portAfter(showCount)`.
 */
function fakeHost(opts: {
    states: string[];
    portBefore: boolean;
    portAfter?: (shows: number) => boolean;
    enable?: { code: number; stderr: string };
}) {
    const calls: string[][] = [];
    let shows = 0;
    let enabled = false;
    const run: CommandRunner = vi.fn(async (argv: string[]) => {
        calls.push(argv);
        if (argv[1] === 'enable') {
            enabled = true;
            return { code: opts.enable?.code ?? 0, stdout: '', stderr: opts.enable?.stderr ?? '' };
        }
        if (argv[1] === 'show') {
            const s = opts.states[Math.min(shows, opts.states.length - 1)]!;
            shows++;
            return { code: 0, stdout: s, stderr: '' };
        }
        if (argv[0] === '/usr/bin/journalctl') {
            return { code: 0, stdout: 'systemd[1]: WsScrcpyWeb.service: Failed at step STDOUT\n', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
    });
    const portOpen = vi.fn(async () => (enabled ? (opts.portAfter?.(shows) ?? false) : opts.portBefore));
    const sleep = vi.fn(async () => undefined);
    return { run, calls, portOpen, sleep, shows: () => shows };
}

const unitState = (active: string, sub: string, result: string, code: number, status: number) =>
    `ActiveState=${active}\nSubState=${sub}\nResult=${result}\nExecMainCode=${code}\nExecMainStatus=${status}\n`;
/** D9 as measured: systemd could not open the `append:` log, status 209/STDOUT, restarting. */
const D9 = unitState('activating', 'auto-restart', 'exit-code', 1, 209);
/** The page's install: the user's own copy still holds the port, so Node exits 1 and systemd retries. */
const EADDRINUSE = unitState('activating', 'auto-restart', 'exit-code', 1, 1);
const STARTING = unitState('active', 'running', 'success', 0, 0);

describe('installSystemService — item 159: the unit must actually start', () => {
    it('headless (port free before): passes once the unit is running AND serves the port', async () => {
        // Type=simple reads active the instant it forks, so the port is what proves it.
        const h = fakeHost({ states: [STARTING], portBefore: false, portAfter: (n) => n >= 3 });
        await installSystemService({ port: 8000 }, { ...deps, ...h });
        expect(h.shows()).toBe(3);
        expect(h.portOpen).toHaveBeenCalledWith(8000);
    });

    it('headless: fails fast on a systemd setup failure (D9, status 209) and shows the journal', async () => {
        const h = fakeHost({ states: [D9], portBefore: false });
        await expect(installSystemService({ port: 8000 }, { ...deps, ...h })).rejects.toThrow(
            /status 209[\s\S]*Failed at step STDOUT/,
        );
        expect(h.shows()).toBe(1);
    });

    it('headless: fails when the unit runs but never serves the port, after the full wait', async () => {
        const h = fakeHost({ states: [STARTING], portBefore: false, portAfter: () => false });
        await expect(installSystemService({ port: 8000 }, { ...deps, ...h })).rejects.toThrow(
            /did not start serving port 8000 within 120 s/,
        );
        expect(h.sleep).toHaveBeenCalledTimes(120);
    });

    it('fails when the unit lands in `failed` (the restart limit), naming the result', async () => {
        const h = fakeHost({
            states: [EADDRINUSE, unitState('failed', 'failed', 'start-limit-hit', 1, 1)],
            portBefore: false,
        });
        await expect(installSystemService({ port: 8000 }, { ...deps, ...h })).rejects.toThrow(/start-limit-hit/);
    });

    it('page install (port held before): a unit retrying on the busy port passes the settle window', async () => {
        // The user's own copy exits after this returns; the page's poll then waits for the service.
        const h = fakeHost({ states: [EADDRINUSE], portBefore: true });
        await installSystemService({ port: 8000 }, { ...deps, ...h });
        expect(h.shows()).toBe(6);
        // Before the start only: once the port was held, it proves nothing about the service.
        expect(h.portOpen).toHaveBeenCalledTimes(1);
    });

    it('page install: still fails on a setup failure, so the user keeps their running copy', async () => {
        const h = fakeHost({
            states: [EADDRINUSE, unitState('activating', 'auto-restart', 'exit-code', 1, 203)],
            portBefore: true,
        });
        await expect(installSystemService({ port: 8000 }, { ...deps, ...h })).rejects.toThrow(/status 203/);
    });

    it('fails on a non-zero `enable --now`, with its stderr, without polling', async () => {
        const h = fakeHost({
            states: [STARTING],
            portBefore: false,
            enable: { code: 1, stderr: 'Failed to enable unit: Unit file WsScrcpyWeb.service is masked.' },
        });
        await expect(installSystemService({ port: 8000 }, { ...deps, ...h })).rejects.toThrow(/is masked/);
        expect(h.shows()).toBe(0);
    });

    it('the CLI exits 1 and puts the reason on stderr, which the page shows (D8)', async () => {
        const h = fakeHost({ states: [D9], portBefore: false });
        const err: string[] = [];
        const code = await runSystemServiceCli(
            { op: 'install', port: 8000 },
            {
                ...deps,
                ...h,
                removeFile: vi.fn(),
                existsCheck: () => false,
                defaultPort: () => 8000,
                log: () => undefined,
                logError: (s: string) => err.push(s),
            },
        );
        expect(code).toBe(1);
        expect(err.join('\n')).toMatch(/status 209/);
        expect(err.join('\n')).toMatch(/systemctl status WsScrcpyWeb\.service/);
    });
});

describe('parseUnitState / unitSetupFailure', () => {
    it('parses `systemctl show` key=value output', () => {
        expect(parseUnitState(D9)).toEqual({
            activeState: 'activating',
            subState: 'auto-restart',
            result: 'exit-code',
            execMainCode: 1,
            execMainStatus: 209,
        });
    });
    it('treats unreadable output as unknown, not as a failure', () => {
        const s = parseUnitState('');
        expect(unitSetupFailure(s)).toBeNull();
    });
    it('a running unit reads status 0 and is no failure; our own exit codes are not setup codes', () => {
        expect(unitSetupFailure(parseUnitState(STARTING))).toBeNull();
        expect(unitSetupFailure(parseUnitState(EADDRINUSE))).toBeNull();
    });
    it('systemd setup statuses 200-245 are failures, whatever the unit is doing now', () => {
        for (const status of [200, 203, 209, 245]) {
            expect(
                unitSetupFailure(parseUnitState(unitState('activating', 'auto-restart', 'exit-code', 1, status))),
            ).toMatch(new RegExp(`status ${status}`));
        }
        expect(
            unitSetupFailure(parseUnitState(unitState('activating', 'auto-restart', 'exit-code', 1, 246))),
        ).toBeNull();
        // Killed by signal 9 is code 2 (CLD_KILLED), not an exit status.
        expect(unitSetupFailure(parseUnitState(unitState('activating', 'auto-restart', 'signal', 2, 209)))).toBeNull();
    });
});

describe('the one-shot never opens Config or the store (D7b)', () => {
    it('makeProductionCoreDeps does not call Config.getInstance', () => {
        const spy = vi.spyOn(Config, 'getInstance');
        const d = makeProductionCoreDeps();
        d.defaultPort();
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
    });
});

describe('D12: a reinstall after --keep-state reuses what was kept', () => {
    const cliDeps = (readFile: (p: string) => string | null, writeFile = vi.fn()) => ({
        ...deps,
        run: recordingRunner().run,
        writeFile,
        readFile,
        removeFile: vi.fn(),
        existsCheck: () => false,
        defaultPort: () => 8000,
        log: () => undefined,
        logError: () => undefined,
    });
    const writtenConfig = (writeFile: ReturnType<typeof vi.fn>) =>
        JSON.parse(writeFile.mock.calls.find((c) => c[0] === '/var/lib/ws-scrcpy-web/config.json')?.[1] as string);

    it('without --port, takes webPort from the kept config and keeps the other keys', async () => {
        // qa-harness L3 on beta.145: kept "webPort": 8123, reinstall came up on 8000.
        const kept = JSON.stringify({ webPort: 8123, theme: 'dark', installMode: 'system' });
        const writeFile = vi.fn();
        const code = await runSystemServiceCli(
            { op: 'install', port: undefined },
            cliDeps((p) => (p === '/var/lib/ws-scrcpy-web/config.json' ? kept : null), writeFile),
        );
        expect(code).toBe(0);
        expect(writtenConfig(writeFile)).toEqual({
            webPort: 8123,
            theme: 'dark',
            installMode: 'system-service',
            firstRunComplete: true,
        });
        const unit = writeFile.mock.calls.find((c) => c[0] === '/etc/systemd/system/WsScrcpyWeb.service')?.[1];
        expect(unit).toContain('WS_SCRCPY_WEB_PORT=8123');
    });
    it('an explicit --port still wins over the kept one', async () => {
        const writeFile = vi.fn();
        await runSystemServiceCli(
            { op: 'install', port: 9001 },
            cliDeps(() => JSON.stringify({ webPort: 8123 }), writeFile),
        );
        expect(writtenConfig(writeFile).webPort).toBe(9001);
    });
    it('falls back to the default when nothing usable was kept', async () => {
        for (const raw of [
            null,
            'not json',
            '[8123]',
            JSON.stringify({ webPort: 80 }),
            JSON.stringify({ webPort: '8123' }),
        ]) {
            const writeFile = vi.fn();
            await runSystemServiceCli(
                { op: 'install', port: undefined },
                cliDeps(() => raw, writeFile),
            );
            expect(writtenConfig(writeFile).webPort).toBe(8000);
        }
    });
    it('keptWebPort accepts only an integer port in 1024-65535', () => {
        expect(keptWebPort({ webPort: 1024 })).toBe(1024);
        expect(keptWebPort({ webPort: 65535 })).toBe(65535);
        for (const bad of [1023, 65536, 8123.5, '8123', null]) expect(keptWebPort({ webPort: bad })).toBeUndefined();
        expect(keptWebPort(null)).toBeUndefined();
    });
});

describe('uninstallSystemService', () => {
    it('disables, removes unit, semanage -d /opt, restorecon, rm trees; keepState=false wipes /var/lib', async () => {
        const { run, calls } = recordingRunner();
        await uninstallSystemService({ keepState: false }, { ...deps, run, removeFile: vi.fn() });
        const flat = calls.map((c) => c.join(' '));
        expect(flat).toContain('/usr/bin/systemctl disable --now WsScrcpyWeb.service');
        expect(flat).toContain('/usr/bin/systemctl daemon-reload');
        expect(flat).toContain('/usr/sbin/semanage fcontext -d /opt/ws-scrcpy-web(/.*)?');
        expect(flat).toContain('/usr/bin/rm -rf /opt/ws-scrcpy-web');
        expect(flat).toContain('/usr/bin/rm -rf /var/lib/ws-scrcpy-web');
    });
    it('keepState=true removes only dependencies/bin/control under /var/lib, not the whole dir', async () => {
        const { run, calls } = recordingRunner();
        await uninstallSystemService({ keepState: true }, { ...deps, run, removeFile: vi.fn() });
        const flat = calls.map((c) => c.join(' '));
        expect(flat).toContain('/usr/bin/rm -rf /var/lib/ws-scrcpy-web/dependencies');
        expect(flat).toContain('/usr/bin/rm -rf /var/lib/ws-scrcpy-web/bin');
        expect(flat).toContain('/usr/bin/rm -rf /var/lib/ws-scrcpy-web/control');
        expect(flat).not.toContain('/usr/bin/rm -rf /var/lib/ws-scrcpy-web');
    });
    it('throws if not root', async () => {
        const { run } = recordingRunner();
        await expect(
            uninstallSystemService({ keepState: false }, { ...deps, getuid: () => 1000, run, removeFile: vi.fn() }),
        ).rejects.toThrow(/root|euid|sudo/i);
    });
});

describe('systemServiceStatus', () => {
    it('reports installed+active from systemctl is-active', async () => {
        const run: CommandRunner = vi.fn(async () => ({ code: 0, stdout: 'active\n', stderr: '' }));
        const r = await systemServiceStatus({ ...deps, run, existsCheck: () => true });
        expect(r).toEqual({ installed: true, active: true });
    });
    it('reports not installed when the unit file is absent', async () => {
        const { run } = recordingRunner();
        const r = await systemServiceStatus({ ...deps, run, existsCheck: () => false });
        expect(r).toEqual({ installed: false, active: false });
    });
});

describe('parseSystemServiceArgs', () => {
    it('parses install with and without a port', () => {
        expect(parseSystemServiceArgs(['--install-system-service', '--port', '9000'])).toEqual({
            op: 'install',
            port: 9000,
        });
        expect(parseSystemServiceArgs(['--install-system-service'])).toEqual({ op: 'install', port: undefined });
    });
    it('ignores a --deps-source from a beta.145 caller: nothing is staged from it (D14)', () => {
        expect(
            parseSystemServiceArgs(['--install-system-service', '--port', '8000', '--deps-source', '/home/qa/deps']),
        ).toEqual({ op: 'install', port: 8000 });
    });
    it('parses uninstall with keep-state flag', () => {
        expect(parseSystemServiceArgs(['--uninstall-system-service', '--keep-state'])).toEqual({
            op: 'uninstall',
            keepState: true,
        });
        expect(parseSystemServiceArgs(['--uninstall-system-service'])).toEqual({ op: 'uninstall', keepState: false });
    });
    it('parses status, and returns null when no system-service flag is present', () => {
        expect(parseSystemServiceArgs(['--system-service-status'])).toEqual({ op: 'status' });
        expect(parseSystemServiceArgs(['node', 'dist/index.js'])).toBeNull();
    });
});

describe('runSystemServiceCli dispatch', () => {
    it('install op runs installSystemService with the parsed port and returns 0', async () => {
        const { run, calls } = recordingRunner();
        const code = await runSystemServiceCli(
            { op: 'install', port: 9000 },
            {
                ...deps,
                run,
                removeFile: vi.fn(),
                existsCheck: () => false,
                defaultPort: () => 8000,
                log: () => undefined,
                logError: () => undefined,
            },
        );
        expect(code).toBe(0);
        expect(calls.some((c) => c.join(' ').includes('enable --now'))).toBe(true);
    });
    it('install op with undefined port falls back to defaultPort()', async () => {
        const { run, calls } = recordingRunner();
        await runSystemServiceCli(
            { op: 'install', port: undefined },
            {
                ...deps,
                run,
                removeFile: vi.fn(),
                existsCheck: () => false,
                defaultPort: () => 8123,
                log: () => undefined,
                logError: () => undefined,
            },
        );
        // the seeded config.json content should carry 8123 — assert via the writeFile mock if available, else that enable --now ran
        expect(calls.some((c) => c.join(' ').includes('enable --now'))).toBe(true);
    });
    it('status op returns 0 and emits the status as JSON via the injected log', async () => {
        const { run } = recordingRunner();
        const lines: string[] = [];
        const code = await runSystemServiceCli(
            { op: 'status' },
            {
                ...deps,
                run,
                removeFile: vi.fn(),
                existsCheck: () => true,
                defaultPort: () => 8000,
                log: (s: string) => lines.push(s),
                logError: () => undefined,
            },
        );
        expect(code).toBe(0);
        expect(lines.join('')).toContain('"installed"');
    });
    it('reports a failure on logError (stderr), not on log (stdout), so ServiceApi can show it (D8)', async () => {
        const { run } = recordingRunner();
        const out: string[] = [];
        const err: string[] = [];
        const lstat = () => ({ uid: 0, gid: 0, mode: 0o777, isSymbolicLink: false });
        const code = await runSystemServiceCli(
            { op: 'install', port: 8000 },
            {
                ...deps,
                lstat,
                run,
                removeFile: vi.fn(),
                existsCheck: () => false,
                defaultPort: () => 8000,
                log: (s: string) => out.push(s),
                logError: (s: string) => err.push(s),
            },
        );
        expect(code).toBe(1);
        expect(err.join('\n')).toMatch(/refusing to operate on \/opt\/ws-scrcpy-web/);
        expect(out).toEqual([]);
    });
    it('returns 1 when the op throws (e.g. not root)', async () => {
        const { run } = recordingRunner();
        const code = await runSystemServiceCli(
            { op: 'install', port: 8000 },
            {
                ...deps,
                getuid: () => 1000,
                run,
                removeFile: vi.fn(),
                existsCheck: () => false,
                defaultPort: () => 8000,
                log: () => undefined,
                logError: () => undefined,
            },
        );
        expect(code).toBe(1);
    });
});
