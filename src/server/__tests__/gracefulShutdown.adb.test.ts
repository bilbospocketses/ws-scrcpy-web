import * as child_process from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reapStrayAdbOnWindows } from '../shutdownHelpers';

// Mock child_process so nothing in this suite can reach a real process: the
// reaper's defaults shell out to powershell.exe and taskkill.exe, and every
// test below injects its own process list and killer anyway. The mock exists
// so a regression back to a blanket `taskkill /IM adb.exe` is caught here
// rather than executed against the developer's machine.
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

const APP_ADB = 'C:\\Program Files\\WsScrcpyWeb\\dependencies\\adb\\adb.exe';
const OTHER_ADB = 'C:\\Other\\platform-tools\\adb.exe';

function blanketKillCalls(): unknown[][] {
    return vi.mocked(child_process.execFile).mock.calls.filter((call) => {
        const args = call[1];
        return Array.isArray(args) && args.some((a) => typeof a === 'string' && a.toUpperCase() === '/IM');
    });
}

describe('reapStrayAdbOnWindows', () => {
    beforeEach(() => {
        vi.mocked(child_process.execFile).mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("kills only the processes running the app's own adb binary, matched case-insensitively", async () => {
        const killed: number[] = [];
        const reaped = await reapStrayAdbOnWindows(APP_ADB, {
            platform: 'win32',
            listProcesses: async () => [
                { pid: 1, path: APP_ADB },
                { pid: 2, path: OTHER_ADB },
                { pid: 3, path: APP_ADB.toUpperCase() },
            ],
            killTree: async (pid) => {
                killed.push(pid);
            },
        });

        expect(killed).toEqual([1, 3]);
        expect(reaped).toBe(2);
        expect(blanketKillCalls()).toEqual([]);
    });

    it('kills nothing when no adb is running', async () => {
        const killTree = vi.fn(async () => undefined);
        const reaped = await reapStrayAdbOnWindows(APP_ADB, {
            platform: 'win32',
            listProcesses: async () => [],
            killTree,
        });

        expect(killTree).not.toHaveBeenCalled();
        expect(reaped).toBe(0);
        expect(blanketKillCalls()).toEqual([]);
    });

    it("kills nothing when the only adb running is another tool's", async () => {
        const killTree = vi.fn(async () => undefined);
        await reapStrayAdbOnWindows(APP_ADB, {
            platform: 'win32',
            listProcesses: async () => [{ pid: 2, path: OTHER_ADB }],
            killTree,
        });

        expect(killTree).not.toHaveBeenCalled();
    });

    it('swallows a process-listing failure without throwing or killing anything', async () => {
        const killTree = vi.fn(async () => undefined);
        await expect(
            reapStrayAdbOnWindows(APP_ADB, {
                platform: 'win32',
                listProcesses: async () => {
                    throw new Error('powershell.exe timed out');
                },
                killTree,
            }),
        ).resolves.toBe(0);

        expect(killTree).not.toHaveBeenCalled();
        expect(blanketKillCalls()).toEqual([]);
    });

    it('a failed kill does not stop the next match from being killed, and never throws', async () => {
        const attempted: number[] = [];
        const reaped = await reapStrayAdbOnWindows(APP_ADB, {
            platform: 'win32',
            listProcesses: async () => [
                { pid: 1, path: APP_ADB },
                { pid: 3, path: APP_ADB },
            ],
            killTree: async (pid) => {
                attempted.push(pid);
                if (pid === 1) throw new Error('access denied');
            },
        });

        expect(attempted).toEqual([1, 3]);
        expect(reaped).toBe(1);
    });

    it('is a no-op on non-win32 platforms', async () => {
        const listProcesses = vi.fn(async () => [{ pid: 1, path: APP_ADB }]);
        const killTree = vi.fn(async () => undefined);
        await reapStrayAdbOnWindows(APP_ADB, { platform: 'linux', listProcesses, killTree });

        expect(listProcesses).not.toHaveBeenCalled();
        expect(killTree).not.toHaveBeenCalled();
        expect(child_process.execFile).not.toHaveBeenCalled();
    });

    it('with the default dependencies, never issues taskkill /IM adb.exe', async () => {
        await reapStrayAdbOnWindows(APP_ADB, { platform: 'win32' });

        expect(blanketKillCalls()).toEqual([]);
    });
});
