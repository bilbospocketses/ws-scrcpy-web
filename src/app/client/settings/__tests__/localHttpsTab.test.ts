// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { askUnbound } from '../tabs/EmbeddingTab';
import {
    applyLocalHttpsContainerMode,
    applyLocalHttpsDependencyInstalled,
    applyLocalHttpsServiceStatus,
    applyLocalHttpsServiceStatusFailed,
    buildLocalHttpsTab,
} from '../tabs/LocalHttpsTab';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const ctx = {
    role: 'admin' as const,
    authEnabled: false,
    reload: () => undefined,
    askChild: askUnbound,
    openChild: <T>(open: () => T) => open(),
};

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Every `section.settings-section` heading inside the tab. */
function headings(el: HTMLElement): string[] {
    return [...el.querySelectorAll('section.settings-section > h3.settings-section-heading')].map(
        (h) => h.textContent ?? '',
    );
}

/** Answers /api/tls/state and /api/dependencies; mkcert's version is re-read every call. */
function hostFetch(mkcert: () => string | null) {
    return vi.fn((url: string) => {
        if (url === '/api/tls/state') {
            return Promise.resolve(new Response(JSON.stringify({ status: 'none', candidateIps: ['192.168.86.3'] })));
        }
        if (url === '/api/dependencies') {
            const v = mkcert();
            return Promise.resolve(
                new Response(
                    JSON.stringify([
                        { name: 'mkcert', installedVersion: v, status: v === null ? 'not-installed' : 'up-to-date' },
                    ]),
                ),
            );
        }
        return new Promise<Response>(() => undefined);
    });
}

describe('Local HTTPS tab (0.5.3: its own tab, right after Server)', () => {
    it('builds synchronously, fetches nothing, and shows one Local HTTPS heading over a placeholder', () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const el = buildLocalHttpsTab(ctx);
        expect(el.dataset['settingsTab']).toBe('local-https');
        expect(headings(el)).toEqual(['Local HTTPS']);
        expect(el.textContent).toContain('loading…');
        expect(el.querySelector('[data-tls-subject]')).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('the first service status builds the panel in place of the placeholder', async () => {
        vi.stubGlobal(
            'fetch',
            hostFetch(() => 'v0.1.0'),
        );
        const el = buildLocalHttpsTab(ctx);
        applyLocalHttpsServiceStatus(el, { supported: true, platform: 'win32', status: 'not-installed' });
        await flush();
        expect(el.querySelector('[data-tls-subject]')).not.toBeNull();
        expect(el.textContent).not.toContain('loading…');
        // Still exactly one section under that heading: the panel replaced the placeholder.
        expect(headings(el)).toEqual(['Local HTTPS']);
    });

    it('a second service status does not rebuild the panel (no second /api/tls/state read)', async () => {
        const fetchMock = hostFetch(() => 'v0.1.0');
        vi.stubGlobal('fetch', fetchMock);
        const el = buildLocalHttpsTab(ctx);
        applyLocalHttpsServiceStatus(el, { supported: true, platform: 'win32', status: 'not-installed' });
        await flush();
        const subject = el.querySelector('[data-tls-subject]');
        applyLocalHttpsServiceStatus(el, { supported: true, platform: 'win32', status: 'not-installed' });
        await flush();
        expect(el.querySelector('[data-tls-subject]')).toBe(subject);
        expect(fetchMock.mock.calls.filter(([url]) => url === '/api/tls/state')).toHaveLength(1);
    });

    it('in a container shows ONLY the reverse-proxy note, and fetches nothing', () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const el = buildLocalHttpsTab(ctx);
        applyLocalHttpsContainerMode(el);
        const note = el.querySelector('[data-local-https-container-note]');
        expect(note).not.toBeNull();
        expect(note?.textContent).toMatch(/reverse proxy/);
        expect(headings(el)).toEqual(['Local HTTPS']);
        // Nothing of the panel: no controls, no mkcert note, no download.
        expect(el.querySelector('[data-tls-subject]')).toBeNull();
        expect(el.querySelector('[data-tls-mkcert-notice]')).toBeNull();
        expect(el.querySelector('[data-tls-download]')).toBeNull();
        expect(el.querySelectorAll('button')).toHaveLength(0);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a later service status does not build the panel over the container note', async () => {
        const fetchMock = vi.fn().mockReturnValue(new Promise(() => undefined));
        vi.stubGlobal('fetch', fetchMock);
        const el = buildLocalHttpsTab(ctx);
        applyLocalHttpsContainerMode(el);
        applyLocalHttpsServiceStatus(el, { supported: false, platform: 'linux', docker: true });
        await flush();
        expect(el.querySelector('[data-local-https-container-note]')).not.toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a dependency install re-checks mkcert and lifts the note at the top of the tab', async () => {
        let mkcert: string | null = null;
        vi.stubGlobal(
            'fetch',
            hostFetch(() => mkcert),
        );
        const el = buildLocalHttpsTab(ctx);
        applyLocalHttpsServiceStatus(el, { supported: true, platform: 'win32', status: 'not-installed' });
        await flush();
        const notice = (): HTMLElement => el.querySelector<HTMLElement>('[data-tls-mkcert-notice]')!;
        expect(notice().hidden).toBe(false);
        expect(el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.disabled).toBe(true);

        mkcert = 'v0.1.0';
        await applyLocalHttpsDependencyInstalled(el);
        expect(notice().hidden).toBe(true);
        expect(el.querySelector<HTMLButtonElement>('[data-tls-generate]')!.disabled).toBe(false);
    });

    it('the mkcert callout is the first thing in the tab, above the heading, and its link opens Dependencies', async () => {
        vi.stubGlobal(
            'fetch',
            hostFetch(() => null),
        );
        const showTab = vi.fn();
        const el = buildLocalHttpsTab({ ...ctx, showTab });
        applyLocalHttpsServiceStatus(el, { supported: true, platform: 'win32', status: 'not-installed' });
        await flush();
        const notice = el.querySelector<HTMLElement>('[data-tls-mkcert-notice]')!;
        expect(notice.hidden).toBe(false);
        // The first element of the whole tab, in document order, and before the h3.
        expect(el.querySelector('*')).toBe(el.firstElementChild);
        expect(el.firstElementChild?.firstElementChild).toBe(notice);
        const heading = el.querySelector('h3.settings-section-heading')!;
        expect(notice.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(headings(el)).toEqual(['Local HTTPS']);

        notice.querySelector<HTMLButtonElement>('.settings-inline-link')!.click();
        expect(showTab).toHaveBeenCalledWith('dependencies');
    });

    it('a dependency install before the panel exists is a harmless no-op', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const el = buildLocalHttpsTab(ctx);
        await applyLocalHttpsDependencyInstalled(el);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    // 0.5.3 review (M3): a failed /api/service/status left this tab on
    // "loading…" forever.
    describe('when the service status read fails', () => {
        it("shows couldn't reach server in the error tone with a retry, in place of loading…", () => {
            const fetchMock = vi.fn();
            vi.stubGlobal('fetch', fetchMock);
            const el = buildLocalHttpsTab(ctx);
            applyLocalHttpsServiceStatusFailed(el, vi.fn());
            expect(el.textContent).not.toContain('loading…');
            const label = el.querySelector('.settings-label')!;
            expect(label.textContent).toBe("couldn't reach server");
            expect(label.classList.contains('settings-status-error')).toBe(true);
            expect(el.querySelector('[data-local-https-retry]')?.textContent).toBe('retry');
            expect(headings(el)).toEqual(['Local HTTPS']);
            // The tab fetches nothing of its own; the retry is the shared read's.
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it('retry shows loading… again and re-runs the shared read; its success builds the panel', async () => {
            vi.stubGlobal(
                'fetch',
                hostFetch(() => 'v0.1.0'),
            );
            const el = buildLocalHttpsTab(ctx);
            const retry = vi.fn();
            applyLocalHttpsServiceStatusFailed(el, retry);
            el.querySelector<HTMLButtonElement>('[data-local-https-retry]')!.click();
            expect(retry).toHaveBeenCalledOnce();
            expect(el.textContent).toContain('loading…');
            expect(el.querySelector('[data-local-https-retry]')).toBeNull();

            applyLocalHttpsServiceStatus(el, { supported: true, platform: 'win32', status: 'not-installed' });
            await flush();
            expect(el.querySelector('[data-tls-subject]')).not.toBeNull();
            expect(el.textContent).not.toContain("couldn't reach server");
        });

        it('a failure after the tab is decided changes nothing', async () => {
            vi.stubGlobal(
                'fetch',
                hostFetch(() => 'v0.1.0'),
            );
            const el = buildLocalHttpsTab(ctx);
            applyLocalHttpsServiceStatus(el, { supported: true, platform: 'win32', status: 'not-installed' });
            await flush();
            applyLocalHttpsServiceStatusFailed(el, vi.fn());
            expect(el.querySelector('[data-tls-subject]')).not.toBeNull();
            expect(el.querySelector('[data-local-https-retry]')).toBeNull();

            const container = buildLocalHttpsTab(ctx);
            applyLocalHttpsContainerMode(container);
            applyLocalHttpsServiceStatusFailed(container, vi.fn());
            expect(container.querySelector('[data-local-https-container-note]')).not.toBeNull();
            expect(container.querySelector('[data-local-https-retry]')).toBeNull();
        });
    });
});
