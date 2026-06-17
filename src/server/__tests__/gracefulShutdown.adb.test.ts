// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as child_process from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reapStrayAdbOnWindows } from '../shutdownHelpers';

// Mock child_process so execFileAsync (promisify(execFile)) never touches the
// real system; we only care which arguments were passed.
vi.mock('child_process', async (importOriginal) => {
    const real = await importOriginal<typeof child_process>();
    return {
        ...real,
        execFile: vi.fn((_file: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
            cb(null);
        }),
    };
});

describe('reapStrayAdbOnWindows', () => {
    let execFileMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        execFileMock = vi.mocked(child_process.execFile);
        execFileMock.mockClear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('issues taskkill /F /IM adb.exe /T on win32', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        await reapStrayAdbOnWindows();

        expect(execFileMock).toHaveBeenCalledTimes(1);
        const [file, args] = execFileMock.mock.calls[0]!;
        expect(file).toBe('C:\\Windows\\System32\\taskkill.exe');
        expect(args).toEqual(['/F', '/IM', 'adb.exe', '/T']);
    });

    it('does NOT call taskkill on non-win32 platforms', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
        await reapStrayAdbOnWindows();

        expect(execFileMock).not.toHaveBeenCalled();
    });

    it('swallows a non-zero exit (no-match) without throwing', async () => {
        vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
        execFileMock.mockImplementation(
            (_file: string, _args: string[], _opts: unknown, cb: (err: Error | null) => void) => {
                const err = Object.assign(new Error('no matching process'), { code: 1 });
                cb(err);
            },
        );

        // Must not throw.
        await expect(reapStrayAdbOnWindows()).resolves.toBeUndefined();
    });
});
