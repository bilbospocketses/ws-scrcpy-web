import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Call-through fs.promises spies so #31 can assert the atomic tmp→rename staging
// OS-independently (same pattern as resumeToken.test.ts). #32: staging is async,
// so the spies sit on fs.promises.copyFile/rename, not the sync variants.
const fsSpies = vi.hoisted(() => ({
    copyFile: vi.fn(),
    rename: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        promises: {
            ...actual.promises,
            copyFile: (...args: Parameters<typeof actual.promises.copyFile>) => {
                fsSpies.copyFile(...args);
                return actual.promises.copyFile(...args);
            },
            rename: (...args: Parameters<typeof actual.promises.rename>) => {
                fsSpies.rename(...args);
                return actual.promises.rename(...args);
            },
        },
    };
});

import { isSafeReusableBin, stageStableUserBin } from '../service/SystemdClient';

const fakeStat = (over: Partial<{ file: boolean; uid: number; mode: number }> = {}): fs.Stats =>
    ({
        isFile: () => over.file ?? true,
        uid: over.uid ?? 0,
        mode: over.mode ?? 0o755,
    }) as unknown as fs.Stats;

describe('isSafeReusableBin (#31)', () => {
    it('accepts a root-owned, non-symlink, non-world-writable regular file', () => {
        expect(isSafeReusableBin(fakeStat())).toBe(true);
    });
    it('rejects a symlink (lstat reports a non-regular file)', () => {
        expect(isSafeReusableBin(fakeStat({ file: false }))).toBe(false);
    });
    it('rejects a non-root-owned file', () => {
        expect(isSafeReusableBin(fakeStat({ uid: 1000 }))).toBe(false);
    });
    it('rejects a group/other-writable file', () => {
        expect(isSafeReusableBin(fakeStat({ mode: 0o757 }))).toBe(false);
    });
});

describe('stageStableUserBin (#31)', () => {
    let dataRoot: string;
    let source: string;

    beforeEach(() => {
        dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-stage-'));
        source = path.join(dataRoot, 'src.AppImage');
        fs.writeFileSync(source, 'BINARY-CONTENT');
    });
    afterEach(() => {
        try {
            fs.rmSync(dataRoot, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    });

    it('stages the binary via an atomic temp + rename, not a direct copy (#31)', async () => {
        // The /opt bin does not exist on the test host, so the staging path runs.
        fsSpies.copyFile.mockClear();
        fsSpies.rename.mockClear();
        const opts = {
            scope: 'user',
            name: 'WsScrcpyWeb',
            description: 'ws-scrcpy-web',
            binPath: source,
            startupDir: dataRoot,
            maxRestartAttempts: 10,
            dataRoot,
        } as unknown as Parameters<typeof stageStableUserBin>[0];

        const result = await stageStableUserBin(opts);

        // Atomic: copied to a temp path then renamed into the final ExecStart path.
        expect(fsSpies.rename).toHaveBeenCalledTimes(1);
        expect(fsSpies.copyFile).toHaveBeenCalledWith(source, expect.stringContaining('.tmp-'));
        // Final binary is the complete source content at the stable path.
        expect(result.binPath.startsWith(`${dataRoot}/bin/`)).toBe(true);
        expect(fs.readFileSync(result.binPath, 'utf8')).toBe('BINARY-CONTENT');
    });
});
