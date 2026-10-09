// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResetConfirmModal } from '../../ResetConfirmModal';
import { settingsService } from '../../SettingsService';
import { StagedSettingsStore } from '../StagedSettingsStore';
import { askUnbound } from '../tabs/EmbeddingTab';
import {
    applyServerContainerMode,
    applyServerServiceStatus,
    buildServerTab,
    PORT_COLLISION_ERROR,
    PORT_RESTART_NOTE,
    refreshServer,
    refreshServerHttps,
} from '../tabs/ServerTab';

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

/**
 * The status line for the http port is the element immediately after its row —
 * located that way rather than by `.settings-status`, which the install and
 * stop-server notes also carry.
 */
function webPortStatusOf(el: HTMLElement): HTMLElement {
    const row = [...el.querySelectorAll('.settings-row')].find(
        (r) => r.querySelector('.settings-label')?.textContent === 'http port',
    );
    return row?.nextElementSibling as HTMLElement;
}

/** A Server-tab row's element, found by its label. */
function rowOf(el: HTMLElement, label: string): HTMLElement {
    const row = [...el.querySelectorAll<HTMLElement>('.settings-row')].find(
        (r) => r.querySelector('.settings-label')?.textContent === label,
    );
    if (!row) throw new Error(`no row labelled "${label}"`);
    return row;
}

describe('ServerTab: the install-lifecycle rows are a DECISION, never the default (findings 20.4, 20.5)', () => {
    const APP_ROWS = ['install for all users', 'uninstall ws-scrcpy-web'];

    it('both rows start hidden and undecided', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        expect(el.dataset['appRowsDecided']).toBeUndefined();
        for (const label of APP_ROWS) expect(rowOf(el, label).style.display).toBe('none');
    });

    it('container mode decides: hidden, and says so', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        applyServerContainerMode(el);
        expect(el.dataset['appRowsDecided']).toBe('container');
        for (const label of APP_ROWS) expect(rowOf(el, label).style.display).toBe('none');
        // "stop server & exit" is untouched: it is correct in a container (row 20.6).
        const stop = [...el.querySelectorAll('button')].find((b) => b.textContent === 'stop server & exit');
        expect(stop?.disabled).toBe(false);
    });

    it('the desktop path decides from the service status: shown on Linux, marked as such', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        applyServerServiceStatus(el, { supported: true, platform: 'linux', status: 'not-installed' });
        expect(el.dataset['appRowsDecided']).toBe('service-status');
        for (const label of APP_ROWS) expect(rowOf(el, label).style.display).toBe('');
    });
});

describe('ServerTab: container decisions for port, HTTPS and reset (row 20.19)', () => {
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    it('container mode hides the web-port row and its status line', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        applyServerContainerMode(el);
        expect(rowOf(el, 'http port').style.display).toBe('none');
        expect(webPortStatusOf(el).hidden).toBe(true);
    });

    it('the desktop path leaves the web-port row visible', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
        applyServerServiceStatus(el, { supported: true, platform: 'linux', status: 'not-installed' });
        expect(rowOf(el, 'http port').style.display).toBe('');
    });

    // 0.5.3: Local HTTPS is its own tab now (localHttpsTab.test.ts). The Server
    // tab carries none of it, on a host or in a container.
    it('carries no Local HTTPS section, and a service status fetches no /api/tls/state', async () => {
        const fetchMock = vi.fn().mockReturnValue(new Promise(() => undefined));
        vi.stubGlobal('fetch', fetchMock);
        const el = buildServerTab(ctx, new StagedSettingsStore());
        applyServerServiceStatus(el, { supported: true, platform: 'linux', status: 'not-installed' });
        await flush();
        expect(el.querySelector('[data-local-https-container-note]')).toBeNull();
        expect(el.querySelector('[data-tls-subject]')).toBeNull();
        expect([...el.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Server']);
        expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain('/api/tls/state');
    });

    it('container mode leaves no Local HTTPS note in the Server tab', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        applyServerContainerMode(el);
        expect(el.querySelector('[data-local-https-container-note]')).toBeNull();
    });

    it('"reset all my settings" in a container clears user settings but never PATCHes firstRunComplete', async () => {
        const resetSpy = vi.spyOn(settingsService, 'reset').mockResolvedValue(undefined);
        vi.spyOn(ResetConfirmModal, 'confirm').mockResolvedValue(true);
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
        vi.stubGlobal('fetch', fetchMock);
        const reload = vi.fn();
        const el = buildServerTab({ ...ctx, reload }, new StagedSettingsStore());
        applyServerContainerMode(el);

        const button = [...el.querySelectorAll('button')].find((b) => b.textContent === 'reset');
        button?.click();
        await flush();

        expect(resetSpy).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.find(([url]) => url === '/api/config')).toBeUndefined();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('"reset all my settings" on the desktop still PATCHes firstRunComplete', async () => {
        vi.spyOn(settingsService, 'reset').mockResolvedValue(undefined);
        vi.spyOn(ResetConfirmModal, 'confirm').mockResolvedValue(true);
        const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
        vi.stubGlobal('fetch', fetchMock);
        const el = buildServerTab(ctx, new StagedSettingsStore());

        const button = [...el.querySelectorAll('button')].find((b) => b.textContent === 'reset');
        button?.click();
        await flush();

        const configCall = fetchMock.mock.calls.find(([url]) => url === '/api/config');
        expect(JSON.parse(configCall?.[1].body as string)).toEqual({ firstRunComplete: false });
    });
});

describe('ServerTab', () => {
    it('registers webPort so it can be staged', () => {
        const store = new StagedSettingsStore();
        buildServerTab(ctx, store);
        expect(store.get('webPort')).toBeDefined();
    });

    it('typing a new port stages it instead of saving immediately', () => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        input.value = '8010';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        expect(store.changes().map((c) => c.id)).toContain('webPort');
    });

    it('has no per-field Save button — Save lives on the dialog now', () => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        // Case-insensitive on purpose. The button this tab removed rendered
        // lowercase 'save', like every other button here, so an exact-case
        // assertion would have passed with it still present — and the pin has to
        // survive a future relabel too.
        const labels = [...el.querySelectorAll('button')].map((b) => (b.textContent ?? '').trim().toLowerCase());
        expect(labels).not.toContain('save');
    });

    // The range guard `onSavePort` used to apply before saving. With that button
    // gone it belongs on the stage: `Config.validateField` rejects a bad port by
    // THROWING, so an unguarded stage turns into a 400 the user never asked for.
    it('refuses to stage a port outside 1024-65535 and says why', () => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        input.value = '80';
        input.dispatchEvent(new Event('change', { bubbles: true }));

        expect(store.changes()).toEqual([]);
        const status = webPortStatusOf(el);
        expect(status.textContent).toBe('port must be between 1024 and 65535');
        expect(status.hidden).toBe(false);
    });

    it('refuses to stage an emptied port field — it must not reach the server as 0', () => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        input.value = '';
        input.dispatchEvent(new Event('change', { bubbles: true }));

        expect(store.changes()).toEqual([]);
        expect(webPortStatusOf(el).textContent).toBe('port must be between 1024 and 65535');
    });

    // '8010.5' is the case `parseInt` got wrong: it truncated to 8010 and staged
    // a port the user never typed. 'not-a-port' never reaches the guard as typed
    // — a `type="number"` input sanitises junk to '' (verified in jsdom), so it
    // arrives as the emptied case and is refused by the range arm, not the
    // integer arm. Pinned anyway: what matters is that junk cannot stage.
    it.each([
        ['1023', 'below the floor'],
        ['65536', 'above the ceiling'],
        ['8010.5', 'not an integer'],
        ['not-a-port', 'sanitised to empty by the number input'],
    ])('refuses to stage %s (%s)', (value) => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));

        expect(store.changes()).toEqual([]);
        expect(webPortStatusOf(el).textContent).toBe('port must be between 1024 and 65535');
    });

    it.each(['1024', '65535'])('stages %s — the boundaries are inclusive, as the server accepts them', (value) => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));

        expect(store.changes().map((c) => c.to)).toEqual([Number(value)]);
    });

    it('clears the range message once a valid port replaces the bad one', () => {
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        input.value = '80';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.value = '8010';
        input.dispatchEvent(new Event('change', { bubbles: true }));

        expect(store.changes().map((c) => c.id)).toContain('webPort');
        const status = webPortStatusOf(el);
        expect(status.textContent).toBe('');
        expect(status.hidden).toBe(true);
    });

    // The port is registered with a `null` baseline at build time, because no
    // tab can know the real one synchronously. `refreshServer` re-REGISTERS it
    // with the value /api/config reports, which is what makes that value the
    // baseline. If that ever became a `set`, an untouched dialog would sit
    // permanently dirty at `null → 8000` and every batch Save would carry a
    // webPort change — restarting the server for a setting nobody edited.
    it('the /api/config read baselines the port rather than staging it', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ config: { webPort: 8000 } }) }),
        );
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);

        await refreshServer(el);

        const input = el.querySelector('input[type="number"]') as HTMLInputElement;
        expect(input.value).toBe('8000');
        expect(store.changes()).toEqual([]);

        // And the new baseline is what a later edit is measured against.
        input.value = '8010';
        input.dispatchEvent(new Event('change', { bubbles: true }));
        expect(store.changes()).toEqual([{ id: 'webPort', label: 'HTTP port', from: 8000, to: 8010 }]);
    });
});

/**
 * The https port, moved here from the Local HTTPS tab (after 0.5.3). Staged
 * like the http port; disabled until mkcert is installed AND a certificate
 * exists (user decision), with a note saying so.
 */
describe('ServerTab: the https port row', () => {
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    interface Answers {
        mkcert?: { status: string; installedVersion: string | null } | 'fail';
        tls?: { status: 'none' | 'ready'; httpsPort?: number } | 'fail';
        webPort?: number;
    }

    /** A fetch that answers the three reads this tab makes, as `answers` says. */
    function stubReads(answers: Answers): ReturnType<typeof vi.fn> {
        const ok = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
        const fetchMock = vi.fn((url: string) => {
            if (url === '/api/dependencies') {
                const m = answers.mkcert ?? { status: 'installed', installedVersion: '1.4.4' };
                if (m === 'fail') return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
                return ok([{ name: 'mkcert', ...m }]);
            }
            if (url === '/api/tls/state') {
                const t = answers.tls ?? { status: 'ready', httpsPort: 8443 };
                if (t === 'fail') return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
                return ok(t);
            }
            if (url === '/api/config') return ok({ config: { webPort: answers.webPort ?? 8000 } });
            return new Promise(() => undefined);
        });
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    function parts(el: HTMLElement) {
        const httpsRow = rowOf(el, 'https port');
        return {
            httpInput: rowOf(el, 'http port').querySelector('input') as HTMLInputElement,
            httpStatus: webPortStatusOf(el),
            httpsRow,
            httpsInput: httpsRow.querySelector('input[data-tls-port]') as HTMLInputElement,
            httpsStatus: el.querySelector('[data-https-port-status]') as HTMLElement,
            gateNote: el.querySelector('[data-https-port-gate-note]') as HTMLElement,
            privilegeNotice: el.querySelector('[data-tls-port-notice]') as HTMLElement,
            restartNote: el.querySelector('[data-port-restart-note]') as HTMLElement,
        };
    }

    async function built(answers: Answers = {}) {
        const fetchMock = stubReads(answers);
        const store = new StagedSettingsStore();
        const el = buildServerTab(ctx, store);
        await refreshServer(el);
        await refreshServerHttps(el);
        return { el, store, fetchMock, ...parts(el) };
    }

    const change = (input: HTMLInputElement, value: string): void => {
        input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    };

    it('sits right after the http port, then its notes, then the shared restart note', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        const labels = [...el.querySelectorAll('.settings-row')].map(
            (r) => r.querySelector('.settings-label')?.textContent,
        );
        expect(labels.indexOf('https port')).toBe(labels.indexOf('http port') + 1);
        const p = parts(el);
        const order = [p.httpsRow, p.httpsStatus, p.gateNote, p.privilegeNotice, p.restartNote];
        for (let i = 1; i < order.length; i++) {
            expect(order[i - 1]?.nextElementSibling, `element ${i}`).toBe(order[i]);
        }
        expect(p.httpsInput.type).toBe('number');
        expect(p.httpsInput.min).toBe('1');
        expect(p.httpsInput.max).toBe('65535');
        expect(p.httpsInput.style.maxWidth).toBe('120px');
    });

    it('always shows the restart note, worded for both ports', () => {
        const p = parts(buildServerTab(ctx, new StagedSettingsStore()));
        expect(p.restartNote.hidden).toBe(false);
        expect(p.restartNote.textContent).toBe(PORT_RESTART_NOTE);
        expect(PORT_RESTART_NOTE).toBe('changing either port restarts the server; any active streams will drop.');
    });

    it('starts disabled with the note shown, and reads nothing on its own', () => {
        const fetchMock = vi.fn().mockReturnValue(new Promise(() => undefined));
        vi.stubGlobal('fetch', fetchMock);
        const p = parts(buildServerTab(ctx, new StagedSettingsStore()));
        expect(p.httpsInput.disabled).toBe(true);
        expect(p.gateNote.hidden).toBe(false);
        expect(p.gateNote.textContent).toBe(
            'applies to the certificate local https generates; install mkcert and generate one first.',
        );
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('enables with mkcert installed and a certificate, prefilled with the configured port, note gone', async () => {
        const { httpsInput, gateNote, store } = await built({ tls: { status: 'ready', httpsPort: 9443 } });
        expect(httpsInput.disabled).toBe(false);
        expect(httpsInput.value).toBe('9443');
        expect(gateNote.hidden).toBe(true);
        // Baselined, not staged.
        expect(store.changes()).toEqual([]);
    });

    it('stays disabled without mkcert, even with a certificate', async () => {
        const { httpsInput, gateNote } = await built({
            mkcert: { status: 'not-installed', installedVersion: null },
            tls: { status: 'ready', httpsPort: 8443 },
        });
        expect(httpsInput.disabled).toBe(true);
        expect(gateNote.hidden).toBe(false);
    });

    it('stays disabled without a certificate, even with mkcert', async () => {
        const { httpsInput, gateNote } = await built({ tls: { status: 'none', httpsPort: 8443 } });
        expect(httpsInput.disabled).toBe(true);
        expect(gateNote.hidden).toBe(false);
        // Still shows the port it would use.
        expect(httpsInput.value).toBe('8443');
    });

    it('stays disabled when /api/tls/state cannot be read', async () => {
        const { httpsInput, gateNote } = await built({ tls: 'fail' });
        expect(httpsInput.disabled).toBe(true);
        expect(gateNote.hidden).toBe(false);
    });

    it('a certificate with an mkcert state the server cannot report is enough (fail-open, as on Local HTTPS)', async () => {
        const { httpsInput } = await built({ mkcert: 'fail', tls: { status: 'ready', httpsPort: 8443 } });
        expect(httpsInput.disabled).toBe(false);
    });

    it('falls back to 8443 when /api/tls/state names no port', async () => {
        const { httpsInput } = await built({ tls: { status: 'ready' } });
        expect(httpsInput.value).toBe('8443');
    });

    it('stages a new port as httpsPort for the dialog Save — there is no ok button', async () => {
        const { el, httpsInput, store } = await built();
        change(httpsInput, '9443');
        expect(store.changes()).toEqual([{ id: 'httpsPort', label: 'HTTPS port', from: 8443, to: 9443 }]);
        expect([...el.querySelectorAll('button')].map((b) => b.textContent)).not.toContain('ok');
        expect(el.querySelector('[data-tls-port-ok]')).toBeNull();
    });

    it.each(['0', '65536', '8443.5', ''])('refuses to stage %s and says why', async (value) => {
        const { httpsInput, httpsStatus, store } = await built();
        change(httpsInput, value);
        expect(store.changes()).toEqual([]);
        expect(httpsStatus.hidden).toBe(false);
        expect(httpsStatus.textContent).toBe('port must be between 1 and 65535');
        expect(httpsStatus.classList.contains('settings-status-error')).toBe(true);
    });

    it.each(['1', '443', '65535'])('stages %s — the https port is not held to the 1024 floor', async (value) => {
        const { httpsInput, store } = await built();
        change(httpsInput, value);
        expect(store.changes().map((c) => [c.id, c.to])).toEqual([['httpsPort', Number(value)]]);
    });

    it('refuses an https port equal to the http port, on the https row', async () => {
        const { httpsInput, httpsStatus, httpStatus, store } = await built({ webPort: 8000 });
        change(httpsInput, '8000');
        expect(store.changes()).toEqual([]);
        expect(httpsStatus.textContent).toBe(PORT_COLLISION_ERROR);
        expect(PORT_COLLISION_ERROR).toBe('the http and https ports must differ.');
        expect(httpStatus.hidden).toBe(true);
    });

    it('refuses an http port equal to the https port, on the http row — judged against the staged value', async () => {
        const { httpInput, httpsInput, httpStatus, store } = await built({ webPort: 8000 });
        change(httpInput, '8443');
        expect(store.changes()).toEqual([]);
        expect(httpStatus.textContent).toBe(PORT_COLLISION_ERROR);
        expect(httpStatus.classList.contains('settings-status-error')).toBe(true);

        // Move the https port away first, and the same http port is fine.
        change(httpsInput, '9443');
        change(httpInput, '8443');
        expect(store.changes().map((c) => [c.id, c.to])).toEqual([
            ['webPort', 8443],
            ['httpsPort', 9443],
        ]);
    });

    it('shows the sub-1024 notice for a privileged port on linux, never before the platform is known', async () => {
        const { el, httpsInput, privilegeNotice } = await built();
        httpsInput.value = '443';
        httpsInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(privilegeNotice.hidden).toBe(true);

        applyServerServiceStatus(el, { supported: true, platform: 'linux', status: 'not-installed' });
        expect(privilegeNotice.hidden).toBe(false);
        expect(privilegeNotice.textContent).toBe(
            'ports below 1024 need elevated privileges on this platform; the server may fail to start.',
        );

        httpsInput.value = '8443';
        httpsInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(privilegeNotice.hidden).toBe(true);
    });

    it('never shows the sub-1024 notice on win32', async () => {
        const { el, httpsInput, privilegeNotice } = await built();
        applyServerServiceStatus(el, { supported: true, platform: 'win32', status: 'not-installed' });
        httpsInput.value = '443';
        httpsInput.dispatchEvent(new Event('input', { bubbles: true }));
        expect(privilegeNotice.hidden).toBe(true);
    });

    it('a re-read after a certificate appears enables the row; after a revoke it closes and drops a staged edit', async () => {
        const answers: Answers = { tls: { status: 'none', httpsPort: 8443 } };
        const { el, httpsInput, gateNote, store } = await built(answers);
        expect(httpsInput.disabled).toBe(true);

        answers.tls = { status: 'ready', httpsPort: 8443 };
        await refreshServerHttps(el);
        expect(httpsInput.disabled).toBe(false);
        expect(gateNote.hidden).toBe(true);

        change(httpsInput, '9443');
        expect(store.changes().map((c) => c.id)).toEqual(['httpsPort']);

        // A re-read with the row still open keeps what was typed.
        await refreshServerHttps(el);
        expect(httpsInput.value).toBe('9443');
        expect(store.changes().map((c) => c.id)).toEqual(['httpsPort']);

        answers.tls = { status: 'none', httpsPort: 8443 };
        await refreshServerHttps(el);
        expect(httpsInput.disabled).toBe(true);
        expect(gateNote.hidden).toBe(false);
        expect(httpsInput.value).toBe('8443');
        expect(store.changes()).toEqual([]);
    });

    it('container mode hides the https row and every note with the http row', async () => {
        const fetchMock = stubReads({});
        const el = buildServerTab(ctx, new StagedSettingsStore());
        applyServerContainerMode(el);
        await refreshServerHttps(el);
        await flush();
        const p = parts(el);
        expect(p.httpsRow.style.display).toBe('none');
        for (const note of [p.httpsStatus, p.gateNote, p.privilegeNotice, p.restartNote]) {
            expect(note.hidden).toBe(true);
        }
        // And nothing in a container reads the Local HTTPS state.
        expect(fetchMock.mock.calls.map(([url]) => url)).not.toContain('/api/tls/state');
    });

    it('is not built for a role that cannot see the http port', () => {
        const el = buildServerTab({ ...ctx, role: 'user' }, new StagedSettingsStore());
        expect(el.querySelector('[data-tls-port]')).toBeNull();
        expect(el.querySelector('[data-port-restart-note]')).toBeNull();
    });
});
