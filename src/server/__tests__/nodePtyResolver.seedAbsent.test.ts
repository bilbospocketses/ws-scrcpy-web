import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs');
vi.mock('child_process');

const logged = vi.hoisted(() => ({ info: [] as string[], warn: [] as string[], error: [] as string[] }));

vi.mock('../Logger', () => ({
    Logger: {
        for: () => ({
            info: (...args: unknown[]) => logged.info.push(args.map(String).join(' ')),
            warn: (...args: unknown[]) => logged.warn.push(args.map(String).join(' ')),
            error: (...args: unknown[]) => logged.error.push(args.map(String).join(' ')),
        }),
    },
}));

import { _resetForTest, resolveNodePty } from '../NodePtyResolver';

// A checkout that has not run `npm run stage-seed` has no seed package. The app
// treats that as a capability, not a fault — /api/capabilities answers
// `shellReason: 'no-seed-package'` — so the log line must not be an ERROR.
// Smoke row 10.3 asserts zero ERROR lines in the log and carried a permanent
// allow-list exception for exactly this line.
describe('resolveNodePty — no seed package', () => {
    beforeEach(() => {
        _resetForTest();
        logged.info.length = 0;
        logged.warn.length = 0;
        logged.error.length = 0;
    });

    afterEach(() => {
        _resetForTest();
    });

    it('reports the missing seed as a capability at WARN, never at ERROR', async () => {
        const handle = await resolveNodePty('/nonexistent/deps');

        expect(handle).toEqual({ available: false, reason: 'no-seed-package' });
        expect(logged.warn.some((line) => line.includes('no seed node-pty package found'))).toBe(true);
        expect(logged.error).toEqual([]);
    });
});
