import { describe, expect, it } from 'vitest';
import { createSignalExitHandler, REPEAT_SIGNAL_GRACE_MS } from '../signalExit';

// Smoke row 12.10 (qa-harness, 2026-10-06): one Ctrl+C on Linux reaches the
// server twice, as the terminal's SIGINT and the launcher's forwarded SIGTERM.
// The old handler force-exited on any second signal, which could cut the
// graceful stop short before its SQLite backup.

function harness(graceMs?: number) {
    let clock = 0;
    const logs: string[] = [];
    const started: string[] = [];
    let forced = 0;
    const onSignal = createSignalExitHandler({
        log: (message) => logs.push(message),
        startShutdown: (signal) => started.push(signal),
        forceExit: () => {
            forced += 1;
        },
        now: () => clock,
        ...(graceMs === undefined ? {} : { graceMs }),
    });
    return {
        logs,
        started,
        forced: () => forced,
        signal(name: string, atMs: number) {
            clock = atMs;
            onSignal(name);
        },
    };
}

describe('createSignalExitHandler (smoke row 12.10)', () => {
    it('starts the graceful stop on the first signal and does not force an exit', () => {
        const h = harness();
        h.signal('SIGTERM', 1000);

        expect(h.started).toEqual(['SIGTERM']);
        expect(h.forced()).toBe(0);
        expect(h.logs).toEqual(['Received signal SIGTERM']);
    });

    it('ignores the second signal of one Ctrl+C (SIGINT, then the launcher SIGTERM)', () => {
        const h = harness();
        h.signal('SIGINT', 1000);
        h.signal('SIGTERM', 1040);

        expect(h.started, 'the graceful stop starts once').toEqual(['SIGINT']);
        expect(h.forced(), 'the repeat does not force an exit').toBe(0);
        expect(h.logs).toEqual([
            'Received signal SIGINT',
            'Received signal SIGTERM',
            'Ignoring SIGTERM 40ms after the first signal: graceful shutdown is already running',
        ]);
    });

    it('still forces an exit on a deliberate signal after the grace window', () => {
        const h = harness();
        h.signal('SIGINT', 1000);
        h.signal('SIGINT', 1000 + REPEAT_SIGNAL_GRACE_MS);

        expect(h.started).toEqual(['SIGINT']);
        expect(h.forced()).toBe(1);
        expect(h.logs).toEqual(['Received signal SIGINT', 'Received signal SIGINT', 'Force exit']);
    });

    it('measures the window from the first signal, so repeats do not extend it', () => {
        const h = harness();
        h.signal('SIGINT', 0);
        h.signal('SIGTERM', 1500);
        expect(h.forced(), 'inside the window').toBe(0);

        h.signal('SIGINT', 2100);
        expect(h.forced(), '2.1 s after the FIRST signal, though 0.6 s after the last').toBe(1);
    });

    it('takes a custom window', () => {
        const h = harness(500);
        h.signal('SIGTERM', 0);
        h.signal('SIGTERM', 499);
        expect(h.forced()).toBe(0);
        h.signal('SIGTERM', 500);
        expect(h.forced()).toBe(1);
    });

    it('defaults to a 2 s window', () => {
        expect(REPEAT_SIGNAL_GRACE_MS).toBe(2000);
    });
});
