/**
 * The e2e suite's hang guards.
 *
 * Every bound in the suite exists only to end a genuine hang. Correct code that
 * runs slower on a loaded box must never fail a spec, so no wait here is a
 * speed check: each sits far past the healthy time of what it waits for (a
 * second or two at most for the waits, under a minute for a whole test).
 *
 * Timing that IS the behavior under test -- how fast the UI responds -- is not
 * bounded with these. Those few rows say so where they stand, and only mean
 * anything on a quiet box.
 */

/**
 * One wait: an `expect`, an `expect.poll`, a navigation or `load` event, one
 * probe attempt inside a retry loop. Playwright's `expect.timeout` is this, so
 * an `expect` sets no timeout of its own unless it needs MORE than this.
 */
export const WAIT_MS = 120_000;

/** A whole test that sets no budget of its own (`test.setTimeout` raises it where a test needs more). */
export const TEST_MS = 300_000;
