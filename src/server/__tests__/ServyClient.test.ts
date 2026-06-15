import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist-safe mocks for runElevated. ServyClient no longer calls
// execFileSync for install/uninstall in v0.1.7 — those go through the
// elevated helper. Status still uses sc.exe (read-only, no admin) so we
// keep an execFileSync mock for that path.
const runElevatedMock = vi.fn();
vi.mock('../service/elevatedRunner', () => ({
    runElevated: (...args: unknown[]) => runElevatedMock(...args),
    resolveLauncherPath: () => 'C:\\fake\\install\\ws-scrcpy-web-launcher.exe',
}));

// status() now uses execFileAsync (promisify(execFile)) — #32. Mock execFile
// callback-style; promisify resolves with the 2nd callback arg ({ stdout, stderr })
// or rejects with the error when one is passed.
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

// existsSync → fileExists (async, #32). Mock the helper directly so existence
// is a resolved boolean, mirroring the prior existsSync mock's predicate.
const fileExistsMock = vi.fn();
vi.mock('../util/fsExists', () => ({
    fileExists: (...args: unknown[]) => fileExistsMock(...args),
}));

// resolveSystemTool resolves OS tools (incl. Windows `sc`) to an absolute
// System32 path; stub it deterministically so the status assertion is
// host-independent and proves status() no longer uses a bare PATH name.
vi.mock('../service/systemTools', () => ({
    resolveSystemTool: (t: string) => `RESOLVED:${t}`,
}));

import { parseScQueryStatus, ServiceInstallError, ServyClient } from '../service/ServyClient';

describe('ServyClient', () => {
    beforeEach(() => {
        runElevatedMock.mockReset();
        runElevatedMock.mockResolvedValue({ ok: true, exitCode: 0, stdout: '', stderr: '' });
        execFileMock.mockReset();
        execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, { stdout: '', stderr: '' }));
        fileExistsMock.mockReset();
        // Default: launcher present, tray helper absent.
        fileExistsMock.mockImplementation((p: unknown) =>
            Promise.resolve(String(p).endsWith('ws-scrcpy-web-launcher.exe')),
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('install delegates to runElevated with snake_case-able install args', async () => {
        const client = new ServyClient('C:\\fake\\servy-cli.exe');
        await client.install({
            name: 'WsScrcpyWeb',
            displayName: 'ws-scrcpy-web',
            description: 'desc',
            binPath: 'C:\\app\\launcher.exe',
            startupDir: 'C:\\app',
            startType: 'Automatic',
            maxRestartAttempts: 3,
            envVars: { DEPS_PATH: 'C:\\deps', FOO: 'bar' },
            logPath: 'C:\\app\\service.log',
        });
        expect(runElevatedMock).toHaveBeenCalledTimes(1);
        const [command, args] = runElevatedMock.mock.calls[0]!;
        expect(command).toBe('install-service');
        // args are passed in camelCase; runElevated converts to snake_case
        // before writing the JSON file. We assert the camelCase shape here
        // because that's the contract between ServyClient and runElevated.
        expect(args).toMatchObject({
            servyPath: 'C:\\fake\\servy-cli.exe',
            name: 'WsScrcpyWeb',
            displayName: 'ws-scrcpy-web',
            description: 'desc',
            binPath: 'C:\\app\\launcher.exe',
            startupDir: 'C:\\app',
            startupType: 'Automatic',
            maxRestartAttempts: 3,
            envVars: 'DEPS_PATH=C:\\deps;FOO=bar',
            logPath: 'C:\\app\\service.log',
        });
        // No execFile calls — install no longer touches servy-cli or
        // reg.exe directly; both go through the elevated helper.
        expect(execFileMock).not.toHaveBeenCalled();
    });

    it('install throws ServiceInstallError when runElevated returns ok=false', async () => {
        runElevatedMock.mockResolvedValue({
            ok: false,
            exitCode: 4,
            stdout: '',
            stderr: 'Service already exists',
            errorMessage: 'servy-cli install exited with code 1',
        });
        const client = new ServyClient('servy.exe');
        await expect(
            client.install({
                name: 'X',
                displayName: 'X',
                description: 'd',
                binPath: 'b',
                startupDir: 'd',
                startType: 'Automatic',
                maxRestartAttempts: 1,
                envVars: {},
                logPath: 'l',
            }),
        ).rejects.toThrow(ServiceInstallError);
    });

    it('install throws when packaged launcher is absent (dev runs)', async () => {
        fileExistsMock.mockResolvedValue(false);
        const client = new ServyClient('servy.exe');
        await expect(
            client.install({
                name: 'X',
                displayName: 'X',
                description: 'd',
                binPath: 'b',
                startupDir: 'd',
                startType: 'Automatic',
                maxRestartAttempts: 1,
                envVars: {},
                logPath: 'l',
            }),
        ).rejects.toThrow(/packaged launcher binary/);
        expect(runElevatedMock).not.toHaveBeenCalled();
    });

    it('install passes trayHelperPath when the tray exe exists in install root', async () => {
        fileExistsMock.mockImplementation((p: unknown) => {
            const s = String(p);
            // launcher AND tray helper both present
            return Promise.resolve(
                s.endsWith('ws-scrcpy-web-launcher.exe') ||
                    s.endsWith('ws-scrcpy-web-tray.exe'),
            );
        });
        const client = new ServyClient('servy.exe');
        await client.install({
            name: 'X',
            displayName: 'X',
            description: 'd',
            binPath: 'b',
            startupDir: 'd',
            startType: 'Automatic',
            maxRestartAttempts: 1,
            envVars: {},
            logPath: 'l',
        });
        const [, args] = runElevatedMock.mock.calls[0]!;
        expect((args as { trayHelperPath?: string }).trayHelperPath).toMatch(/ws-scrcpy-web-tray\.exe$/);
    });

    it('install passes undefined trayHelperPath when tray exe is absent', async () => {
        // Default existsSync mock returns true only for launcher.
        const client = new ServyClient('servy.exe');
        await client.install({
            name: 'X',
            displayName: 'X',
            description: 'd',
            binPath: 'b',
            startupDir: 'd',
            startType: 'Automatic',
            maxRestartAttempts: 1,
            envVars: {},
            logPath: 'l',
        });
        const [, args] = runElevatedMock.mock.calls[0]!;
        expect((args as { trayHelperPath?: string }).trayHelperPath).toBeUndefined();
    });

    it('uninstall delegates to runElevated', async () => {
        const client = new ServyClient('servy.exe');
        await client.uninstall('WsScrcpyWeb');
        expect(runElevatedMock).toHaveBeenCalledTimes(1);
        const [command, args] = runElevatedMock.mock.calls[0]!;
        expect(command).toBe('uninstall-service');
        expect(args).toEqual({ servyPath: 'servy.exe', name: 'WsScrcpyWeb' });
    });

    it('uninstall throws ServiceInstallError when helper reports failure', async () => {
        runElevatedMock.mockResolvedValue({
            ok: false,
            exitCode: 4,
            stdout: '',
            stderr: 'Service does not exist',
            errorMessage: 'servy-cli uninstall exited with code 1',
        });
        const client = new ServyClient('servy.exe');
        await expect(client.uninstall('WsScrcpyWeb')).rejects.toThrow(ServiceInstallError);
    });

    it('status uses sc.exe query and parses RUNNING', async () => {
        const out = [
            'SERVICE_NAME: WsScrcpyWeb',
            '        TYPE               : 10  WIN32_OWN_PROCESS',
            '        STATE              : 4  RUNNING',
            '        WIN32_EXIT_CODE    : 0  (0x0)',
        ].join('\r\n');
        execFileMock.mockImplementation((_cmd, _args, _opts, cb) => cb(null, { stdout: out, stderr: '' }));
        const client = new ServyClient('servy.exe');
        const status = await client.status('WsScrcpyWeb');
        expect(status).toBe('running');
        const [cmd, args] = execFileMock.mock.calls[0]!;
        // #20-class fix: 'sc' resolves to an absolute System32 path via
        // resolveSystemTool, never the bare PATH name (no binary-hijack on the poll).
        expect(cmd).toBe('RESOLVED:sc');
        expect(args).toEqual(['query', 'WsScrcpyWeb']);
    });

    it('status returns stopped for STATE=1 (STOPPED)', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb) =>
            cb(null, { stdout: 'STATE              : 1  STOPPED', stderr: '' }),
        );
        const client = new ServyClient('servy.exe');
        expect(await client.status('WsScrcpyWeb')).toBe('stopped');
    });

    it('status returns not-installed when sc.exe exits 1060', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
            const err = new Error('Command failed') as Error & {
                code: number;
                stderr: string;
            };
            err.code = 1060;
            err.stderr = '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\nThe specified service does not exist as an installed service.';
            cb(err, { stdout: '', stderr: '' });
        });
        const client = new ServyClient('servy.exe');
        expect(await client.status('WsScrcpyWeb')).toBe('not-installed');
    });

    it('status rethrows other sc.exe errors', async () => {
        execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
            const err = new Error('Command failed') as Error & {
                code: number;
                stderr: string;
            };
            err.code = 5;
            err.stderr = 'Access is denied.';
            cb(err, { stdout: '', stderr: '' });
        });
        const client = new ServyClient('servy.exe');
        await expect(client.status('WsScrcpyWeb')).rejects.toThrow(/Access is denied/);
    });

    it('restart and stop fail loudly until v0.1.8 wires them through elevation', async () => {
        const client = new ServyClient('servy.exe');
        await expect(client.restart('X')).rejects.toThrow(/not yet wired/);
        await expect(client.stop('X')).rejects.toThrow(/not yet wired/);
    });
});

describe('parseScQueryStatus', () => {
    it('parses RUNNING (state code 4)', () => {
        expect(
            parseScQueryStatus(
                'SERVICE_NAME: X\n  STATE              : 4  RUNNING\n  TYPE  : 10',
            ),
        ).toBe('running');
    });

    it('parses STOPPED (state code 1)', () => {
        expect(parseScQueryStatus('STATE              : 1  STOPPED')).toBe('stopped');
    });

    it('parses START_PENDING as stopped (transient state collapsed for our 3-state UI)', () => {
        expect(parseScQueryStatus('STATE              : 2  START_PENDING')).toBe('stopped');
    });

    it('parses STOP_PENDING as stopped', () => {
        expect(parseScQueryStatus('STATE              : 3  STOP_PENDING')).toBe('stopped');
    });

    it('parses PAUSED as stopped', () => {
        expect(parseScQueryStatus('STATE              : 7  PAUSED')).toBe('stopped');
    });

    it('returns stopped when STATE line is missing entirely', () => {
        expect(parseScQueryStatus('something completely different')).toBe('stopped');
    });

    it('handles tabs and mixed whitespace around STATE', () => {
        expect(parseScQueryStatus('\t\tSTATE\t\t:  4  RUNNING')).toBe('running');
    });
});

describe('ServiceInstallError', () => {
    it('isUacDeclined detects the UAC-decline error message', () => {
        const err = new ServiceInstallError('user declined elevation', {
            ok: false,
            exitCode: -1,
            stdout: '',
            stderr: '',
            errorMessage: 'user declined elevation. Service install requires Administrator',
        });
        expect(err.isUacDeclined()).toBe(true);
    });

    it('isUacDeclined returns false for other failure modes', () => {
        const err = new ServiceInstallError('install failed', {
            ok: false,
            exitCode: 4,
            stdout: '',
            stderr: 'Service already exists',
            errorMessage: 'servy-cli install exited with code 1',
        });
        expect(err.isUacDeclined()).toBe(false);
    });
});
