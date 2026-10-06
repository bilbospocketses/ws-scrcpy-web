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

// Smoke row 9.12: after Restart Now the page must reload onto the restarted
// server. The instance token is minted per process, so the new process answers
// the old page's poll with a stale-token 403, which is the proof it is up.
describe('DependencyPanel restart poll', () => {
    const originalLocation = window.location;
    let reload: ReturnType<typeof vi.fn>;
    let fetchMock: ReturnType<typeof vi.fn>;

    const reply = (status: number, body: unknown) => ({
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    });

    beforeEach(() => {
        vi.useFakeTimers();
        reload = vi.fn();
        Object.defineProperty(window, 'location', { value: { reload }, writable: true, configurable: true });
        fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        Object.defineProperty(window, 'location', { value: originalLocation, writable: true, configurable: true });
    });

    const startPoll = () => (new DependencyPanel() as any).pollForRestart();

    it('reloads once the server answers', async () => {
        fetchMock.mockResolvedValue(reply(200, []));
        startPoll();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('reloads on a stale-token 403: a different process now answers here', async () => {
        fetchMock.mockResolvedValue(reply(403, { error: 'forbidden', reason: 'missing or invalid token' }));
        startPoll();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(fetchMock).toHaveBeenCalledWith('/api/dependencies');
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['a 403 with any other body', 403, { error: 'forbidden' }],
        ['a 5xx', 503, { error: 'unavailable' }],
    ])('keeps polling, without reloading, on %s', async (_label, status, body) => {
        fetchMock.mockResolvedValue(reply(status, body));
        startPoll();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(reload).not.toHaveBeenCalled();
    });

    it('keeps polling while nothing answers at all', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(reply(200, []));
        startPoll();
        await vi.advanceTimersByTimeAsync(3_000);
        expect(reload).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(reload).toHaveBeenCalledTimes(1);
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
