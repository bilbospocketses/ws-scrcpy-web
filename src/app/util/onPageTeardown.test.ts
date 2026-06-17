// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { onPageTeardown } from './onPageTeardown';

describe('onPageTeardown (#36)', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('registers the cleanup on both pagehide and beforeunload', () => {
        const add = vi.spyOn(window, 'addEventListener');
        onPageTeardown(() => undefined);
        const events = add.mock.calls.map((c) => c[0]);
        expect(events).toContain('pagehide');
        expect(events).toContain('beforeunload');
    });

    it('runs the cleanup when the page is torn down (idempotent across both events)', () => {
        const cleanup = vi.fn();
        onPageTeardown(cleanup);
        window.dispatchEvent(new Event('beforeunload'));
        expect(cleanup).toHaveBeenCalledTimes(1);
        window.dispatchEvent(new Event('pagehide'));
        expect(cleanup).toHaveBeenCalledTimes(2);
    });
});
