import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist-safe mocks so each test can read/reset the captured calls.
const execFileSyncMock = vi.fn();
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
    spawn: (...args: unknown[]) => spawnMock(...args),
}));

const existsSyncMock = vi.fn();
vi.mock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
    return {
        ...actual,
        existsSync: (...args: unknown[]) => existsSyncMock(...args),
        default: {
            ...actual,
            existsSync: (...args: unknown[]) => existsSyncMock(...args),
        },
    };
});

import { parseServyListStatus, ServyClient } from '../service/ServyClient';

/** Build a minimal stand-in for the `ChildProcess` returned by `spawn`. */
function fakeChildProcess() {
    return { unref: vi.fn() };
}

describe('ServyClient', () => {
    beforeEach(() => {
        execFileSyncMock.mockReset();
        execFileSyncMock.mockReturnValue('');
        spawnMock.mockReset();
        spawnMock.mockReturnValue(fakeChildProcess());
        existsSyncMock.mockReset();
        // Default: tray helper not present anywhere — keeps existing tests
        // (which don't care about tray) from accidentally triggering reg.exe.
        existsSyncMock.mockReturnValue(false);
    });

    it('install passes the full Servy CLI argument shape', async () => {
        const client = new ServyClient('C:\\fake\\servy-cli.exe');
        await client.install({
            name: 'WsScrcpyWeb',
            displayName: 'ws-scrcpy-web',
            description: 'desc',
            binPath: 'C:\\app\\node.exe',
            account: 'currentUser',
            startType: 'Automatic',
            maxRestartAttempts: 3,
            envVars: { DEPS_PATH: 'C:\\deps', FOO: 'bar' },
            logPath: 'C:\\app\\service.log',
        });
        expect(execFileSyncMock).toHaveBeenCalledTimes(1);
        const [cmd, args] = execFileSyncMock.mock.calls[0];
        expect(cmd).toBe('C:\\fake\\servy-cli.exe');
        expect(args).toEqual([
            'install',
            '--name', 'WsScrcpyWeb',
            '--displayName', 'ws-scrcpy-web',
            '--description', 'desc',
            '--binPath', 'C:\\app\\node.exe',
            '--account', 'currentUser',
            '--startType', 'Automatic',
            '--maxRestartAttempts', '3',
            '--envVars', 'DEPS_PATH=C:\\deps;FOO=bar',
            '--logPath', 'C:\\app\\service.log',
        ]);
    });

    it('uninstall calls servy-cli uninstall --name', async () => {
        const client = new ServyClient('servy.exe');
        await client.uninstall('WsScrcpyWeb');
        const [, args] = execFileSyncMock.mock.calls[0];
        expect(args).toEqual(['uninstall', '--name', 'WsScrcpyWeb']);
    });

    it('stop calls servy-cli stop --name', async () => {
        const client = new ServyClient('servy.exe');
        await client.stop('WsScrcpyWeb');
        const [, args] = execFileSyncMock.mock.calls[0];
        expect(args).toEqual(['stop', '--name', 'WsScrcpyWeb']);
    });

    it('restart calls servy-cli restart --name', async () => {
        const client = new ServyClient('servy.exe');
        await client.restart('WsScrcpyWeb');
        const [, args] = execFileSyncMock.mock.calls[0];
        expect(args).toEqual(['restart', '--name', 'WsScrcpyWeb']);
    });

    it('status uses servy-cli list and parses Running rows', async () => {
        execFileSyncMock.mockReturnValue(
            [
                'Name           DisplayName     Status     StartType    Account',
                'WsScrcpyWeb    ws-scrcpy-web   Running    Automatic    currentUser',
                'OtherSvc       Other           Stopped    Manual       LocalSystem',
            ].join('\n'),
        );
        const client = new ServyClient('servy.exe');
        const status = await client.status('WsScrcpyWeb');
        expect(status).toBe('running');
        const [, args] = execFileSyncMock.mock.calls[0];
        expect(args).toEqual(['list']);
    });

    it('status returns not-installed when service is absent from list output', async () => {
        execFileSyncMock.mockReturnValue('Name  DisplayName  Status\nOther  Other  Running\n');
        const client = new ServyClient('servy.exe');
        const status = await client.status('WsScrcpyWeb');
        expect(status).toBe('not-installed');
    });

    it('install also registers tray Run-key and spawns the helper when present', async () => {
        // First existsSync call resolves the installed-layout tray helper.
        existsSyncMock.mockReturnValueOnce(true);
        const client = new ServyClient('C:\\fake\\servy-cli.exe');
        await client.install({
            name: 'WsScrcpyWeb',
            displayName: 'ws-scrcpy-web',
            description: 'desc',
            binPath: 'C:\\app\\node.exe',
            account: 'currentUser',
            startType: 'Automatic',
            maxRestartAttempts: 3,
            envVars: {},
            logPath: 'C:\\app\\service.log',
        });

        // Two execFileSync calls: servy install + reg.exe add.
        expect(execFileSyncMock).toHaveBeenCalledTimes(2);
        const [servyCall, regCall] = execFileSyncMock.mock.calls;
        expect(servyCall[0]).toBe('C:\\fake\\servy-cli.exe');
        expect(regCall[0]).toBe('reg.exe');
        const regArgs = regCall[1] as string[];
        expect(regArgs[0]).toBe('add');
        expect(regArgs[1]).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run');
        expect(regArgs).toContain('/v');
        expect(regArgs[regArgs.indexOf('/v') + 1]).toBe('WsScrcpyWebTray');
        expect(regArgs).toContain('/t');
        expect(regArgs[regArgs.indexOf('/t') + 1]).toBe('REG_SZ');
        expect(regArgs).toContain('/d');
        // The /d value should be the path that existsSync reported true for —
        // i.e. the installed-layout candidate (cwd/ws-scrcpy-web-tray.exe).
        expect(regArgs[regArgs.indexOf('/d') + 1]).toMatch(/ws-scrcpy-web-tray\.exe$/);
        expect(regArgs).toContain('/f');

        // spawn should fire once with detached + ignore stdio + .unref() called.
        expect(spawnMock).toHaveBeenCalledTimes(1);
        const [spawnCmd, spawnArgs, spawnOpts] = spawnMock.mock.calls[0];
        expect(spawnCmd).toMatch(/ws-scrcpy-web-tray\.exe$/);
        expect(spawnArgs).toEqual([]);
        expect(spawnOpts).toEqual({ detached: true, stdio: 'ignore' });
        const child = spawnMock.mock.results[0].value as { unref: ReturnType<typeof vi.fn> };
        expect(child.unref).toHaveBeenCalledTimes(1);
    });

    it('install logs warning but succeeds when tray helper is absent', async () => {
        // existsSync returns false for both candidate paths -> resolveTrayHelperPath throws.
        existsSyncMock.mockReturnValue(false);
        const client = new ServyClient('C:\\fake\\servy-cli.exe');
        await expect(
            client.install({
                name: 'WsScrcpyWeb',
                displayName: 'ws-scrcpy-web',
                description: 'desc',
                binPath: 'C:\\app\\node.exe',
                account: 'currentUser',
                startType: 'Automatic',
                maxRestartAttempts: 3,
                envVars: {},
                logPath: 'C:\\app\\service.log',
            }),
        ).resolves.toBeUndefined();

        // Servy install ran; reg.exe and spawn did NOT.
        expect(execFileSyncMock).toHaveBeenCalledTimes(1);
        expect(execFileSyncMock.mock.calls[0][0]).toBe('C:\\fake\\servy-cli.exe');
        expect(spawnMock).not.toHaveBeenCalled();
    });

    it('uninstall calls reg.exe delete with correct argv', async () => {
        const client = new ServyClient('servy.exe');
        await client.uninstall('WsScrcpyWeb');

        // Two execFileSync calls: servy uninstall + reg.exe delete.
        expect(execFileSyncMock).toHaveBeenCalledTimes(2);
        const [, regCall] = execFileSyncMock.mock.calls;
        expect(regCall[0]).toBe('reg.exe');
        expect(regCall[1]).toEqual([
            'delete',
            'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
            '/v', 'WsScrcpyWebTray',
            '/f',
        ]);
    });

    it('uninstall tolerates "cannot find" error from reg.exe delete', async () => {
        // First call (servy uninstall) succeeds; second call (reg delete) throws "cannot find".
        execFileSyncMock
            .mockImplementationOnce(() => '')
            .mockImplementationOnce(() => {
                const err = new Error('reg.exe failed') as NodeJS.ErrnoException & {
                    stderr: string;
                };
                err.stderr = 'ERROR: The system was unable to find the specified registry key or value.';
                throw err;
            });
        const client = new ServyClient('servy.exe');
        await expect(client.uninstall('WsScrcpyWeb')).resolves.toBeUndefined();
        expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    });

    it('uninstall logs warning but succeeds when reg.exe delete throws a non-tolerable error', async () => {
        execFileSyncMock
            .mockImplementationOnce(() => '')
            .mockImplementationOnce(() => {
                const err = new Error('reg.exe failed') as NodeJS.ErrnoException & {
                    stderr: string;
                };
                err.stderr = 'ERROR: Access is denied.';
                throw err;
            });
        const client = new ServyClient('servy.exe');
        // Should NOT reject — uninstall swallows non-tolerable Run-key errors and logs.
        await expect(client.uninstall('WsScrcpyWeb')).resolves.toBeUndefined();
        expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    });

    it('install surfaces stderr when execFileSync throws', async () => {
        execFileSyncMock.mockImplementation(() => {
            const err = new Error('non-zero exit') as NodeJS.ErrnoException & {
                stderr: string;
            };
            err.stderr = 'Service already exists';
            throw err;
        });
        const client = new ServyClient('servy.exe');
        await expect(
            client.install({
                name: 'X',
                displayName: 'X',
                description: 'd',
                binPath: 'b',
                account: 'currentUser',
                startType: 'Automatic',
                maxRestartAttempts: 1,
                envVars: {},
                logPath: 'l',
            }),
        ).rejects.toThrow(/Service already exists/);
    });
});

describe('parseServyListStatus', () => {
    it('parses Running case-insensitively', () => {
        expect(
            parseServyListStatus(
                'WsScrcpyWeb    ws-scrcpy-web   running    Automatic    currentUser',
                'WsScrcpyWeb',
            ),
        ).toBe('running');
    });

    it('parses Stopped', () => {
        expect(
            parseServyListStatus(
                'WsScrcpyWeb    ws-scrcpy-web   Stopped    Automatic    currentUser',
                'WsScrcpyWeb',
            ),
        ).toBe('stopped');
    });

    it('matches case-insensitive service names', () => {
        expect(
            parseServyListStatus(
                'wsscrcpyweb    ws-scrcpy-web   Running    Automatic    currentUser',
                'WsScrcpyWeb',
            ),
        ).toBe('running');
    });

    it('returns not-installed for missing rows', () => {
        expect(parseServyListStatus('SomethingElse  Other  Running', 'WsScrcpyWeb')).toBe(
            'not-installed',
        );
    });

    it('returns not-installed for empty output', () => {
        expect(parseServyListStatus('', 'WsScrcpyWeb')).toBe('not-installed');
    });
});
