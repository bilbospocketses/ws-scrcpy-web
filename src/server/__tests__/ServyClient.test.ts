import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoist-safe mock so each test can read/reset the captured calls.
const execFileSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
}));

import { parseServyListStatus, ServyClient } from '../service/ServyClient';

describe('ServyClient', () => {
    beforeEach(() => {
        execFileSyncMock.mockReset();
        execFileSyncMock.mockReturnValue('');
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
