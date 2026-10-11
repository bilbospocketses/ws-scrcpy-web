// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FirstRunStatus } from '../../common/ConfigEvents';
import { AdminScopeBanner, bannerStateFor } from './AdminScopeBanner';
import { announceRemoteAdminChanged } from './adminAccess';

/**
 * `vi.waitFor` with a budget that survives a loaded machine (item 140).
 *
 * Every wait in this file is waiting on the same thing: a `dialog` that only
 * exists after the banner dynamically `import()`s the modal. That import pays
 * for an on-demand module transform the FIRST time it runs, inside the wait's
 * own clock -- and `vi.waitFor` has its own short default budget which
 * `vitest.config.ts`'s `testTimeout: 20000` does not extend. On a quiet box
 * the transform finishes in milliseconds and nobody notices; with the CPU
 * saturated it does not, and the wait gives up while the import is still
 * compiling. It fails as `expected null to be truthy`, which reads as "the
 * modal never opened" rather than "we stopped waiting too early".
 *
 * Measured 2026-09-22: 1 failure in 6 full-suite runs with 24 CPU burners
 * live, always one of these waits, never on an idle machine.
 */
const waitForModal = (assertion: () => void): Promise<void> => vi.waitFor(assertion, { timeout: 15_000, interval: 25 });

function runtime(over: Partial<FirstRunStatus>): FirstRunStatus {
    return { firstRunComplete: true, portWasAutoShifted: false, webPort: 8000, ...over };
}

describe('bannerStateFor', () => {
    it('hides when sign-in is on', () => {
        expect(bannerStateFor(runtime({ adminScope: 'authenticated', callerIsLocal: true }))).toBe('hidden');
    });

    it('hides on a server that predates the guard (no adminScope)', () => {
        expect(bannerStateFor(runtime({}))).toBe('hidden');
    });

    it('offers the buttons to a loopback caller under the local policy', () => {
        expect(bannerStateFor(runtime({ adminScope: 'local', callerIsLocal: true }))).toBe('local-actionable');
    });

    it('offers instructions only to a remote caller under the local policy', () => {
        expect(bannerStateFor(runtime({ adminScope: 'local', callerIsLocal: false }))).toBe('local-readonly');
    });

    // 0.5.5: the warning moved to Settings -> Users, under the checkbox that
    // turns the opt-out off as well as on. The home page says nothing.
    it('hides once the opt-out is active', () => {
        expect(bannerStateFor(runtime({ adminScope: 'remote', callerIsLocal: false }))).toBe('hidden');
        expect(bannerStateFor(runtime({ adminScope: 'remote', callerIsLocal: true }))).toBe('hidden');
    });
});

describe('AdminScopeBanner rendering', () => {
    // Instructions only. A remote caller must be given no control that changes
    // the server's posture — in open mode there is no auth, so a working
    // "enable" button here would render for an attacker too. Dismiss is a
    // per-user UI preference, not an action on the server, so it is allowed.
    it('renders no ACTION buttons in the read-only state', () => {
        const banner = new AdminScopeBanner();
        banner.render(runtime({ adminScope: 'local', callerIsLocal: false }));
        const labels = [...banner.getElement().querySelectorAll('button')].map((b) => b.textContent);
        expect(labels).not.toContain('Set up sign-in');
        expect(labels).not.toContain('Allow remote admin without sign-in');
        expect(labels).toEqual(['Dismiss']);
        expect(banner.getElement().textContent).toContain('WS_SCRCPY_ALLOW_REMOTE_ADMIN=1');
    });

    it('renders both buttons in the actionable state, sign-in first', () => {
        const banner = new AdminScopeBanner();
        banner.render(runtime({ adminScope: 'local', callerIsLocal: true }));
        const labels = [...banner.getElement().querySelectorAll('button')].map((b) => b.textContent);
        expect(labels.slice(0, 2)).toEqual(['Set up sign-in', 'Allow remote admin without sign-in']);
    });

    it('never uses innerHTML for server-supplied values', () => {
        const banner = new AdminScopeBanner();
        banner.render(runtime({ adminScope: 'local', callerIsLocal: true }));
        expect(banner.getElement().innerHTML).not.toContain('<script');
    });

    it('hides the container in the hidden state', () => {
        const banner = new AdminScopeBanner();
        banner.render(runtime({ adminScope: 'authenticated', callerIsLocal: true }));
        expect(banner.getElement().style.display).toBe('none');
    });
});

describe('AdminScopeBanner polling lifecycle', () => {
    it('destroy() clears the interval', () => {
        vi.useFakeTimers();
        const fetchSpy = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ runtime: runtime({ adminScope: 'local', callerIsLocal: true }) }),
        });
        vi.stubGlobal('fetch', fetchSpy);
        const banner = new AdminScopeBanner();
        banner.start();
        const callsAfterStart = fetchSpy.mock.calls.length;
        banner.destroy();
        vi.advanceTimersByTime(120_000);
        expect(fetchSpy.mock.calls.length).toBe(callsAfterStart);
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });
});

// 0.5.9: saving remote admin in Settings acts on the banner at once, both ways,
// instead of on the next 30 s poll (or a manual reload).
describe('AdminScopeBanner follows a remote-admin save', () => {
    let current: FirstRunStatus;
    let settings: Record<string, unknown>;

    beforeEach(async () => {
        current = runtime({ adminScope: 'local', callerIsLocal: true });
        settings = {};
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => ({
                ok: true,
                json: async () => (url === '/api/config' ? { runtime: current } : settings),
            })),
        );
        // loadGlobal() memoizes per page; forget it so each test seeds its own
        // dismissal flag from `settings`.
        const { settingsService } = await import('./SettingsService');
        (settingsService as unknown as { globalCache: unknown }).globalCache = null;
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    const shown = (b: AdminScopeBanner) => b.getElement().style.display !== 'none';

    it('hides when remote admin is turned on, and comes back when it is turned off', async () => {
        const banner = new AdminScopeBanner();
        banner.start();
        await vi.waitFor(() => expect(shown(banner)).toBe(true));

        current = runtime({ adminScope: 'remote', callerIsLocal: true });
        announceRemoteAdminChanged();
        await vi.waitFor(() => expect(shown(banner)).toBe(false));

        current = runtime({ adminScope: 'local', callerIsLocal: true });
        announceRemoteAdminChanged();
        await vi.waitFor(() => expect(shown(banner)).toBe(true));
        banner.destroy();
    });

    it('stays hidden when turned off again if it had been dismissed', async () => {
        settings = { adminScopeBannerDismissed: true };
        const banner = new AdminScopeBanner();
        banner.start();
        // Wait for the seed and the first read to land, so the events below
        // are judged by a banner that knows it was dismissed.
        await vi.waitFor(() => expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2));
        await new Promise((r) => setTimeout(r, 20));
        current = runtime({ adminScope: 'remote', callerIsLocal: true });
        announceRemoteAdminChanged();
        await new Promise((r) => setTimeout(r, 20));
        current = runtime({ adminScope: 'local', callerIsLocal: true });
        announceRemoteAdminChanged();
        await vi.waitFor(() => expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(4));
        await new Promise((r) => setTimeout(r, 20));
        expect(shown(banner)).toBe(false);
        banner.destroy();
    });

    it('a slow read that set off before the save does not overwrite the newer one', async () => {
        // The first /api/config read (an earlier poll) is held until the
        // save's own read has rendered, then answers with the old policy.
        let releaseOld: (() => void) | undefined;
        let configReads = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) => {
                if (url !== '/api/config') return { ok: true, json: async () => settings };
                configReads += 1;
                if (configReads === 1) {
                    const old = runtime({ adminScope: 'local', callerIsLocal: true });
                    await new Promise<void>((r) => {
                        releaseOld = r;
                    });
                    return { ok: true, json: async () => ({ runtime: old }) };
                }
                return { ok: true, json: async () => ({ runtime: current }) };
            }),
        );
        const banner = new AdminScopeBanner();
        banner.start();
        await vi.waitFor(() => expect(releaseOld).toBeDefined());
        current = runtime({ adminScope: 'remote', callerIsLocal: true });
        announceRemoteAdminChanged();
        await vi.waitFor(() => expect(configReads).toBe(2));
        await new Promise((r) => setTimeout(r, 20));
        releaseOld?.();
        await new Promise((r) => setTimeout(r, 20));
        expect(shown(banner)).toBe(false);
        banner.destroy();
    });

    it('destroy() stops listening', async () => {
        const banner = new AdminScopeBanner();
        banner.start();
        await vi.waitFor(() => expect(shown(banner)).toBe(true));
        banner.destroy();
        const calls = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
        announceRemoteAdminChanged();
        await new Promise((r) => setTimeout(r, 20));
        expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls);
    });
});

// The card is a funnel toward sign-in, so backing out of the risky option must
// route to the safe one — and must not have widened anything on the way.
describe('AdminScopeBanner opt-out wiring', () => {
    beforeEach(() => {
        HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
            this.setAttribute('open', '');
        });
        HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
            this.removeAttribute('open');
        });
    });

    afterEach(() => {
        document.body.replaceChildren();
        vi.unstubAllGlobals();
    });

    it('declining the warning routes to sign-in and does NOT patch config', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ runtime: {} }) });
        vi.stubGlobal('fetch', fetchSpy);
        const banner = new AdminScopeBanner();
        banner.render(runtime({ adminScope: 'local', callerIsLocal: true }));
        const allow = [...banner.getElement().querySelectorAll('button')].find(
            (b) => b.textContent === 'Allow remote admin without sign-in',
        );
        allow?.click();
        // Let the dynamic import + the modal's queueMicrotask body settle.
        await waitForModal(() => {
            expect(document.querySelector('dialog')).toBeTruthy();
        });
        const decline = [...document.querySelectorAll('button')].find(
            (b) => b.textContent === 'Set up sign-in instead',
        );
        decline?.click();
        await waitForModal(() => {
            expect(document.querySelectorAll('dialog').length).toBeGreaterThan(0);
        });
        const patched = fetchSpy.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
        expect(patched).toBe(false);
    });

    it('accepting the warning PATCHes allowRemoteAdmin: true', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ runtime: {} }) });
        vi.stubGlobal('fetch', fetchSpy);
        const banner = new AdminScopeBanner();
        banner.render(runtime({ adminScope: 'local', callerIsLocal: true }));
        [...banner.getElement().querySelectorAll('button')]
            .find((b) => b.textContent === 'Allow remote admin without sign-in')
            ?.click();
        await waitForModal(() => {
            expect(document.querySelector('dialog')).toBeTruthy();
        });
        [...document.querySelectorAll('button')]
            .find((b) => b.textContent === 'I understand — allow remote admin')
            ?.click();
        await waitForModal(() => {
            const patch = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
            expect(patch).toBeTruthy();
            const init = (patch as unknown[])[1] as RequestInit;
            expect(JSON.parse(init.body as string)).toEqual({ allowRemoteAdmin: true });
        });
    });
});

describe('AdminScopeBanner dismissal', () => {
    it('renders nothing at all under the remote policy', () => {
        for (const callerIsLocal of [true, false]) {
            const banner = new AdminScopeBanner();
            banner.render(runtime({ adminScope: 'remote', callerIsLocal }));
            expect(banner.getElement().style.display).toBe('none');
            expect(banner.getElement().childElementCount).toBe(0);
            expect(banner.getElement().textContent).toBe('');
        }
    });

    it('a banner that was showing goes away when the opt-out is turned on', () => {
        const banner = new AdminScopeBanner();
        banner.render(runtime({ adminScope: 'local', callerIsLocal: true }));
        expect(banner.getElement().style.display).not.toBe('none');
        banner.render(runtime({ adminScope: 'remote', callerIsLocal: true }));
        expect(banner.getElement().style.display).toBe('none');
        expect(banner.getElement().childElementCount).toBe(0);
        expect(banner.getElement().dataset['state']).toBeUndefined();
    });

    it('offers Dismiss in both local states', () => {
        const actionable = new AdminScopeBanner();
        actionable.render(runtime({ adminScope: 'local', callerIsLocal: true }));
        expect([...actionable.getElement().querySelectorAll('button')].map((b) => b.textContent)).toContain('Dismiss');

        const readonly = new AdminScopeBanner();
        readonly.render(runtime({ adminScope: 'local', callerIsLocal: false }));
        expect([...readonly.getElement().querySelectorAll('button')].map((b) => b.textContent)).toContain('Dismiss');
    });

    it('a dismissed banner hides the local states', () => {
        const banner = new AdminScopeBanner();
        (banner as unknown as { dismissed: boolean }).dismissed = true;
        banner.render(runtime({ adminScope: 'local', callerIsLocal: true }));
        expect(banner.getElement().style.display).toBe('none');
    });

    it('Dismiss PATCHes the per-user flag', async () => {
        const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
        vi.stubGlobal('fetch', fetchSpy);
        const banner = new AdminScopeBanner();
        banner.render(runtime({ adminScope: 'local', callerIsLocal: true }));
        [...banner.getElement().querySelectorAll('button')].find((b) => b.textContent === 'Dismiss')?.click();
        await waitForModal(() => {
            const patch = fetchSpy.mock.calls.find(([url]) => url === '/api/settings');
            expect(patch).toBeTruthy();
            const init = (patch as unknown[])[1] as RequestInit;
            expect(JSON.parse(init.body as string)).toEqual({ adminScopeBannerDismissed: true });
        });
        vi.unstubAllGlobals();
    });
});
