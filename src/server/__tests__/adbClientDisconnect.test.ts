import { execFile } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdbClient, AdbExecError } from '../AdbClient';
import { AdbDaemonManager } from '../AdbDaemonManager';
import { classifyDisconnectResult } from '../api/DeviceDiscoveryApi';

// Finding 7.8, reopened by item 164's e2e row 7.9. adb 37.0.1 answers a
// disconnect of an address that was never connected with
// `error: no such device '<addr>'` AND exit code 1. `exec` turns any non-zero
// exit into AdbExecError('exit'), so `classifyDisconnectResult` — which already
// maps that text to 200 `not connected` — never saw it, and the route answered
// 500. Its own unit tests fed it text, which is why they stayed green.
//
// These mock execFile itself (not the private `exec`), so the real exit
// classification runs and the test sees what production sees.
vi.mock('child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('child_process')>();
    return { ...actual, execFile: vi.fn() };
});

const ADB = 'C:/fake/disconnect/adb.exe';
const ADDR = '1.2.3.4:5555';
const NO_SUCH_DEVICE = `error: no such device '${ADDR}'\n`;

type ExecFileCallback = (err: Error | null, out?: { stdout: string; stderr: string }) => void;

/** Make the next execFile call fail the way node's child_process does. */
function execFileFailsWith(fields: Record<string, unknown>): void {
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
        const cb = args[args.length - 1] as ExecFileCallback;
        cb(Object.assign(new Error(`Command failed: ${ADB} disconnect ${ADDR}`), fields));
    }) as unknown as typeof execFile);
}

beforeEach(() => {
    vi.spyOn(AdbDaemonManager.getInstance(ADB), 'ensureReady').mockResolvedValue();
});
afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(execFile).mockReset();
});

describe('AdbClient.disconnect', () => {
    it("returns adb's text when it exits 1 with `no such device`, so the route can answer 200 not connected", async () => {
        execFileFailsWith({ code: 1, killed: false, signal: null, stdout: '', stderr: NO_SUCH_DEVICE });

        const out = await new AdbClient(ADB).disconnect(ADDR);

        expect(out).toBe(NO_SUCH_DEVICE);
        expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(execFile).mock.calls[0]![1]).toEqual(['disconnect', ADDR]);
        // The whole chain the route runs.
        expect(classifyDisconnectResult(out)).toEqual({ status: 200, success: true, message: 'not connected' });
    });

    it('still returns stdout on a clean exit', async () => {
        vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
            const cb = args[args.length - 1] as ExecFileCallback;
            cb(null, { stdout: `disconnected ${ADDR}\n`, stderr: '' });
        }) as unknown as typeof execFile);

        await expect(new AdbClient(ADB).disconnect(ADDR)).resolves.toBe(`disconnected ${ADDR}\n`);
    });

    it('rethrows a non-exit failure (timeout) unchanged', async () => {
        execFileFailsWith({ killed: true, signal: 'SIGKILL', code: null, stdout: '', stderr: '' });

        const err = await new AdbClient(ADB).disconnect(ADDR).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AdbExecError);
        expect((err as AdbExecError).kind).toBe('timeout');
    });

    it('rethrows an exit that printed nothing, since there is no text to classify', async () => {
        execFileFailsWith({ code: 1, killed: false, signal: null, stdout: '', stderr: '' });

        const err = await new AdbClient(ADB).disconnect(ADDR).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(AdbExecError);
        expect((err as AdbExecError).kind).toBe('exit');
    });
});
