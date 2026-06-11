import { afterEach, describe, expect, it, vi } from 'vitest';
import { forceBlockingStdio } from '../forceBlockingStdio';

/**
 * forceBlockingStdio flips the (internal) stdout/stderr handles to blocking so
 * teardown log lines flush to the console before exit. We can't exercise the
 * real Windows-TTY async-drop here, but we can verify the helper (a) calls
 * setBlocking(true) on both streams when the handle exposes it, and (b) degrades
 * to a no-op (no throw) when the internal _handle is absent — the future-Node
 * safety net the try/catch exists for.
 */
describe('forceBlockingStdio', () => {
    const origOut = (process.stdout as unknown as { _handle?: unknown })._handle;
    const origErr = (process.stderr as unknown as { _handle?: unknown })._handle;

    afterEach(() => {
        (process.stdout as unknown as { _handle?: unknown })._handle = origOut;
        (process.stderr as unknown as { _handle?: unknown })._handle = origErr;
    });

    it('sets both streams blocking when the handle exposes setBlocking', () => {
        const outSet = vi.fn();
        const errSet = vi.fn();
        (process.stdout as unknown as { _handle?: unknown })._handle = { setBlocking: outSet };
        (process.stderr as unknown as { _handle?: unknown })._handle = { setBlocking: errSet };

        forceBlockingStdio();

        expect(outSet).toHaveBeenCalledWith(true);
        expect(errSet).toHaveBeenCalledWith(true);
    });

    it('no-ops without throwing when the internal _handle is absent', () => {
        (process.stdout as unknown as { _handle?: unknown })._handle = undefined;
        (process.stderr as unknown as { _handle?: unknown })._handle = undefined;

        expect(() => forceBlockingStdio()).not.toThrow();
    });
});
