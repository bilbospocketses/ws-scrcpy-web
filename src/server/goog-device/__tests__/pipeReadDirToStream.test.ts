import { describe, expect, it, vi } from 'vitest';

/**
 * A directory listing ends when the server closes its channel (there is no DONE
 * frame). That close must carry the normal code 1000: code 0 is not a valid close
 * code, so the client saw `wasClean: false, code: 0` for every successful listing.
 */

const { shell } = vi.hoisted(() => ({ shell: vi.fn() }));

vi.mock('../../AdbClient', () => ({
    AdbClient: class {
        shell = shell;
    },
}));

vi.mock('../../Config', () => ({
    Config: { getInstance: () => ({ adbPath: 'adb' }) },
}));

import { AdbUtils } from '../AdbUtils';

describe('AdbUtils.pipeReadDirToStream', () => {
    it('closes the channel with the normal code 1000 once every entry is sent', async () => {
        shell.mockImplementation(async (_serial: string, command: string) =>
            command.startsWith('ls -1a') ? 'a.txt\nb.txt\n' : '81a4 10 1700000000',
        );
        const stream = { send: vi.fn(), close: vi.fn() };

        await AdbUtils.pipeReadDirToStream('device-1', '/sdcard', stream as never);

        expect(stream.send).toHaveBeenCalledTimes(2);
        expect(stream.close).toHaveBeenCalledTimes(1);
        expect(stream.close).toHaveBeenCalledWith(1000);
    });
});
