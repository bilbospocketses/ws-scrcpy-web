import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEVICE_SERVER_PATH } from '../../common/Constants';
import type { AdbClient } from '../AdbClient';
import { ensureScrcpyServerPushed, remoteJarCheckCommand } from '../ensureScrcpyServerPushed';
import { sha256FileSync } from '../verifySha256';

vi.mock('../verifySha256', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../verifySha256')>();
    return { ...actual, sha256FileSync: vi.fn(actual.sha256FileSync) };
});

const sha256 = (data: string) => createHash('sha256').update(data).digest('hex');

/**
 * M6 (2026-10-08): the push used to be skipped whenever the jar on the device
 * had the same byte size as the local one, so a new server that happened to be
 * the same size as the old would never reach the device, and the old one would
 * run under the new version string.
 */
describe('ensureScrcpyServerPushed', () => {
    let dir: string;
    let local: string;
    const LOCAL_BYTES = 'the new scrcpy-server jar';
    // Same length, different bytes: what the size check could not tell apart.
    const OTHER_SAME_SIZE = 'the old scrcpy-server jar';

    function client(shell: () => Promise<string>): {
        adb: AdbClient;
        shell: ReturnType<typeof vi.fn>;
        push: ReturnType<typeof vi.fn>;
    } {
        const shellFn = vi.fn(shell);
        const push = vi.fn(async () => undefined);
        return { adb: { shell: shellFn, push } as unknown as AdbClient, shell: shellFn, push };
    }

    /** What `remoteJarCheckCommand` prints on a device with `sha256sum`. */
    const deviceOut = (bytes: string) => `${sha256(bytes)}  ${DEVICE_SERVER_PATH}\n${bytes.length}`;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wssw-push-'));
        local = path.join(dir, 'scrcpy-server');
        fs.writeFileSync(local, LOCAL_BYTES);
        vi.mocked(sha256FileSync).mockClear();
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('pushes when the device jar is the same size but a different hash', async () => {
        expect(OTHER_SAME_SIZE.length).toBe(LOCAL_BYTES.length);
        const { adb, push } = client(async () => deviceOut(OTHER_SAME_SIZE));

        await ensureScrcpyServerPushed(adb, 'SER', local);

        expect(push).toHaveBeenCalledWith('SER', local, DEVICE_SERVER_PATH);
    });

    it('does not push when the device jar has the same hash, in one shell call', async () => {
        const { adb, shell, push } = client(async () => deviceOut(LOCAL_BYTES).toUpperCase());

        await ensureScrcpyServerPushed(adb, 'SER', local);

        expect(push).not.toHaveBeenCalled();
        expect(shell).toHaveBeenCalledTimes(1);
        expect(shell).toHaveBeenCalledWith('SER', remoteJarCheckCommand());
    });

    it('without sha256sum on the device, falls back to the size: same size, no push', async () => {
        const { adb, push } = client(async () => String(LOCAL_BYTES.length));

        await ensureScrcpyServerPushed(adb, 'SER', local);

        expect(push).not.toHaveBeenCalled();
    });

    it('without sha256sum on the device, falls back to the size: different size, push', async () => {
        const { adb, push } = client(async () => String(LOCAL_BYTES.length + 1));

        await ensureScrcpyServerPushed(adb, 'SER', local);

        expect(push).toHaveBeenCalledTimes(1);
    });

    it('pushes when the jar is absent from the device (no output) or the shell fails', async () => {
        const empty = client(async () => '');
        await ensureScrcpyServerPushed(empty.adb, 'SER', local);
        expect(empty.push).toHaveBeenCalledTimes(1);

        const failing = client(async () => {
            throw new Error('adb: device offline');
        });
        await ensureScrcpyServerPushed(failing.adb, 'SER', local);
        expect(failing.push).toHaveBeenCalledTimes(1);
    });

    it('hashes the local jar once per change to it, not once per push check', async () => {
        const { adb } = client(async () => deviceOut(LOCAL_BYTES));

        await ensureScrcpyServerPushed(adb, 'SER', local);
        await ensureScrcpyServerPushed(adb, 'SER', local);
        expect(vi.mocked(sha256FileSync).mock.calls.filter(([p]) => p === local)).toHaveLength(1);

        fs.writeFileSync(local, `${LOCAL_BYTES} v2`);
        const { adb: adb2, push } = client(async () => deviceOut(LOCAL_BYTES));
        await ensureScrcpyServerPushed(adb2, 'SER', local);
        expect(vi.mocked(sha256FileSync).mock.calls.filter(([p]) => p === local)).toHaveLength(2);
        expect(push).toHaveBeenCalledTimes(1);
    });

    it('quotes the remote path as one shell word', () => {
        expect(remoteJarCheckCommand()).toBe(
            `{ sha256sum '${DEVICE_SERVER_PATH}'; wc -c < '${DEVICE_SERVER_PATH}'; } 2>/dev/null`,
        );
        expect(remoteJarCheckCommand("/data/local/tmp/it's here.jar")).toBe(
            `{ sha256sum '/data/local/tmp/it'\\''s here.jar'; wc -c < '/data/local/tmp/it'\\''s here.jar'; } 2>/dev/null`,
        );
    });
});
