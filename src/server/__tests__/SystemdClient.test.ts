/**
 * SystemdClient unit tests (SP3 P4b).
 *
 * Mocks all side-effect calls — execFileSync, fs.{existsSync,writeFileSync,
 * unlinkSync,mkdirSync}, os.{homedir,userInfo}, process.getuid — so tests
 * never touch the real systemd or filesystem.
 *
 * Coverage matrix:
 *   - User-scope install: writes correct unit file path/content, calls
 *     daemon-reload + enable --now + loginctl enable-linger, no root needed
 *   - System-scope install as root: writes /etc path, no --user flag, no loginctl
 *   - System-scope install as non-root: throws BEFORE any side-effect
 *   - Status: 'running' when is-active=active; 'stopped' when inactive or non-zero
 *     exit; 'not-installed' when neither unit file exists
 *   - Uninstall: resolves scope from existing unit file, disables + removes it
 *   - Uninstall idempotence: not-installed -> no-op
 *   - renderUnitFile snapshot: known input -> expected ini lines
 *   - loginctl failure tolerance: install still succeeds when loginctl throws
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mocks — must be declared before the SystemdClient import so the
// module receives mocked deps at evaluation time.
const execFileSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

const existsSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
vi.mock('node:fs', () => ({
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
    unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
}));

const homedirMock = vi.fn(() => '/home/jamie');
const userInfoMock = vi.fn(() => ({ username: 'jamie' }));
vi.mock('node:os', () => ({
    homedir: () => homedirMock(),
    userInfo: () => userInfoMock(),
}));

import { renderUnitFile, SystemdClient } from '../service/SystemdClient';
import type { ServiceInstallOptions } from '../service/ServiceClient';

const baseOpts: ServiceInstallOptions = {
    name: 'WsScrcpyWeb',
    displayName: 'ws-scrcpy-web',
    description: 'ws-scrcpy-web — browser-based scrcpy front-end for Android devices.',
    binPath: '/opt/ws-scrcpy-web/ws-scrcpy-web-launcher',
    account: 'currentUser',
    startType: 'Automatic',
    maxRestartAttempts: 3,
    envVars: { DEPS_PATH: '/opt/ws-scrcpy-web/dependencies' },
    logPath: '/opt/ws-scrcpy-web/dependencies/service.log',
};

describe('SystemdClient', () => {
    let savedGetuid: typeof process.getuid | undefined;

    beforeEach(() => {
        execFileSyncMock.mockReset();
        existsSyncMock.mockReset();
        writeFileSyncMock.mockReset();
        unlinkSyncMock.mockReset();
        mkdirSyncMock.mockReset();
        homedirMock.mockReset().mockReturnValue('/home/jamie');
        userInfoMock.mockReset().mockReturnValue({ username: 'jamie' });
        savedGetuid = process.getuid;
        execFileSyncMock.mockReturnValue(Buffer.from('', 'utf8'));
    });

    afterEach(() => {
        if (savedGetuid) {
            Object.defineProperty(process, 'getuid', { value: savedGetuid, configurable: true });
        }
    });

    describe('renderUnitFile', () => {
        it('renders user-scope unit with default.target and Environment lines', () => {
            const out = renderUnitFile(baseOpts, 'user');
            expect(out).toContain(
                'Description=ws-scrcpy-web — browser-based scrcpy front-end for Android devices.',
            );
            expect(out).toContain('ExecStart=/opt/ws-scrcpy-web/ws-scrcpy-web-launcher');
            expect(out).toContain('Environment=DEPS_PATH=/opt/ws-scrcpy-web/dependencies');
            expect(out).toContain('StartLimitBurst=3');
            expect(out).toContain('StartLimitIntervalSec=300');
            expect(out).toContain(
                'StandardOutput=append:/opt/ws-scrcpy-web/dependencies/service.log',
            );
            expect(out).toContain(
                'StandardError=append:/opt/ws-scrcpy-web/dependencies/service.log',
            );
            expect(out).toContain('WantedBy=default.target');
            expect(out).not.toContain('multi-user.target');
        });

        it('renders system-scope unit with multi-user.target', () => {
            const out = renderUnitFile(baseOpts, 'system');
            expect(out).toContain('WantedBy=multi-user.target');
            expect(out).not.toContain('default.target');
        });

        it('omits Environment lines when envVars is empty', () => {
            const out = renderUnitFile({ ...baseOpts, envVars: {} }, 'user');
            expect(out).not.toContain('Environment=');
        });
    });

    describe('install', () => {
        it('throws when scope is undefined', async () => {
            const client = new SystemdClient();
            await expect(client.install({ ...baseOpts, scope: undefined })).rejects.toThrow(
                /scope is required/,
            );
        });

        it('user scope: writes ~/.config/systemd/user/ unit, calls daemon-reload + enable + loginctl', async () => {
            // Tray helper resolution: pretend neither candidate exists so we
            // hit the bare-name fallback (still writes the .desktop file, just
            // logs a warning).
            existsSyncMock.mockReturnValue(false);
            const client = new SystemdClient();
            await client.install({ ...baseOpts, scope: 'user' });

            // Unit file written to ~/.config/systemd/user/WsScrcpyWeb.service
            const unitWrites = writeFileSyncMock.mock.calls.filter((c) =>
                String(c[0]).endsWith('WsScrcpyWeb.service'),
            );
            expect(unitWrites).toHaveLength(1);
            // path.join uses backslashes on Windows host; normalize for the
            // assertion since the runtime target is Linux.
            expect(String(unitWrites[0][0]).replace(/\\/g, '/')).toBe(
                '/home/jamie/.config/systemd/user/WsScrcpyWeb.service',
            );
            expect(unitWrites[0][2]).toEqual({ mode: 0o644 });

            // systemctl --user daemon-reload + enable --now
            const sysCalls = execFileSyncMock.mock.calls.filter((c) => c[0] === 'systemctl');
            expect(sysCalls).toHaveLength(2);
            expect(sysCalls[0][1]).toEqual(['--user', 'daemon-reload']);
            expect(sysCalls[1][1]).toEqual([
                '--user',
                'enable',
                '--now',
                'WsScrcpyWeb.service',
            ]);

            // loginctl enable-linger called
            const loginctlCalls = execFileSyncMock.mock.calls.filter(
                (c) => c[0] === 'loginctl',
            );
            expect(loginctlCalls).toHaveLength(1);
            expect(loginctlCalls[0][1]).toEqual(['enable-linger', 'jamie']);

            // Tray autostart .desktop written
            const desktopWrites = writeFileSyncMock.mock.calls.filter((c) =>
                String(c[0]).endsWith('ws-scrcpy-web-tray.desktop'),
            );
            expect(desktopWrites).toHaveLength(1);
            expect(String(desktopWrites[0][0]).replace(/\\/g, '/')).toBe(
                '/home/jamie/.config/autostart/ws-scrcpy-web-tray.desktop',
            );
            expect(String(desktopWrites[0][1])).toContain('[Desktop Entry]');
            expect(String(desktopWrites[0][1])).toContain('Exec=ws-scrcpy-web-tray');
        });

        it('user scope: still succeeds when loginctl throws', async () => {
            existsSyncMock.mockReturnValue(false);
            execFileSyncMock.mockImplementation((cmd: string) => {
                if (cmd === 'loginctl') throw new Error('loginctl not found');
                return Buffer.from('');
            });
            const client = new SystemdClient();
            await expect(client.install({ ...baseOpts, scope: 'user' })).resolves.toBeUndefined();
        });

        it('system scope as root: writes /etc unit, no --user flag, no loginctl', async () => {
            Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
            existsSyncMock.mockReturnValue(false);
            const client = new SystemdClient();
            await client.install({ ...baseOpts, scope: 'system' });

            const unitWrites = writeFileSyncMock.mock.calls.filter((c) =>
                String(c[0]).endsWith('WsScrcpyWeb.service'),
            );
            expect(unitWrites).toHaveLength(1);
            // path.join on win32 dev hosts produces backslashes; normalize.
            expect(String(unitWrites[0][0]).replace(/\\/g, '/')).toBe(
                '/etc/systemd/system/WsScrcpyWeb.service',
            );

            const sysCalls = execFileSyncMock.mock.calls.filter((c) => c[0] === 'systemctl');
            expect(sysCalls).toHaveLength(2);
            expect(sysCalls[0][1]).toEqual(['daemon-reload']);
            expect(sysCalls[1][1]).toEqual(['enable', '--now', 'WsScrcpyWeb.service']);

            const loginctlCalls = execFileSyncMock.mock.calls.filter(
                (c) => c[0] === 'loginctl',
            );
            expect(loginctlCalls).toHaveLength(0);

            // No autostart .desktop for system scope.
            const desktopWrites = writeFileSyncMock.mock.calls.filter((c) =>
                String(c[0]).endsWith('ws-scrcpy-web-tray.desktop'),
            );
            expect(desktopWrites).toHaveLength(0);
        });

        it('system scope as non-root: throws before any side-effect', async () => {
            Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
            const client = new SystemdClient();
            await expect(client.install({ ...baseOpts, scope: 'system' })).rejects.toThrow(
                /system scope requires root/,
            );
            expect(writeFileSyncMock).not.toHaveBeenCalled();
            expect(execFileSyncMock).not.toHaveBeenCalled();
        });
    });

    describe('status', () => {
        it("returns 'not-installed' when neither unit file exists", async () => {
            existsSyncMock.mockReturnValue(false);
            const client = new SystemdClient();
            await expect(client.status('WsScrcpyWeb')).resolves.toBe('not-installed');
            expect(execFileSyncMock).not.toHaveBeenCalled();
        });

        it("returns 'running' when is-active outputs 'active'", async () => {
            existsSyncMock.mockImplementation((p: string) =>
                String(p).replace(/\\/g, '/').includes('/.config/systemd/user/'),
            );
            execFileSyncMock.mockReturnValue('active\n');
            const client = new SystemdClient();
            await expect(client.status('WsScrcpyWeb')).resolves.toBe('running');
            expect(execFileSyncMock.mock.calls[0][1]).toEqual([
                '--user',
                'is-active',
                'WsScrcpyWeb.service',
            ]);
        });

        it("returns 'stopped' when is-active outputs 'inactive'", async () => {
            existsSyncMock.mockImplementation((p: string) =>
                String(p).replace(/\\/g, '/').includes('/.config/systemd/user/'),
            );
            execFileSyncMock.mockReturnValue('inactive\n');
            const client = new SystemdClient();
            await expect(client.status('WsScrcpyWeb')).resolves.toBe('stopped');
        });

        it("returns 'stopped' when is-active exits non-zero", async () => {
            existsSyncMock.mockImplementation((p: string) =>
                String(p).replace(/\\/g, '/').includes('/.config/systemd/user/'),
            );
            execFileSyncMock.mockImplementation(() => {
                throw new Error('exit 3');
            });
            const client = new SystemdClient();
            await expect(client.status('WsScrcpyWeb')).resolves.toBe('stopped');
        });

        it('uses system scope (no --user flag) when only system unit exists', async () => {
            existsSyncMock.mockImplementation((p: string) =>
                String(p).startsWith('/etc/systemd/system/') ||
                String(p).replace(/\\/g, '/').startsWith('/etc/systemd/system/'),
            );
            execFileSyncMock.mockReturnValue('active\n');
            const client = new SystemdClient();
            await expect(client.status('WsScrcpyWeb')).resolves.toBe('running');
            expect(execFileSyncMock.mock.calls[0][1]).toEqual([
                'is-active',
                'WsScrcpyWeb.service',
            ]);
        });
    });

    describe('uninstall', () => {
        it('is a no-op when not installed (idempotent)', async () => {
            existsSyncMock.mockReturnValue(false);
            const client = new SystemdClient();
            await expect(client.uninstall('WsScrcpyWeb')).resolves.toBeUndefined();
            expect(execFileSyncMock).not.toHaveBeenCalled();
            expect(unlinkSyncMock).not.toHaveBeenCalled();
        });

        it('user scope: disables, removes unit, daemon-reloads, removes autostart', async () => {
            existsSyncMock.mockImplementation((p: string) =>
                String(p).replace(/\\/g, '/').includes('/.config/systemd/user/'),
            );
            const client = new SystemdClient();
            await client.uninstall('WsScrcpyWeb');

            const sysCalls = execFileSyncMock.mock.calls.filter((c) => c[0] === 'systemctl');
            expect(sysCalls[0][1]).toEqual([
                '--user',
                'disable',
                '--now',
                'WsScrcpyWeb.service',
            ]);
            expect(sysCalls[1][1]).toEqual(['--user', 'daemon-reload']);

            // Unit file unlinked + autostart .desktop unlinked. Normalize
            // backslashes since path.join on Windows host uses them.
            const unlinks = unlinkSyncMock.mock.calls.map((c) =>
                String(c[0]).replace(/\\/g, '/'),
            );
            expect(unlinks).toContain(
                '/home/jamie/.config/systemd/user/WsScrcpyWeb.service',
            );
            expect(unlinks).toContain(
                '/home/jamie/.config/autostart/ws-scrcpy-web-tray.desktop',
            );
        });

        it('system scope as non-root: throws', async () => {
            existsSyncMock.mockImplementation(
                (p: string) =>
                    String(p).startsWith('/etc/systemd/system/') ||
                    String(p).replace(/\\/g, '/').startsWith('/etc/systemd/system/'),
            );
            Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
            const client = new SystemdClient();
            await expect(client.uninstall('WsScrcpyWeb')).rejects.toThrow(
                /requires root/,
            );
        });

        it('tolerates systemctl disable failures (already stopped)', async () => {
            existsSyncMock.mockImplementation((p: string) =>
                String(p).replace(/\\/g, '/').includes('/.config/systemd/user/'),
            );
            let callCount = 0;
            execFileSyncMock.mockImplementation(() => {
                callCount += 1;
                if (callCount === 1) throw new Error('not loaded');
                return Buffer.from('');
            });
            const client = new SystemdClient();
            await expect(client.uninstall('WsScrcpyWeb')).resolves.toBeUndefined();
            // unit file still removed
            expect(unlinkSyncMock).toHaveBeenCalled();
        });
    });

    describe('stop / restart', () => {
        it('stop is a no-op when not installed', async () => {
            existsSyncMock.mockReturnValue(false);
            const client = new SystemdClient();
            await expect(client.stop('WsScrcpyWeb')).resolves.toBeUndefined();
            expect(execFileSyncMock).not.toHaveBeenCalled();
        });

        it('restart throws when not installed', async () => {
            existsSyncMock.mockReturnValue(false);
            const client = new SystemdClient();
            await expect(client.restart('WsScrcpyWeb')).rejects.toThrow(/not installed/);
        });

        it('restart calls systemctl --user restart for user scope', async () => {
            existsSyncMock.mockImplementation((p: string) =>
                String(p).replace(/\\/g, '/').includes('/.config/systemd/user/'),
            );
            const client = new SystemdClient();
            await client.restart('WsScrcpyWeb');
            expect(execFileSyncMock.mock.calls[0][1]).toEqual([
                '--user',
                'restart',
                'WsScrcpyWeb.service',
            ]);
        });
    });
});
