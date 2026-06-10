import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger, shouldLogToConsole } from '../Logger';

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
