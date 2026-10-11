import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scheduleRestart, scheduleRestartForPortChange } from '../api/restartRequest';
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

describe('scheduleRestart', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-restart-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes the marker at once, then names its reason in the log as it exits with 75', () => {
        const marker = path.join(tmpDir, '.restart');
        const info: string[] = [];
        const exits: number[] = [];
        let scheduled: (() => void) | undefined;

        scheduleRestart(marker, { info: (m) => info.push(m), warn() {} }, 'restart requested', {
            schedule: (cb) => {
                scheduled = cb;
            },
            exit: (code) => exits.push(code),
        });
        expect(fs.existsSync(marker)).toBe(true);
        expect(exits).toEqual([]);

        scheduled?.();

        expect(info).toEqual(['restart requested committed; exiting with 75 to trigger restart']);
        expect(exits).toEqual([75]);
    });
});
