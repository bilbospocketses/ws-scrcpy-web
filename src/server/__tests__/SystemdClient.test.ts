/**
 * SystemdClient unit tests (SP3 P4b).
 *
 * Mocks all side-effect calls — #32: execFile (callback-style, for the
 * promisified execFileAsync), fs.promises.{writeFile,unlink,mkdir,copyFile,
 * chmod,rename,lstat}, the async fileExists helper, and os.{homedir,userInfo}
 * — so tests never touch the real systemd or filesystem. resolveSystemTool's
 * fs.existsSync stays real (it resolves OS tools; on a Windows test host the
 * Linux tools are absent so it returns the bare name the assertions expect).
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
// module receives mocked deps at evaluation time. #32: SystemdClient now uses
// execFileAsync (promisify(execFile)), fs.promises.*, and the async fileExists
// helper.
const execFileMock = vi.fn(
    (
        _cmd: string,
        _args: string[],
        _opts: unknown,
        cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
    ) => cb(null, { stdout: '', stderr: '' }),
);
vi.mock('node:child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...(args as Parameters<typeof execFileMock>)),
}));

const writeFileMock = vi.fn();
const unlinkMock = vi.fn();
const mkdirMock = vi.fn();
const copyFileMock = vi.fn();
const chmodMock = vi.fn();
const renameMock = vi.fn();
const lstatMock = vi.fn();
// Keep real fs (existsSync — resolveSystemTool resolves OS tools through it) and
// override only the fs.promises members SystemdClient writes through (#32).
vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    const promises = {
        ...actual.promises,
        writeFile: (...args: unknown[]) => writeFileMock(...args),
        unlink: (...args: unknown[]) => unlinkMock(...args),
        mkdir: (...args: unknown[]) => mkdirMock(...args),
        copyFile: (...args: unknown[]) => copyFileMock(...args),
        chmod: (...args: unknown[]) => chmodMock(...args),
        rename: (...args: unknown[]) => renameMock(...args),
        lstat: (...args: unknown[]) => lstatMock(...args),
    };
    return { ...actual, promises, default: { ...actual, promises } };
});

// existsSync → fileExists (async, #32). Mock the helper so unit-file / tray /
// pkg-manager existence is a resolved boolean.
const fileExistsMock = vi.fn();
vi.mock('../util/fsExists', () => ({
    fileExists: (...args: unknown[]) => fileExistsMock(...args),
}));

const homedirMock = vi.fn(() => '/home/jamie');
const userInfoMock = vi.fn(() => ({ username: 'jamie' }));
vi.mock('node:os', () => ({
    homedir: () => homedirMock(),
    userInfo: () => userInfoMock(),
    tmpdir: () => '/tmp',
}));

// resolveSystemTool resolves OS tools (systemctl/loginctl/ldconfig) to an
// absolute path when they exist on the host — which they DO on the Linux CI
// runner (e.g. /usr/bin/systemctl) but not on a Windows dev box. Stub it to the
// bare name so the `c[0] === 'systemctl'` / 'loginctl' assertions below are
// host-independent (otherwise they pass locally and fail in CI).
vi.mock('../service/systemTools', async () => {
    const actual = await vi.importActual<typeof import('../service/systemTools')>('../service/systemTools');
    return { ...actual, resolveSystemTool: (t: string) => t };
});

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
        execFileMock.mockReset();
        execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));
        fileExistsMock.mockReset().mockResolvedValue(false);
        writeFileMock.mockReset();
        unlinkMock.mockReset();
        mkdirMock.mockReset();
        copyFileMock.mockReset();
        chmodMock.mockReset();
        renameMock.mockReset();
        lstatMock.mockReset().mockRejectedValue(new Error('ENOENT'));
        homedirMock.mockReset().mockReturnValue('/home/jamie');
        userInfoMock.mockReset().mockReturnValue({ username: 'jamie' });
        savedGetuid = process.getuid;
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
            fileExistsMock.mockResolvedValue(false);
            const client = new SystemdClient();
            await client.install({ ...baseOpts, scope: 'user' });

            // F1: the source AppImage is copied to a stable per-user bin dir + chmod +x.
            // NEVER ExecStart the volatile launch path. The bin path is a Linux
            // forward-slash string regardless of test host.
            const stableBin = '/home/jamie/.local/share/WsScrcpyWeb/bin/WsScrcpyWeb.AppImage';
            // #31 atomic stage: copy to a temp file, chmod +x, then rename into place.
            const tmpArg = expect.stringContaining(`${stableBin}.tmp-`);
            expect(copyFileMock).toHaveBeenCalledWith(baseOpts.binPath, tmpArg);
            expect(chmodMock).toHaveBeenCalledWith(tmpArg, 0o755);
            expect(renameMock).toHaveBeenCalledWith(tmpArg, stableBin);

            // Unit file written to ~/.config/systemd/user/WsScrcpyWeb.service ...
            const unitWrites = writeFileMock.mock.calls.filter((c) =>
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
            const sysCalls = execFileMock.mock.calls.filter((c) => c[0] === 'systemctl');
            expect(sysCalls).toHaveLength(2);
            expect(sysCalls[0]![1]).toEqual(['--user', 'daemon-reload']);
            // F4: user scope enables but does NOT --now (the handoff helper starts it).
            expect(sysCalls[1]![1]).toEqual([
                '--user',
                'enable',
                'WsScrcpyWeb.service',
            ]);

            // loginctl enable-linger called
            const loginctlCalls = execFileMock.mock.calls.filter(
                (c) => c[0] === 'loginctl',
            );
            expect(loginctlCalls).toHaveLength(1);
            expect(loginctlCalls[0]![1]).toEqual(['enable-linger', 'jamie']);

            // F2: NO tray autostart written when no tray binary is found (Linux
            // has no tray — never emit a PATH-reliant bare-name Exec).
            const desktopWrites = writeFileMock.mock.calls.filter((c) =>
                String(c[0]).endsWith('ws-scrcpy-web-tray.desktop'),
            );
            expect(desktopWrites).toHaveLength(0);
        });

        it('user scope with a machine-wide /opt install present: ExecStart is the /opt binary, no staging copy', async () => {
            // F1 case A: the stable /opt binary already exists → reuse it (0755, bin_t).
            const optBin = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
            // #31: reuse requires lstat to confirm a safe root-owned regular file.
            lstatMock.mockImplementation((p: unknown) => {
                if (String(p).replace(/\\/g, '/') === optBin) {
                    return Promise.resolve({ isFile: () => true, uid: 0, mode: 0o755 });
                }
                return Promise.reject(new Error('ENOENT'));
            });
            const client = new SystemdClient();
            await client.install({ ...baseOpts, scope: 'user' });

            // No copy — the /opt binary is used directly.
            expect(copyFileMock).not.toHaveBeenCalled();
            const unitWrites = writeFileMock.mock.calls.filter((c) =>
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
            fileExistsMock.mockImplementation((p: unknown) => Promise.resolve(p === trayCandidate));
            const client = new SystemdClient();
            await client.install({ ...baseOpts, scope: 'user' });

            const desktopWrites = writeFileMock.mock.calls.filter((c) =>
                String(c[0]).endsWith('ws-scrcpy-web-tray.desktop'),
            );
            expect(desktopWrites).toHaveLength(1);
            const content = String(desktopWrites[0]![1]);
            expect(content).toContain(`Exec=${trayCandidate}`);
            // not the bare-name PATH fallback
            expect(content).not.toMatch(/^Exec=ws-scrcpy-web-tray$/m);
        });

        it('user scope: still succeeds when loginctl throws', async () => {
            fileExistsMock.mockResolvedValue(false);
            execFileMock.mockImplementation((cmd, _args, _opts, cb) => {
                if (cmd === 'loginctl') {
                    cb(new Error('loginctl not found'), { stdout: '', stderr: '' });
                    return;
                }
                cb(null, { stdout: '', stderr: '' });
            });
            const client = new SystemdClient();
            await expect(client.install({ ...baseOpts, scope: 'user' })).resolves.toBeUndefined();
        });

        it('system scope: throws (system-scope install now goes through systemServiceCli, not this method)', async () => {
            const client = new SystemdClient();
            await expect(client.install({ ...baseOpts, scope: 'system' })).rejects.toThrow(
                /no longer handles system scope/,
            );
            // No side-effects: no file writes, no systemctl calls.
            expect(writeFileMock).not.toHaveBeenCalled();
            expect(execFileMock).not.toHaveBeenCalled();
        });
    });

    describe('getInstalledScope', () => {
        // Match against the client's own path methods (not hardcoded strings) so
        // the mock comparison survives path.join's platform-specific separator
        // on the Windows dev host.
        it("returns 'user' when the user-scope unit file exists", async () => {
            const client = new SystemdClient();
            const userPath = client.userUnitPath('WsScrcpyWeb');
            fileExistsMock.mockImplementation((p: unknown) => Promise.resolve(p === userPath));
            expect(await client.getInstalledScope('WsScrcpyWeb')).toBe('user');
        });

        it("returns 'system' when only the system-scope unit file exists", async () => {
            const client = new SystemdClient();
            const systemPath = client.systemUnitPath('WsScrcpyWeb');
            fileExistsMock.mockImplementation((p: unknown) => Promise.resolve(p === systemPath));
            expect(await client.getInstalledScope('WsScrcpyWeb')).toBe('system');
        });

        it('returns null when no unit file exists', async () => {
            fileExistsMock.mockResolvedValue(false);
            const client = new SystemdClient();
            expect(await client.getInstalledScope('WsScrcpyWeb')).toBeNull();
        });
    });

    describe('status', () => {
        it("returns 'not-installed' when neither unit file exists", async () => {
            fileExistsMock.mockResolvedValue(false);
            const client = new SystemdClient();
            await expect(client.status('WsScrcpyWeb')).resolves.toBe('not-installed');
            expect(execFileMock).not.toHaveBeenCalled();
        });

        it("returns 'running' when is-active outputs 'active'", async () => {
            fileExistsMock.mockImplementation((p: unknown) =>
                Promise.resolve(String(p).replace(/\\/g, '/').includes('/.config/systemd/user/')),
            );
            execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, { stdout: 'active\n', stderr: '' }));
            const client = new SystemdClient();
            await expect(client.status('WsScrcpyWeb')).resolves.toBe('running');
            expect(execFileMock.mock.calls[0]![1]).toEqual([
                '--user',
                'is-active',
                'WsScrcpyWeb.service',
            ]);
        });

        it("returns 'stopped' when is-active outputs 'inactive'", async () => {
            fileExistsMock.mockImplementation((p: unknown) =>
                Promise.resolve(String(p).replace(/\\/g, '/').includes('/.config/systemd/user/')),
            );
            execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, { stdout: 'inactive\n', stderr: '' }));
            const client = new SystemdClient();
            await expect(client.status('WsScrcpyWeb')).resolves.toBe('stopped');
        });

        it("returns 'stopped' when is-active exits non-zero", async () => {
            fileExistsMock.mockImplementation((p: unknown) =>
                Promise.resolve(String(p).replace(/\\/g, '/').includes('/.config/systemd/user/')),
            );
            execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(new Error('exit 3'), { stdout: '', stderr: '' }));
            const client = new SystemdClient();
            await expect(client.status('WsScrcpyWeb')).resolves.toBe('stopped');
        });

        it('uses system scope (no --user flag) when only system unit exists', async () => {
            fileExistsMock.mockImplementation((p: unknown) =>
                Promise.resolve(String(p).replace(/\\/g, '/').startsWith('/etc/systemd/system/')),
            );
            execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, { stdout: 'active\n', stderr: '' }));
            const client = new SystemdClient();
            await expect(client.status('WsScrcpyWeb')).resolves.toBe('running');
            expect(execFileMock.mock.calls[0]![1]).toEqual([
                'is-active',
                'WsScrcpyWeb.service',
            ]);
        });
    });

    describe('uninstall', () => {
        it('is a no-op when not installed (idempotent)', async () => {
            fileExistsMock.mockResolvedValue(false);
            const client = new SystemdClient();
            await expect(client.uninstall('WsScrcpyWeb')).resolves.toBeUndefined();
            expect(execFileMock).not.toHaveBeenCalled();
            expect(unlinkMock).not.toHaveBeenCalled();
        });

        it('user scope: disables, removes unit, daemon-reloads, removes autostart', async () => {
            fileExistsMock.mockImplementation((p: unknown) =>
                Promise.resolve(String(p).replace(/\\/g, '/').includes('/.config/systemd/user/')),
            );
            const client = new SystemdClient();
            await client.uninstall('WsScrcpyWeb');

            const sysCalls = execFileMock.mock.calls.filter((c) => c[0] === 'systemctl');
            expect(sysCalls[0]![1]).toEqual([
                '--user',
                'disable',
                '--now',
                'WsScrcpyWeb.service',
            ]);
            expect(sysCalls[1]![1]).toEqual(['--user', 'daemon-reload']);

            // Unit file unlinked + autostart .desktop unlinked. Normalize
            // backslashes since path.join on Windows host uses them.
            const unlinks = unlinkMock.mock.calls.map((c) =>
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
            fileExistsMock.mockImplementation((p: unknown) =>
                Promise.resolve(String(p).replace(/\\/g, '/').startsWith('/etc/systemd/system/')),
            );
            Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
            const client = new SystemdClient();
            await client.uninstall('WsScrcpyWeb');
            expect(execFileMock).toHaveBeenCalled();
            const pkexecCall = execFileMock.mock.calls[0]!;
            expect(pkexecCall[0]).toBe('pkexec');
        });

        it('tolerates systemctl disable failures (already stopped)', async () => {
            fileExistsMock.mockImplementation((p: unknown) =>
                Promise.resolve(String(p).replace(/\\/g, '/').includes('/.config/systemd/user/')),
            );
            let callCount = 0;
            execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
                callCount += 1;
                if (callCount === 1) {
                    cb(new Error('not loaded'), { stdout: '', stderr: '' });
                    return;
                }
                cb(null, { stdout: '', stderr: '' });
            });
            const client = new SystemdClient();
            await expect(client.uninstall('WsScrcpyWeb')).resolves.toBeUndefined();
            // unit file still removed
            expect(unlinkMock).toHaveBeenCalled();
        });
    });

    describe('stop / restart', () => {
        it('stop is a no-op when not installed', async () => {
            fileExistsMock.mockResolvedValue(false);
            const client = new SystemdClient();
            await expect(client.stop('WsScrcpyWeb')).resolves.toBeUndefined();
            expect(execFileMock).not.toHaveBeenCalled();
        });

        it('restart throws when not installed', async () => {
            fileExistsMock.mockResolvedValue(false);
            const client = new SystemdClient();
            await expect(client.restart('WsScrcpyWeb')).rejects.toThrow(/not installed/);
        });

        it('restart calls systemctl --user restart for user scope', async () => {
            fileExistsMock.mockImplementation((p: unknown) =>
                Promise.resolve(String(p).replace(/\\/g, '/').includes('/.config/systemd/user/')),
            );
            const client = new SystemdClient();
            await client.restart('WsScrcpyWeb');
            expect(execFileMock.mock.calls[0]![1]).toEqual([
                '--user',
                'restart',
                'WsScrcpyWeb.service',
            ]);
        });
    });
});
