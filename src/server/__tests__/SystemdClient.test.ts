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
const execFileMock = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, result: { stdout: string; stderr: string }) => void) => {
    cb(null, { stdout: '', stderr: '' });
});
vi.mock('node:child_process', () => ({
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
    execFile: (...args: unknown[]) => execFileMock(...(args as Parameters<typeof execFileMock>)),
}));

const existsSyncMock = vi.fn();
const writeFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const mkdirSyncMock = vi.fn();
const copyFileSyncMock = vi.fn();
const chmodSyncMock = vi.fn();
vi.mock('node:fs', () => ({
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
    unlinkSync: (...args: unknown[]) => unlinkSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
    copyFileSync: (...args: unknown[]) => copyFileSyncMock(...args),
    chmodSync: (...args: unknown[]) => chmodSyncMock(...args),
}));

const homedirMock = vi.fn(() => '/home/jamie');
const userInfoMock = vi.fn(() => ({ username: 'jamie' }));
vi.mock('node:os', () => ({
    homedir: () => homedirMock(),
    userInfo: () => userInfoMock(),
    tmpdir: () => '/tmp',
}));

import * as path from 'node:path';
import { renderUnitFile, SystemdClient, STAGED_SYSTEM_DIR, STAGED_SYSTEM_APPIMAGE } from '../service/SystemdClient';
import type { ServiceInstallOptions } from '../service/ServiceClient';

const baseOpts: ServiceInstallOptions = {
    name: 'WsScrcpyWeb',
    displayName: 'ws-scrcpy-web',
    description: 'ws-scrcpy-web — browser-based scrcpy front-end for Android devices.',
    binPath: '/opt/ws-scrcpy-web/ws-scrcpy-web-launcher',
    startupDir: '/opt/ws-scrcpy-web',
    startType: 'Automatic',
    maxRestartAttempts: 3,
    envVars: { DEPS_PATH: '/opt/ws-scrcpy-web/dependencies' },
    logPath: '/opt/ws-scrcpy-web/dependencies/service.log',
    // F1: user-scope staging needs a dataRoot to copy a stable binary into
    // when no machine-wide /opt binary exists.
    dataRoot: '/home/jamie/.local/share/WsScrcpyWeb',
};

describe('SystemdClient', () => {
    let savedGetuid: typeof process.getuid | undefined;

    beforeEach(() => {
        execFileSyncMock.mockReset();
        existsSyncMock.mockReset();
        writeFileSyncMock.mockReset();
        unlinkSyncMock.mockReset();
        mkdirSyncMock.mockReset();
        copyFileSyncMock.mockReset();
        chmodSyncMock.mockReset();
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

        it('user scope (no machine-wide install): stages a stable binary under <dataRoot>/bin, points ExecStart there, daemon-reload + enable + loginctl', async () => {
            // No /opt binary and no tray binary on disk → F1 copy branch + F2 skip.
            existsSyncMock.mockReturnValue(false);
            const client = new SystemdClient();
            await client.install({ ...baseOpts, scope: 'user' });

            // F1: the source AppImage is copied to a stable per-user bin dir + chmod +x.
            // NEVER ExecStart the volatile launch path. The bin path is a Linux
            // forward-slash string regardless of test host.
            const stableBin = '/home/jamie/.local/share/WsScrcpyWeb/bin/WsScrcpyWeb.AppImage';
            expect(copyFileSyncMock).toHaveBeenCalledWith(baseOpts.binPath, stableBin);
            expect(chmodSyncMock).toHaveBeenCalledWith(stableBin, 0o755);

            // Unit file written to ~/.config/systemd/user/WsScrcpyWeb.service ...
            const unitWrites = writeFileSyncMock.mock.calls.filter((c) =>
                String(c[0]).endsWith('WsScrcpyWeb.service'),
            );
            expect(unitWrites).toHaveLength(1);
            // path.join uses backslashes on Windows host; normalize for the
            // assertion since the runtime target is Linux.
            expect(String(unitWrites[0]![0]).replace(/\\/g, '/')).toBe(
                '/home/jamie/.config/systemd/user/WsScrcpyWeb.service',
            );
            expect(unitWrites[0]![2]).toEqual({ mode: 0o644 });
            // ... with ExecStart at the stable copy, not the source binPath.
            expect(String(unitWrites[0]![1])).toContain(`ExecStart=${stableBin}`);

            // systemctl --user daemon-reload + enable --now
            const sysCalls = execFileSyncMock.mock.calls.filter((c) => c[0] === 'systemctl');
            expect(sysCalls).toHaveLength(2);
            expect(sysCalls[0]![1]).toEqual(['--user', 'daemon-reload']);
            // F4: user scope enables but does NOT --now (the handoff helper starts it).
            expect(sysCalls[1]![1]).toEqual([
                '--user',
                'enable',
                'WsScrcpyWeb.service',
            ]);

            // loginctl enable-linger called
            const loginctlCalls = execFileSyncMock.mock.calls.filter(
                (c) => c[0] === 'loginctl',
            );
            expect(loginctlCalls).toHaveLength(1);
            expect(loginctlCalls[0]![1]).toEqual(['enable-linger', 'jamie']);

            // F2: NO tray autostart written when no tray binary is found (Linux
            // has no tray — never emit a PATH-reliant bare-name Exec).
            const desktopWrites = writeFileSyncMock.mock.calls.filter((c) =>
                String(c[0]).endsWith('ws-scrcpy-web-tray.desktop'),
            );
            expect(desktopWrites).toHaveLength(0);
        });

        it('user scope with a machine-wide /opt install present: ExecStart is the /opt binary, no staging copy', async () => {
            // F1 case A: the stable /opt binary already exists → reuse it (0755, bin_t).
            const optBin = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
            existsSyncMock.mockImplementation(
                (p: string) => String(p).replace(/\\/g, '/') === optBin,
            );
            const client = new SystemdClient();
            await client.install({ ...baseOpts, scope: 'user' });

            // No copy — the /opt binary is used directly.
            expect(copyFileSyncMock).not.toHaveBeenCalled();
            const unitWrites = writeFileSyncMock.mock.calls.filter((c) =>
                String(c[0]).endsWith('WsScrcpyWeb.service'),
            );
            expect(String(unitWrites[0]![1])).toContain(`ExecStart=${optBin}`);
            // never the volatile launch path
            expect(String(unitWrites[0]![1])).not.toContain(`ExecStart=${baseOpts.binPath}`);
        });

        it('user scope: writes an ABSOLUTE-path tray autostart when a tray binary exists (never a bare PATH name)', async () => {
            // F2 positive branch: a tray binary next to the launcher (cwd) →
            // Exec is its absolute path; the /opt binary is absent so install
            // still completes via the F1 copy branch.
            const trayCandidate = path.join(process.cwd(), 'ws-scrcpy-web-tray');
            existsSyncMock.mockImplementation((p: string) => p === trayCandidate);
            const client = new SystemdClient();
            await client.install({ ...baseOpts, scope: 'user' });

            const desktopWrites = writeFileSyncMock.mock.calls.filter((c) =>
                String(c[0]).endsWith('ws-scrcpy-web-tray.desktop'),
            );
            expect(desktopWrites).toHaveLength(1);
            const content = String(desktopWrites[0]![1]);
            expect(content).toContain(`Exec=${trayCandidate}`);
            // not the bare-name PATH fallback
            expect(content).not.toMatch(/^Exec=ws-scrcpy-web-tray$/m);
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
            expect(String(unitWrites[0]![0]).replace(/\\/g, '/')).toBe(
                '/etc/systemd/system/WsScrcpyWeb.service',
            );

            const sysCalls = execFileSyncMock.mock.calls.filter((c) => c[0] === 'systemctl');
            expect(sysCalls).toHaveLength(2);
            expect(sysCalls[0]![1]).toEqual(['daemon-reload']);
            // B1: enable (persist) but NOT --now — the local instance still holds the
            // web port; a rootful handoff helper starts the service after it exits.
            expect(sysCalls[1]![1]).toEqual(['enable', 'WsScrcpyWeb.service']);

            // B1: the rootful systemd-run install-handoff is spawned (transient unit
            // name carries Date.now(), so assert the stable flags + helper + scope).
            const handoffCalls = execFileSyncMock.mock.calls.filter((c) => c[0] === 'systemd-run');
            expect(handoffCalls).toHaveLength(1);
            const handoffArgs = (handoffCalls[0]![1] as string[]).join(' ');
            expect(handoffArgs).toContain('--collect');
            expect(handoffArgs).toContain('--setenv=DATA_ROOT=/var/lib/ws-scrcpy-web');
            expect(handoffArgs).toContain(
                '/opt/ws-scrcpy-web/ws-scrcpy-web-launcher.exe --linux-service-install-handoff --scope system --unit WsScrcpyWeb',
            );

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

        it('system scope as non-root: uses pkexec for privilege escalation', async () => {
            Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
            const client = new SystemdClient();
            await client.install({ ...baseOpts, scope: 'system' });
            // Should write tmp file then call execFile (pkexec), not execFileSync (direct systemctl)
            expect(writeFileSyncMock).toHaveBeenCalled();
            expect(execFileMock).toHaveBeenCalled();
            const pkexecCall = execFileMock.mock.calls[0]!;
            expect(pkexecCall[0]).toBe('pkexec');
        });
    });

    describe('getInstalledScope', () => {
        // Match against the client's own path methods (not hardcoded strings) so
        // the mock comparison survives path.join's platform-specific separator
        // on the Windows dev host.
        it("returns 'user' when the user-scope unit file exists", async () => {
            const client = new SystemdClient();
            const userPath = client.userUnitPath('WsScrcpyWeb');
            existsSyncMock.mockImplementation((p: string) => p === userPath);
            expect(await client.getInstalledScope('WsScrcpyWeb')).toBe('user');
        });

        it("returns 'system' when only the system-scope unit file exists", async () => {
            const client = new SystemdClient();
            const systemPath = client.systemUnitPath('WsScrcpyWeb');
            existsSyncMock.mockImplementation((p: string) => p === systemPath);
            expect(await client.getInstalledScope('WsScrcpyWeb')).toBe('system');
        });

        it('returns null when no unit file exists', async () => {
            existsSyncMock.mockReturnValue(false);
            const client = new SystemdClient();
            expect(await client.getInstalledScope('WsScrcpyWeb')).toBeNull();
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
            expect(execFileSyncMock.mock.calls[0]![1]).toEqual([
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
            expect(execFileSyncMock.mock.calls[0]![1]).toEqual([
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
            expect(sysCalls[0]![1]).toEqual([
                '--user',
                'disable',
                '--now',
                'WsScrcpyWeb.service',
            ]);
            expect(sysCalls[1]![1]).toEqual(['--user', 'daemon-reload']);

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

        it('system scope as non-root: uses pkexec for privilege escalation', async () => {
            existsSyncMock.mockImplementation(
                (p: string) =>
                    String(p).startsWith('/etc/systemd/system/') ||
                    String(p).replace(/\\/g, '/').startsWith('/etc/systemd/system/'),
            );
            Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
            const client = new SystemdClient();
            await client.uninstall('WsScrcpyWeb');
            expect(execFileMock).toHaveBeenCalled();
            const pkexecCall = execFileMock.mock.calls[0]!;
            expect(pkexecCall[0]).toBe('pkexec');
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
            expect(execFileSyncMock.mock.calls[0]![1]).toEqual([
                '--user',
                'restart',
                'WsScrcpyWeb.service',
            ]);
        });
    });
});
