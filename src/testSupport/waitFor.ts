import { vi } from 'vitest';

/**
 * How long a unit test's `waitFor` keeps polling before it gives up.
 *
 * `vi.waitFor` on its own gives up after 1 s, and `vitest.config.ts`'s
 * testTimeout does not extend it, so on a loaded box a correct test went red
 * only because what it waited for arrived late. A slow box must make a test
 * slower, never red: this bound exists only to end a genuine hang. A healthy
 * wait here takes milliseconds, so it sits far past that, and below the
 * per-test timeout, so a hang is reported by `waitFor` itself, as HUNG with
 * the condition that never held, rather than as a bare test timeout.
 */
export const WAIT_FOR_TIMEOUT_MS = 120_000;

/**
 * `vi.waitFor` with the generous bound above. Use it for every wait in a unit
 * test; pass `interval` only where the polling rate matters.
 */
export function waitFor<T>(callback: () => T | Promise<T>, options: { interval?: number } = {}): Promise<T> {
    return vi.waitFor(callback, { timeout: WAIT_FOR_TIMEOUT_MS, ...options }).catch((err: unknown) => {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`HUNG: waited ${WAIT_FOR_TIMEOUT_MS / 1000} s and the condition never held: ${detail}`, {
            cause: err,
        });
    });
}
