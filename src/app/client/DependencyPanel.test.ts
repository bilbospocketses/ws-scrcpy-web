// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DependencyInfo, DependencyStatus } from '../../common/DependencyTypes';
import { DEPENDENCY_INSTALLED_EVENT, DependencyPanel } from './DependencyPanel';

/** A tab line that is not looked at, for the tests about something else. */
const noAlert = { show: () => undefined };

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
        const panel = new DependencyPanel(noAlert);
        (panel as any).render([
            dep({ displayName: '<img src=x onerror=alert(1)>', description: '<svg onload=alert(2)>' }),
        ]);
        const body = panel.getElement().querySelector('tbody');
        expect(body?.querySelector('img')).toBeNull();
        expect(body?.querySelector('svg')).toBeNull();
        expect(body?.textContent).toContain('<img src=x onerror=alert(1)>');
    });

    it('escapes a malicious errorMessage in the status title attribute', () => {
        const panel = new DependencyPanel(noAlert);
        (panel as any).render([
            dep({ status: DependencyStatus.Error, errorMessage: 'x"><img src=y onerror=alert(1)>' }),
        ]);
        const body = panel.getElement().querySelector('tbody');
        expect(body?.querySelector('img')).toBeNull();
    });
});

describe('DependencyPanel Latest cell', () => {
    const latestCell = (d: DependencyInfo): HTMLTableCellElement => {
        const panel = new DependencyPanel(noAlert);
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

// 0.5.1: a first-use dependency (mkcert) that is not installed reads "Not
// installed" with an install button, instead of an Unknown pill and nothing to
// press (installing it used to happen only by clicking generate on the Server tab).
describe('DependencyPanel install button for a first-use dependency', () => {
    const mkcert = (o: Partial<DependencyInfo> = {}): DependencyInfo =>
        dep({
            name: 'mkcert',
            displayName: 'mkcert',
            status: DependencyStatus.NotInstalled,
            deferInstall: true,
            canUpdate: true,
            latestVersion: '1.4.4-bt.3',
            ...o,
        });

    const rowFor = (d: DependencyInfo): HTMLTableRowElement => {
        const panel = new DependencyPanel(noAlert);
        (panel as any).render([d]);
        return panel.getElement().querySelector<HTMLTableRowElement>('tbody tr.dep-row')!;
    };

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('shows a Not installed badge, not Unknown, and an enabled install button', () => {
        const row = rowFor(mkcert());
        const badge = row.querySelector('.dep-status .dep-badge')!;
        expect(badge.textContent).toBe('Not installed');
        expect(badge.classList.contains('dep-not-installed')).toBe(true);
        expect(row.querySelector('.dep-unknown')).toBeNull();
        const btn = row.querySelector<HTMLButtonElement>('.dep-action button')!;
        expect(btn.textContent).toBe('install');
        expect(btn.disabled).toBe(false);
        expect(btn.getAttribute('data-update')).toBe('mkcert');
        expect(btn.hasAttribute('data-install')).toBe(true);
    });

    it('in dev mode (canUpdate false) keeps a disabled install button with the dev tooltip', () => {
        const btn = rowFor(mkcert({ canUpdate: false })).querySelector<HTMLButtonElement>('.dep-action button')!;
        expect(btn.disabled).toBe(true);
        expect(btn.textContent).toBe('install (dev)');
        expect(btn.title).toMatch(/In-app updates require an installed build/);
        expect(btn.hasAttribute('data-update')).toBe(false);
    });

    it('offers install again after a failed install, while the copy is still missing', () => {
        const row = rowFor(mkcert({ status: DependencyStatus.Error, errorMessage: 'refused' }));
        expect(row.querySelector('.dep-status .dep-badge')!.textContent).toBe('Error');
        expect(row.querySelector<HTMLButtonElement>('.dep-action button')!.textContent).toBe('install');
    });

    it('offers no install for a boot-installed dependency that is missing (the first-run banner owns that)', () => {
        const row = rowFor(dep({ status: DependencyStatus.Error, canUpdate: true }));
        expect(row.querySelector('.dep-action button')).toBeNull();
        const unknown = rowFor(dep({ status: DependencyStatus.Unknown, canUpdate: true }));
        expect(unknown.querySelector('.dep-status .dep-badge')!.textContent).toBe('Unknown');
        expect(unknown.querySelector('.dep-action button')).toBeNull();
    });

    it('says Installing..., not Updating..., while a missing dependency is being fetched', () => {
        const row = rowFor(mkcert({ status: DependencyStatus.Updating }));
        expect(row.querySelector('.dep-status .dep-badge')!.textContent).toBe('Installing...');
        expect(row.querySelector<HTMLButtonElement>('.dep-action button')!.textContent).toBe('installing...');
    });

    it('install POSTs the same update endpoint, re-reads the list and announces the install', async () => {
        const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
            if (url === '/api/dependencies/mkcert/update' && init?.method === 'POST') {
                return {
                    ok: true,
                    json: async () => ({ success: true, newVersion: '1.4.4-bt.3', requiresRestart: false }),
                };
            }
            return {
                ok: true,
                json: async () => [mkcert({ status: DependencyStatus.UpToDate, installedVersion: '1.4.4-bt.3' })],
            };
        });
        vi.stubGlobal('fetch', fetchMock);
        const panel = new DependencyPanel(noAlert);
        document.body.appendChild(panel.getElement());
        const announced = vi.fn();
        document.body.addEventListener(DEPENDENCY_INSTALLED_EVENT, (e) => announced((e as CustomEvent).detail));
        (panel as any).render([mkcert()]);

        const btn = panel.getElement().querySelector<HTMLButtonElement>('button[data-install]')!;
        btn.click();
        expect(btn.textContent).toBe('installing...');
        await new Promise((r) => setTimeout(r, 0));

        expect(fetchMock).toHaveBeenCalledWith('/api/dependencies/mkcert/update', { method: 'POST' });
        expect(fetchMock).toHaveBeenCalledWith('/api/dependencies');
        expect(announced).toHaveBeenCalledWith({ name: 'mkcert' });
        // Re-rendered from the re-read: installed now, so no install button.
        const badge = panel.getElement().querySelector('.dep-status .dep-badge')!;
        expect(badge.textContent).toBe('Up to date');
        expect(panel.getElement().querySelector('button[data-install]')).toBeNull();
        panel.getElement().remove();
    });

    it('a failed install says install failed on the tab line, re-reads, and announces nothing', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) =>
                url === '/api/dependencies/mkcert/update'
                    ? {
                          ok: false,
                          json: async () => ({
                              success: false,
                              errorMessage: 'no attestation',
                              requiresRestart: false,
                          }),
                      }
                    : { ok: true, json: async () => [mkcert({ status: DependencyStatus.Error })] },
            ),
        );
        // The browser's alert() is no longer used: the failure goes to the
        // Settings tab's status line (0.5.5).
        const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => undefined);
        const tabLine = { show: vi.fn() };
        const panel = new DependencyPanel(tabLine);
        const announced = vi.fn();
        panel.getElement().addEventListener(DEPENDENCY_INSTALLED_EVENT, announced);
        (panel as any).render([mkcert()]);

        panel.getElement().querySelector<HTMLButtonElement>('button[data-install]')!.click();
        await new Promise((r) => setTimeout(r, 0));

        expect(tabLine.show).toHaveBeenCalledWith('error', 'install failed: no attestation');
        expect(alertSpy).not.toHaveBeenCalled();
        expect(announced).not.toHaveBeenCalled();
        // Still missing, so the install button is back as the retry.
        expect(panel.getElement().querySelector('button[data-install]')).not.toBeNull();
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

    const startPoll = () => (new DependencyPanel(noAlert) as any).pollForRestart();

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
        const panel = new DependencyPanel(noAlert);
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
        const panel = new DependencyPanel(noAlert);
        expect(() => panel.destroy()).not.toThrow();
    });
});
