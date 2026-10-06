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

describe('DependencyPanel Latest cell', () => {
    const latestCell = (d: DependencyInfo): HTMLTableCellElement => {
        const panel = new DependencyPanel();
        (panel as any).render([d]);
        return panel.getElement().querySelectorAll<HTMLTableCellElement>('tbody td.dep-version')[1]!;
    };

    it('says a REFUSED lookup was refused, with its status, instead of the dash', () => {
        const cell = latestCell(
            dep({
                installedVersion: '4.1',
                status: DependencyStatus.Unknown,
                latestLookup: { seq: 2, at: '2026-10-06T12:00:00.000Z', outcome: 'refused', httpStatus: 403 },
            }),
        );
        expect(cell.textContent).toBe('refused (HTTP 403)');
        expect(cell.title).toMatch(/version lookup was refused \(HTTP 403\)/);
        expect(cell.title).toMatch(/installed version still works/);
    });

    it.each([
        ['no lookup yet', undefined],
        ['a failed lookup', { seq: 1, at: '2026-10-06T12:00:00.000Z', outcome: 'failed' as const }],
    ])('keeps the dash for %s', (_label, latestLookup) => {
        const cell = latestCell(dep({ latestLookup }));
        expect(cell.textContent).toBe('—');
        expect(cell.title).toBe('');
    });

    it('shows the version when there is one, whatever an older lookup said', () => {
        const cell = latestCell(
            dep({
                latestVersion: '4.1',
                latestLookup: { seq: 1, at: '2026-10-06T12:00:00.000Z', outcome: 'refused', httpStatus: 429 },
            }),
        );
        expect(cell.textContent).toBe('4.1');
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
