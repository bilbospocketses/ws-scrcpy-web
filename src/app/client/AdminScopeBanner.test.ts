// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FirstRunStatus } from '../../common/ConfigEvents';
import { AdminScopeBanner, bannerStateFor } from './AdminScopeBanner';

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

    it('warns persistently once the opt-out is active', () => {
        expect(bannerStateFor(runtime({ adminScope: 'remote', callerIsLocal: false }))).toBe('remote-warning');
        expect(bannerStateFor(runtime({ adminScope: 'remote', callerIsLocal: true }))).toBe('remote-warning');
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
        await vi.waitFor(() => {
            expect(document.querySelector('dialog')).toBeTruthy();
        });
        const decline = [...document.querySelectorAll('button')].find(
            (b) => b.textContent === 'Set up sign-in instead',
        );
        decline?.click();
        await vi.waitFor(() => {
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
        await vi.waitFor(() => {
            expect(document.querySelector('dialog')).toBeTruthy();
        });
        [...document.querySelectorAll('button')]
            .find((b) => b.textContent === 'I understand — allow remote admin')
            ?.click();
        await vi.waitFor(() => {
            const patch = fetchSpy.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PATCH');
            expect(patch).toBeTruthy();
            const init = (patch as unknown[])[1] as RequestInit;
            expect(JSON.parse(init.body as string)).toEqual({ allowRemoteAdmin: true });
        });
    });
});

describe('AdminScopeBanner dismissal', () => {
    it('the remote-warning state has no dismiss control', () => {
        const banner = new AdminScopeBanner();
        banner.render(runtime({ adminScope: 'remote', callerIsLocal: true }));
        const labels = [...banner.getElement().querySelectorAll('button')].map((b) => b.textContent);
        expect(labels).not.toContain('Dismiss');
    });

    it('offers Dismiss in both local states', () => {
        const actionable = new AdminScopeBanner();
        actionable.render(runtime({ adminScope: 'local', callerIsLocal: true }));
        expect([...actionable.getElement().querySelectorAll('button')].map((b) => b.textContent)).toContain('Dismiss');

        const readonly = new AdminScopeBanner();
        readonly.render(runtime({ adminScope: 'local', callerIsLocal: false }));
        expect([...readonly.getElement().querySelectorAll('button')].map((b) => b.textContent)).toContain('Dismiss');
    });

    it('a dismissed banner still shows the remote-warning state', () => {
        const banner = new AdminScopeBanner();
        (banner as unknown as { dismissed: boolean }).dismissed = true;
        banner.render(runtime({ adminScope: 'remote', callerIsLocal: true }));
        expect(banner.getElement().style.display).not.toBe('none');
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
        await vi.waitFor(() => {
            const patch = fetchSpy.mock.calls.find(([url]) => url === '/api/settings');
            expect(patch).toBeTruthy();
            const init = (patch as unknown[])[1] as RequestInit;
            expect(JSON.parse(init.body as string)).toEqual({ adminScopeBannerDismissed: true });
        });
        vi.unstubAllGlobals();
    });
});
