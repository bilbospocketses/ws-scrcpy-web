import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger, shouldLogToConsole, rotateIfNeeded } from '../Logger';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('shouldLogToConsole', () => {
    it('returns true for a TTY, false otherwise', () => {
        expect(shouldLogToConsole(true)).toBe(true);
        expect(shouldLogToConsole(false)).toBe(false);
    });
});

describe('Logger console gating', () => {
    const origOut = process.stdout.isTTY;
    const origErr = process.stderr.isTTY;
    afterEach(() => {
        process.stdout.isTTY = origOut;
        process.stderr.isTTY = origErr;
        vi.restoreAllMocks();
    });

    it('suppresses console when stdout/stderr are not a TTY (captured to a file)', () => {
        process.stdout.isTTY = false;
        process.stderr.isTTY = false;
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        Logger.for('Test').info('hi');
        Logger.for('Test').error('boom');
        expect(log).not.toHaveBeenCalled();
        expect(err).not.toHaveBeenCalled();
    });

    it('writes console when stdout/stderr are a TTY (dev terminal)', () => {
        process.stdout.isTTY = true;
        process.stderr.isTTY = true;
        const log = vi.spyOn(console, 'log').mockImplementation(() => {});
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        Logger.for('Test').info('hi');
        Logger.for('Test').error('boom');
        expect(log).toHaveBeenCalledOnce();
        expect(err).toHaveBeenCalledOnce();
    });
});

describe('rotateIfNeeded', () => {
    it('renames the log to .1 when it is at/over the threshold, every call', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wssw-log-'));
        const file = path.join(dir, 'ws-scrcpy-web.log');
        fs.writeFileSync(file, Buffer.alloc(11));
        rotateIfNeeded(file, 10); // 10-byte threshold, file is 11 bytes
        expect(fs.existsSync(`${file}.1`)).toBe(true);
        expect(fs.existsSync(file)).toBe(false); // renamed away; next append recreates
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('does not rotate when under the threshold', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wssw-log-'));
        const file = path.join(dir, 'ws-scrcpy-web.log');
        fs.writeFileSync(file, Buffer.alloc(5));
        rotateIfNeeded(file, 10);
        expect(fs.existsSync(`${file}.1`)).toBe(false);
        expect(fs.existsSync(file)).toBe(true);
        fs.rmSync(dir, { recursive: true, force: true });
    });
});
