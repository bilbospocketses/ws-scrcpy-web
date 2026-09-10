// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DependencyInfo, DependencyStatus } from '../../common/DependencyTypes';
import { FirstRunBanner } from './FirstRunBanner';

const dep = (displayName: string): DependencyInfo => ({
    name: 'x',
    displayName,
    installedVersion: null,
    latestVersion: null,
    status: DependencyStatus.Error,
    description: '',
    requiresRestart: false,
    canUpdate: false,
});

describe('FirstRunBanner XSS', () => {
    it('escapes a malicious dependency displayName instead of injecting markup', () => {
        const banner = new FirstRunBanner();
        (banner as any).render([dep('<img src=x onerror=alert(1)>')]);
        const el = banner.getElement();
        expect(el.querySelector('img')).toBeNull();
        expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    });
});

describe('FirstRunBanner polling lifecycle (#36)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        // Return a pending dep so refresh() keeps the banner (and polling) alive
        // — otherwise refresh() self-stops polling when nothing is pending.
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [dep('SomeDep')],
            }),
        );
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('stops polling after destroy() — the interval no longer fires refresh()', () => {
        const banner = new FirstRunBanner();
        (banner as any).startPolling();
        const refreshSpy = vi.spyOn(banner as any, 'refresh');

        vi.advanceTimersByTime(15_000);
        expect(refreshSpy).toHaveBeenCalledTimes(1);

        banner.destroy();
        refreshSpy.mockClear();

        vi.advanceTimersByTime(60_000);
        expect(refreshSpy).not.toHaveBeenCalled();
    });

    it('destroy() is safe to call without polling started', () => {
        const banner = new FirstRunBanner();
        expect(() => banner.destroy()).not.toThrow();
    });
});

// Item 81. GET /api/dependencies is admin-gated at the top of its handler, so a
// caller the admin API will not answer would 403-spam every 15 s on a healthy
// app. The banner must mount completely inert in that case — no first fetch,
// no interval — not merely render nothing.
describe('FirstRunBanner admin-reachability suppression (item 81)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => [dep('SomeDep')],
            }),
        );
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('makes no request and starts no interval when the admin API is unreachable', async () => {
        const banner = await FirstRunBanner.create({ adminScope: 'local', callerIsLocal: false });
        expect(fetch).not.toHaveBeenCalled();
        vi.advanceTimersByTime(120_000);
        expect(fetch).not.toHaveBeenCalled();
        expect(banner.getElement().style.display).toBe('none');
    });

    it('polls as usual for a loopback caller under the same policy', async () => {
        await FirstRunBanner.create({ adminScope: 'local', callerIsLocal: true });
        expect(fetch).toHaveBeenCalled();
    });

    it('polls as usual when no runtime is supplied (older callers)', async () => {
        await FirstRunBanner.create();
        expect(fetch).toHaveBeenCalled();
    });
});
