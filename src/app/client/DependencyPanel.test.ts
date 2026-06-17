// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DependencyInfo, DependencyStatus } from '../../common/DependencyTypes';
import { DependencyPanel } from './DependencyPanel';

const dep = (o: Partial<DependencyInfo>): DependencyInfo => ({
    name: 'adb',
    displayName: 'ADB',
    installedVersion: null,
    latestVersion: null,
    status: DependencyStatus.Error,
    description: 'desc',
    requiresRestart: false,
    canUpdate: false,
    ...o,
});

describe('DependencyPanel XSS', () => {
    it('escapes a malicious displayName/description instead of injecting markup', () => {
        const panel = new DependencyPanel();
        (panel as any).render([
            dep({ displayName: '<img src=x onerror=alert(1)>', description: '<svg onload=alert(2)>' }),
        ]);
        const body = panel.getElement().querySelector('tbody');
        expect(body?.querySelector('img')).toBeNull();
        expect(body?.querySelector('svg')).toBeNull();
        expect(body?.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('escapes a malicious errorMessage in the status title attribute', () => {
        const panel = new DependencyPanel();
        (panel as any).render([
            dep({ status: DependencyStatus.Error, errorMessage: 'x"><img src=y onerror=alert(1)>' }),
        ]);
        const body = panel.getElement().querySelector('tbody');
        expect(body?.querySelector('img')).toBeNull();
    });
});

describe('DependencyPanel polling lifecycle (#36)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => [] }));
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('stops polling after destroy() — the interval no longer fires load()', () => {
        const panel = new DependencyPanel();
        (panel as any).startPolling();
        const loadSpy = vi.spyOn(panel as any, 'load');

        // One interval before destroy → load() fires.
        vi.advanceTimersByTime(15_000);
        expect(loadSpy).toHaveBeenCalledTimes(1);

        panel.destroy();
        loadSpy.mockClear();

        // After destroy, advancing well past several intervals → no more load().
        vi.advanceTimersByTime(60_000);
        expect(loadSpy).not.toHaveBeenCalled();
    });

    it('destroy() is idempotent / safe to call without polling started', () => {
        const panel = new DependencyPanel();
        expect(() => panel.destroy()).not.toThrow();
    });
});
