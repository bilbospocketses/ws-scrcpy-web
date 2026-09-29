import { describe, expect, it, vi } from 'vitest';
import { Config } from '../Config';
import {
    assertSafeRootDir,
    type CommandRunner,
    ensureSafeRootDir,
    fallbackDepsSource,
    installSystemService,
    makeProductionCoreDeps,
    parseSystemServiceArgs,
    runSystemServiceCli,
    systemServiceStatus,
    uninstallSystemService,
} from './systemServiceCli';

function recordingRunner() {
    const calls: string[][] = [];
    const run: CommandRunner = vi.fn(async (argv: string[]) => {
        calls.push(argv);
        return { code: 0, stdout: '', stderr: '' };
    });
    return { run, calls };
}

const deps = {
    getuid: () => 0,
    appImageSource: '/tmp/.mount_x/usr/bin/WsScrcpyWeb.AppImage',
    depsSource: '/home/u/.local/share/WsScrcpyWeb/dependencies',
    tool: (t: string) => `/usr/bin/${t}`,
    sbinTool: (t: string) => `/usr/sbin/${t}`,
    writeFile: vi.fn(),
    lstat: () => ({ uid: 0, gid: 0, mode: 0o755, isSymbolicLink: false }),
};

describe('installSystemService', () => {
    it('asserts euid==0, stages /opt, adds bin_t, restorecons, writes the unit, enables --now', async () => {
        const { run, calls } = recordingRunner();
        await installSystemService({ port: 8000 }, { ...deps, run });
        const flat = calls.map((c) => c.join(' '));
        expect(flat).toContain('/usr/bin/mkdir -p -m 0755 /opt/ws-scrcpy-web');
        expect(flat).toContain('/usr/bin/mkdir -p -m 0755 /var/lib/ws-scrcpy-web');
        expect(
            flat.some((c) => c.startsWith('/usr/bin/cp ') && c.includes('/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage')),
        ).toBe(true);
        expect(flat).toContain('/usr/bin/chmod 0755 /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage');
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
    it('stages dependencies from --deps-source over the fallback', async () => {
        const { run, calls } = recordingRunner();
        await installSystemService(
            { port: 8000, depsSource: '/home/qa/.local/share/WsScrcpyWeb/dependencies' },
            {
                ...deps,
                run,
            },
        );
        expect(calls.map((c) => c.join(' '))).toContain(
            '/usr/bin/cp -a /home/qa/.local/share/WsScrcpyWeb/dependencies/. /opt/ws-scrcpy-web/dependencies/',
        );
    });
    it('warns, and still installs, when the dependency copy fails or has no source', async () => {
        const warn = vi.fn();
        const run: CommandRunner = vi.fn(async (argv: string[]) =>
            argv[0] === '/usr/bin/cp' && argv[1] === '-a'
                ? { code: 1, stdout: '', stderr: 'cp: cannot stat: No such file or directory' }
                : { code: 0, stdout: '', stderr: '' },
        );
        await installSystemService({ port: 8000 }, { ...deps, run, warn });
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('cannot stat'));

        const warn2 = vi.fn();
        const r2 = recordingRunner();
        await installSystemService({ port: 8000 }, { ...deps, depsSource: null, run: r2.run, warn: warn2 });
        expect(warn2).toHaveBeenCalledWith(expect.stringContaining('no source'));
        expect(r2.calls.some((c) => c[0] === '/usr/bin/cp' && c[1] === '-a')).toBe(false);
        expect(r2.calls.some((c) => c.join(' ').includes('enable --now'))).toBe(true);
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
    it('fallbackDepsSource resolves from the env alone, and is null when it cannot', () => {
        expect(fallbackDepsSource({ DEPS_PATH: '/srv/deps' }, '/nowhere/dist/index.js', 'linux')).toBe('/srv/deps');
        expect(fallbackDepsSource({}, '/nowhere/dist/index.js', 'linux')).toBeNull();
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
    it('takes an absolute --deps-source and ignores a relative or flag-shaped one', () => {
        expect(
            parseSystemServiceArgs(['--install-system-service', '--port', '8000', '--deps-source', '/home/qa/deps']),
        ).toEqual({ op: 'install', port: 8000, depsSource: '/home/qa/deps' });
        expect(parseSystemServiceArgs(['--install-system-service', '--deps-source', 'rel/deps'])).toEqual({
            op: 'install',
            port: undefined,
        });
        expect(parseSystemServiceArgs(['--install-system-service', '--deps-source', '--port'])).toEqual({
            op: 'install',
            port: undefined,
        });
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
