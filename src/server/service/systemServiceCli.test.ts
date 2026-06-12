import { describe, it, expect, vi } from 'vitest';
import { installSystemService, uninstallSystemService, systemServiceStatus, type CommandRunner } from './systemServiceCli';

function recordingRunner() {
    const calls: string[][] = [];
    const run: CommandRunner = vi.fn(async (argv: string[]) => { calls.push(argv); return { code: 0, stdout: '', stderr: '' }; });
    return { run, calls };
}

const deps = {
    getuid: () => 0,
    appImageSource: '/tmp/.mount_x/usr/bin/WsScrcpyWeb.AppImage',
    depsSource: '/home/u/.local/share/WsScrcpyWeb/dependencies',
    tool: (t: string) => `/usr/bin/${t}`,
    sbinTool: (t: string) => `/usr/sbin/${t}`,
    writeFile: vi.fn(),
};

describe('installSystemService', () => {
    it('asserts euid==0, stages /opt, adds bin_t, restorecons, writes the unit, enables --now', async () => {
        const { run, calls } = recordingRunner();
        await installSystemService({ port: 8000 }, { ...deps, run });
        const flat = calls.map((c) => c.join(' '));
        expect(flat).toContain('/usr/bin/mkdir -p /opt/ws-scrcpy-web');
        expect(flat).toContain('/usr/bin/mkdir -p /var/lib/ws-scrcpy-web');
        expect(flat.some((c) => c.startsWith('/usr/bin/cp ') && c.includes('/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage'))).toBe(true);
        expect(flat).toContain('/usr/bin/chmod 0755 /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage');
        expect(flat).toContain('/usr/sbin/semanage fcontext -a -t bin_t /opt/ws-scrcpy-web(/.*)?');
        expect(flat.some((c) => c.startsWith('/usr/sbin/restorecon -R') && c.includes('/opt/ws-scrcpy-web'))).toBe(true);
        expect(flat.some((c) => c.includes('var_lib_t'))).toBe(false);
        expect(deps.writeFile).toHaveBeenCalledWith('/etc/systemd/system/WsScrcpyWeb.service', expect.stringContaining('ExecStart=/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage'), expect.anything());
        expect(flat).toContain('/usr/bin/systemctl daemon-reload');
        expect(flat).toContain('/usr/bin/systemctl enable --now WsScrcpyWeb.service');
    });

    it('throws if not root', async () => {
        const { run } = recordingRunner();
        await expect(installSystemService({ port: 8000 }, { ...deps, getuid: () => 1000, run })).rejects.toThrow(/root|euid|sudo/i);
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
        await expect(uninstallSystemService({ keepState: false }, { ...deps, getuid: () => 1000, run, removeFile: vi.fn() })).rejects.toThrow(/root|euid|sudo/i);
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
