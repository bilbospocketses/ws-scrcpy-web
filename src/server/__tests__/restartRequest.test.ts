import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scheduleRestartForPortChange } from '../api/restartRequest';
import { liveStreams } from '../liveStreams';

describe('scheduleRestartForPortChange', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-restart-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('closes the open streams as a deliberate stop, then exits with 75', () => {
        // The exit ends every stream; without this a viewer saw "stream failed".
        const order: string[] = [];
        const stream = {
            closeForShutdown: () => {
                order.push('close stream');
                liveStreams.remove(stream);
            },
        };
        liveStreams.add(stream);
        let scheduled: (() => void) | undefined;

        scheduleRestartForPortChange(
            path.join(tmpDir, '.restart'),
            { info() {}, warn() {} },
            {
                schedule: (cb) => {
                    scheduled = cb;
                },
                exit: (code) => order.push(`exit ${code}`),
            },
        );
        // Nothing closes before the response has had its beat to flush.
        expect(order).toEqual([]);

        scheduled?.();

        expect(order).toEqual(['close stream', 'exit 75']);
        expect(liveStreams.size()).toBe(0);
    });
});
