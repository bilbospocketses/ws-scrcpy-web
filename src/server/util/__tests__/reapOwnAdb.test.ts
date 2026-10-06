import * as child_process from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    defaultKillTree,
    defaultListAdbProcesses,
    LIST_ADB_PROCESSES_SCRIPT,
    POWERSHELL_EXE,
    parseAdbProcessList,
    TASKKILL_EXE,
} from '../reapOwnAdb';

// No real process is ever started by this suite: the defaults' execFile is
// replaced, and each test scripts what "powershell.exe" printed.
vi.mock('child_process', async (importOriginal) => {
    const real = await importOriginal<typeof child_process>();
    return {
        ...real,
        execFile: vi.fn((...args: unknown[]) => {
            const cb = args.find((a) => typeof a === 'function') as
                | ((err: Error | null, stdout: string, stderr: string) => void)
                | undefined;
            queueMicrotask(() => cb?.(null, '', ''));
            return { pid: 0 };
        }),
    };
});

type ExecCb = (err: Error | null, stdout: string, stderr: string) => void;

function stubExecFile(stdout: string, err: Error | null = null): void {
    vi.mocked(child_process.execFile).mockImplementation(((...args: unknown[]) => {
        const cb = args.find((a) => typeof a === 'function') as ExecCb | undefined;
        queueMicrotask(() => cb?.(err, stdout, ''));
        return { pid: 0 };
    }) as unknown as typeof child_process.execFile);
}

describe('parseAdbProcessList', () => {
    it('reads one <pid>TAB<path> pair per line', () => {
        const out = '101\tC:\\deps\\adb\\adb.exe\r\n202\tC:\\Android\\platform-tools\\adb.exe\r\n';
        expect(parseAdbProcessList(out)).toEqual([
            { pid: 101, path: 'C:\\deps\\adb\\adb.exe' },
            { pid: 202, path: 'C:\\Android\\platform-tools\\adb.exe' },
        ]);
    });

    it('keeps a process whose path could not be read, with an empty path', () => {
        // Get-Process cannot read .Path for another user's process without
        // elevation; the script prints the pid and an empty column.
        expect(parseAdbProcessList('303\t\r\n')).toEqual([{ pid: 303, path: '' }]);
    });

    it('drops garbage, blank lines and a leading BOM', () => {
        const out = [
            '\uFEFF404\tC:\\deps\\adb\\adb.exe',
            '',
            'WARNING: something PowerShell said',
            'abc\tC:\\x\\adb.exe',
            '0\tC:\\zero\\adb.exe',
            '-5\tC:\\neg\\adb.exe',
            '12.5\tC:\\frac\\adb.exe',
            '505 C:\\no-tab\\adb.exe',
        ].join('\n');
        expect(parseAdbProcessList(out)).toEqual([{ pid: 404, path: 'C:\\deps\\adb\\adb.exe' }]);
    });

    it('trims whitespace around the path but keeps spaces inside it', () => {
        expect(parseAdbProcessList('7\t  C:\\Program Files\\Ws\\adb.exe  \n')).toEqual([
            { pid: 7, path: 'C:\\Program Files\\Ws\\adb.exe' },
        ]);
    });
});

describe('defaultListAdbProcesses', () => {
    beforeEach(() => {
        vi.mocked(child_process.execFile).mockClear();
    });

    it('runs Windows PowerShell by its literal System32 path with an encoded, input-free script', async () => {
        stubExecFile('9\tC:\\deps\\adb\\adb.exe\r\n');
        const list = await defaultListAdbProcesses();

        expect(list).toEqual([{ pid: 9, path: 'C:\\deps\\adb\\adb.exe' }]);
        const call = vi.mocked(child_process.execFile).mock.calls[0]!;
        expect(call[0]).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        expect(call[0]).toBe(POWERSHELL_EXE);
        const args = call[1] as string[];
        expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
        expect(Buffer.from(args[3]!, 'base64').toString('utf16le')).toBe(LIST_ADB_PROCESSES_SCRIPT);
        const opts = call[2] as child_process.ExecFileOptions;
        expect(opts.windowsHide).toBe(true);
        expect(opts.timeout).toBeGreaterThan(0);
    });

    it('strips PSModulePath from the child environment, whatever its casing', async () => {
        const saved = process.env['PSModulePath'];
        process.env['PSModulePath'] = 'C:\\pwsh7\\Modules';
        try {
            stubExecFile('');
            await defaultListAdbProcesses();
            const opts = vi.mocked(child_process.execFile).mock.calls[0]![2] as child_process.ExecFileOptions;
            const keys = Object.keys(opts.env ?? {}).map((k) => k.toLowerCase());
            expect(keys).not.toContain('psmodulepath');
            expect(keys.length).toBeGreaterThan(0);
        } finally {
            if (saved === undefined) delete process.env['PSModulePath'];
            else process.env['PSModulePath'] = saved;
        }
    });

    it('rejects when powershell.exe fails, so the reaper can log it', async () => {
        stubExecFile('', new Error('spawn ENOENT'));
        await expect(defaultListAdbProcesses()).rejects.toThrow(/ENOENT/);
    });

    it('the script splices in nothing and asks only for adb', () => {
        expect(LIST_ADB_PROCESSES_SCRIPT).toContain('Get-Process -Name adb');
        expect(LIST_ADB_PROCESSES_SCRIPT).not.toMatch(/\$env:|\$args/);
    });
});

describe('defaultKillTree', () => {
    beforeEach(() => {
        vi.mocked(child_process.execFile).mockClear();
    });

    it('kills exactly one pid and its tree via taskkill by literal path', async () => {
        stubExecFile('');
        await defaultKillTree(4242);

        const call = vi.mocked(child_process.execFile).mock.calls[0]!;
        expect(call[0]).toBe('C:\\Windows\\System32\\taskkill.exe');
        expect(call[0]).toBe(TASKKILL_EXE);
        expect(call[1]).toEqual(['/F', '/PID', '4242', '/T']);
    });

    it('rejects when taskkill fails', async () => {
        stubExecFile('', new Error('exit 128'));
        await expect(defaultKillTree(4242)).rejects.toThrow(/128/);
    });
});
