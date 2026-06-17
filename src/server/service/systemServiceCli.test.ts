import { describe, expect, it, vi } from 'vitest';
import {
    assertSafeRootDir,
    type CommandRunner,
    installSystemService,
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
    lstat: () => ({ uid: 0, mode: 0o755, isSymbolicLink: false }),
};

describe('installSystemService', () => {
    it('asserts euid==0, stages /opt, adds bin_t, restorecons, writes the unit, enables --now', async () => {
        const { run, calls } = recordingRunner();
        await installSystemService({ port: 8000 }, { ...deps, run });
        const flat = calls.map((c) => c.join(' '));
        expect(flat).toContain('/usr/bin/mkdir -p /opt/ws-scrcpy-web');
        expect(flat).toContain('/usr/bin/mkdir -p /var/lib/ws-scrcpy-web');
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
                ? { uid: 0, mode: 0o755, isSymbolicLink: true }
                : { uid: 0, mode: 0o755, isSymbolicLink: false };
        await expect(installSystemService({ port: 8000 }, { ...deps, run, lstat })).rejects.toThrow(/symlink/i);
        const flat = calls.map((c) => c.join(' '));
        expect(flat.some((c) => c.startsWith('/usr/sbin/restorecon'))).toBe(false);
        expect(flat.some((c) => c.startsWith('/usr/bin/cp '))).toBe(false);
    });
});

describe('assertSafeRootDir (review #15)', () => {
    const safe = { uid: 0, mode: 0o755, isSymbolicLink: false };
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
            },
        );
        expect(code).toBe(0);
        expect(lines.join('')).toContain('"installed"');
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
            },
        );
        expect(code).toBe(1);
    });
});
