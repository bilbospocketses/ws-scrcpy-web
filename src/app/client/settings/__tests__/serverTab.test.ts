// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResetConfirmModal } from '../../ResetConfirmModal';
import { settingsService } from '../../SettingsService';
import { StagedSettingsStore } from '../StagedSettingsStore';
import { askUnbound } from '../tabs/EmbeddingTab';
import {
    applyServerAdminUnreachable,
    applyServerContainerMode,
    applyServerHostMode,
    applyServerServiceStatus,
    buildServerTab,
    PORT_COLLISION_ERROR,
    PORT_RESTART_NOTE,
    refreshServer,
    refreshServerHttps,
    subPrivilegedPortNotice,
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

// 0.5.5: three cards under their own headings, the tab title hidden.
describe('ServerTab: Settings, Ports and Application cards', () => {
    const cardsOf = (el: HTMLElement) =>
        [...el.querySelectorAll<HTMLElement>(':scope > h4.settings-card-heading')].map((h) => ({
            heading: h,
            card: h.nextElementSibling as HTMLElement,
        }));
    const labelsIn = (card: HTMLElement) =>
        [...card.querySelectorAll(':scope > .settings-item')].map(
            (item) => item.querySelector('.settings-label')?.textContent,
        );

    it('splits the tab into Settings / Ports / Application, each item one setting', () => {
        const el = buildServerTab({ ...ctx, authEnabled: true }, new StagedSettingsStore());
        const title = el.querySelector<HTMLElement>(':scope > h3.settings-section-heading')!;
        expect(title.textContent).toBe('Server');
        expect(title.classList.contains('visually-hidden')).toBe(true);
        const cards = cardsOf(el);
        expect(cards.map((c) => c.heading.textContent)).toEqual(['Settings', 'Ports', 'Application']);
        expect(labelsIn(cards[0]!.card)).toEqual(['reset all my settings', 'password', 'session']);
        // The http and https ports are separate items.
        expect(labelsIn(cards[1]!.card)).toEqual(['http port', 'https port']);
        expect(labelsIn(cards[2]!.card)).toEqual([
            'install for all users',
            'stop the server and close the app',
            'uninstall ws-scrcpy-web',
        ]);
        // 0.5.8: the note the tab shows only where the admin API will not
        // answer this page (applyServerAdminUnreachable) is a card of its own,
        // with no heading, right under Settings, and hidden until then.
        const noteCard = cards[0]!.card.nextElementSibling as HTMLElement;
        expect(noteCard.className).toBe('settings-card');
        expect(noteCard.hidden).toBe(true);
        expect(noteCard.nextElementSibling).toBe(cards[1]!.heading);
        expect(noteCard.querySelector(':scope > .settings-item > [data-admin-unreachable-note]')).not.toBeNull();
        expect(el.querySelectorAll('[data-admin-unreachable-note]')).toHaveLength(1);
    });

    /**
     * Where the admin API will not answer (0.5.8): the Settings card as it
     * always is, then ONE untitled card holding only the note; the Ports and
     * Application cards hidden, headings and all. Asserted by `hidden`, never
     * by text: jsdom's textContent reads hidden elements too.
     */
    function expectOnlyNoteBesideSettings(el: HTMLElement): void {
        const cards = [...el.querySelectorAll<HTMLElement>(':scope > .settings-card')];
        const headings = [...el.querySelectorAll<HTMLElement>(':scope > h4.settings-card-heading')];
        const byHeading = (text: string) => headings.find((h) => h.textContent === text)!;
        const cardUnder = (text: string) => byHeading(text).nextElementSibling as HTMLElement;
        const noteCard = cards.find((c) => c.querySelector('[data-admin-unreachable-note]'))!;
        // Settings: shown, and every control in it usable.
        expect(byHeading('Settings').hidden).toBe(false);
        expect(cardUnder('Settings').hidden).toBe(false);
        // Ports and Application: hidden with their headings.
        for (const title of ['Ports', 'Application']) {
            expect(byHeading(title).hidden, title).toBe(true);
            expect(cardUnder(title).hidden, title).toBe(true);
        }
        // The note's card: shown, below Settings, and holding the note alone.
        expect(noteCard.hidden).toBe(false);
        expect(noteCard.previousElementSibling).toBe(cardUnder('Settings'));
        const notes = [...el.querySelectorAll<HTMLElement>('[data-admin-unreachable-note]')];
        expect(notes).toHaveLength(1);
        expect(notes[0]!.hidden).toBe(false);
        expect(notes[0]!.textContent).toBe('admin changes are limited to the machine running the server.');
        expect(noteCard.querySelectorAll('.settings-row, button, input')).toHaveLength(0);
        // Exactly two cards on show: Settings and the note's.
        expect(cards.filter((c) => !c.hidden)).toEqual([cardUnder('Settings'), noteCard]);
    }

    it('where the admin API will not answer, shows the Settings card and the note alone, and holds back the rest', () => {
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
        const el = buildServerTab({ ...ctx, authEnabled: true }, new StagedSettingsStore());
        applyServerHostMode(el);
        applyServerAdminUnreachable(el);
        expectOnlyNoteBesideSettings(el);
        // Still disabled under the hidden cards, as defense in depth.
        expect(rowOf(el, 'http port').querySelector('input')!.disabled).toBe(true);
        expect(rowOf(el, 'https port').querySelector('input')!.disabled).toBe(true);
        expect(rowOf(el, 'stop the server and close the app').querySelector('button')!.disabled).toBe(true);
        // The user's own controls stay.
        expect(rowOf(el, 'reset all my settings').querySelector('button')!.disabled).toBe(false);
        expect(el.querySelector<HTMLButtonElement>('[data-action="change-password"]')!.disabled).toBe(false);
        expect(el.querySelector<HTMLButtonElement>('[data-action="logout"]')!.disabled).toBe(false);
    });

    // SettingsModal calls these in varying orders: the post-probe block holds
    // the tab back BEFORE host mode, `onAdminRefused` after it, and a service
    // status can arrive after either. None may bring a hidden card back.
    it('host mode after the hold, then a service status, show neither the Ports nor the Application card', () => {
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
        const el = buildServerTab({ ...ctx, authEnabled: true }, new StagedSettingsStore());
        applyServerAdminUnreachable(el);
        applyServerHostMode(el);
        applyServerServiceStatus(el, { supported: true, platform: 'linux', status: 'not-installed' });
        expectOnlyNoteBesideSettings(el);
        expect(rowOf(el, 'stop the server and close the app').querySelector('button')!.disabled).toBe(true);
    });

    it('host mode before the hold, then a service status, show neither the Ports nor the Application card', () => {
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
        const el = buildServerTab({ ...ctx, authEnabled: true }, new StagedSettingsStore());
        applyServerHostMode(el);
        applyServerServiceStatus(el, { supported: true, platform: 'win32', status: 'not-installed' });
        applyServerAdminUnreachable(el);
        applyServerServiceStatus(el, { supported: true, platform: 'linux', status: 'not-installed' });
        expectOnlyNoteBesideSettings(el);
    });

    it('in a container, held back, shows the Settings card and the note alone too', () => {
        const el = buildServerTab({ ...ctx, authEnabled: true }, new StagedSettingsStore());
        applyServerAdminUnreachable(el);
        applyServerContainerMode(el);
        applyServerHostMode(el);
        expectOnlyNoteBesideSettings(el);
    });

    it('where the admin API answers, the note card stays hidden and the admin cards show', () => {
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
        const el = buildServerTab(ctx, new StagedSettingsStore());
        applyServerHostMode(el);
        applyServerServiceStatus(el, { supported: true, platform: 'linux', status: 'not-installed' });
        const noteCard = el
            .querySelector<HTMLElement>('[data-admin-unreachable-note]')!
            .closest<HTMLElement>('.settings-card')!;
        expect(noteCard.hidden).toBe(true);
        for (const h of el.querySelectorAll<HTMLElement>(':scope > h4.settings-card-heading')) {
            expect(h.hidden, h.textContent ?? '').toBe(false);
            expect((h.nextElementSibling as HTMLElement).hidden, h.textContent ?? '').toBe(false);
        }
    });

    it('held back, "reset all my settings" still sends the per-user reset, and not the first-run half', async () => {
        vi.spyOn(ResetConfirmModal, 'confirm').mockResolvedValue(true);
        const reset = vi.spyOn(settingsService, 'reset').mockResolvedValue(undefined);
        const fetchMock = vi.fn().mockReturnValue(new Promise(() => undefined));
        vi.stubGlobal('fetch', fetchMock);
        const reload = vi.fn();
        const el = buildServerTab({ ...ctx, reload }, new StagedSettingsStore());
        applyServerHostMode(el);
        applyServerAdminUnreachable(el);
        rowOf(el, 'reset all my settings').querySelector('button')!.click();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        expect(reset).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/config')).toEqual([]);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    it('puts every https-port note, and the restart note both ports share, under the https port', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        const httpsItem = rowOf(el, 'https port').parentElement!;
        expect(httpsItem.classList.contains('settings-item')).toBe(true);
        for (const hook of [
            'data-https-port-status',
            'data-https-port-gate-note',
            'data-tls-port-notice',
            'data-port-restart-note',
        ]) {
            expect(el.querySelector(`[${hook}]`)?.parentElement, hook).toBe(httpsItem);
        }
        // The http port's item holds its own status line and nothing else.
        const httpItem = rowOf(el, 'http port').parentElement!;
        expect([...httpItem.children]).toEqual([rowOf(el, 'http port'), webPortStatusOf(el)]);
    });

    it('hides the Ports card, heading and all, until the host is known, and for good in a container', () => {
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
        const onHost = buildServerTab(ctx, new StagedSettingsStore());
        const ports = cardsOf(onHost)[1]!;
        expect(ports.card.hidden).toBe(true);
        expect(ports.heading.hidden).toBe(true);
        applyServerHostMode(onHost);
        expect(ports.card.hidden).toBe(false);
        expect(ports.heading.hidden).toBe(false);

        const inContainer = buildServerTab(ctx, new StagedSettingsStore());
        applyServerContainerMode(inContainer);
        applyServerHostMode(inContainer);
        const containerPorts = cardsOf(inContainer)[1]!;
        expect(containerPorts.card.hidden).toBe(true);
        expect(containerPorts.heading.hidden).toBe(true);
    });

    it('marks hidden rows with the hidden attribute too, which is how a card knows an item has nothing showing', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        for (const label of ['install for all users', 'uninstall ws-scrcpy-web', 'http port', 'https port']) {
            expect(rowOf(el, label).hidden, label).toBe(true);
        }
        applyServerServiceStatus(el, { supported: true, platform: 'linux', status: 'not-installed' });
        expect(rowOf(el, 'install for all users').hidden).toBe(false);
        expect(rowOf(el, 'uninstall ws-scrcpy-web').hidden).toBe(false);
    });

    it('gives a user without admin rights the Settings card alone', () => {
        const el = buildServerTab({ ...ctx, role: 'user' as const }, new StagedSettingsStore());
        const cards = cardsOf(el);
        expect(cards.map((c) => c.heading.textContent)).toEqual(['Settings']);
        expect(labelsIn(cards[0]!.card)).toEqual(['reset all my settings']);
        // No admin cards, so no note to stand in for them, held back or not.
        applyServerAdminUnreachable(el);
        expect(el.querySelectorAll(':scope > .settings-card')).toHaveLength(1);
        expect(el.querySelector('[data-admin-unreachable-note]')).toBeNull();
    });
});

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

    it('container mode hides the http port row and its status line', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        applyServerContainerMode(el);
        expect(rowOf(el, 'http port').style.display).toBe('none');
        expect(webPortStatusOf(el).hidden).toBe(true);
    });

    it('the desktop path shows the http port row once the host is known', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
        // Built hidden: until the probe answers, this could be a container (M6).
        expect(rowOf(el, 'http port').style.display).toBe('none');
        applyServerHostMode(el);
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
        applyServerHostMode(el);
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

    it('shows the restart note on a host, worded for both ports', () => {
        const el = buildServerTab(ctx, new StagedSettingsStore());
        applyServerHostMode(el);
        const p = parts(el);
        expect(p.restartNote.hidden).toBe(false);
        expect(p.restartNote.textContent).toBe(PORT_RESTART_NOTE);
        expect(PORT_RESTART_NOTE).toBe('changing either port restarts the server; any active streams will drop.');
    });

    it('starts disabled with the note shown, and reads nothing on its own', () => {
        const fetchMock = vi.fn().mockReturnValue(new Promise(() => undefined));
        vi.stubGlobal('fetch', fetchMock);
        const el = buildServerTab(ctx, new StagedSettingsStore());
        applyServerHostMode(el);
        const p = parts(el);
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

        // Move the https port away, and the http row's 8443 is staged without
        // a re-edit, its refusal cleared (M9).
        change(httpsInput, '9443');
        expect(httpStatus.hidden).toBe(true);
        expect(httpInput.value).toBe('8443');
        expect(store.changes().map((c) => [c.id, c.to])).toEqual([
            ['webPort', 8443],
            ['httpsPort', 9443],
        ]);
    });

    it('fixing a collision from the http row stages the https row it blocked (M9)', async () => {
        const { httpInput, httpsInput, httpsStatus, store } = await built({ webPort: 8000 });
        change(httpsInput, '8000');
        expect(httpsStatus.textContent).toBe(PORT_COLLISION_ERROR);
        change(httpInput, '8010');
        expect(httpsStatus.hidden).toBe(true);
        expect(store.changes().map((c) => [c.id, c.to])).toEqual([
            ['webPort', 8010],
            ['httpsPort', 8000],
        ]);
    });

    // User decision after 0.5.3: equal ports matter only while a certificate
    // exists. Without one there is no https listener, and an http port of
    // 8443 (the default https port) is staged as it always was.
    it('stages an http port of 8443 when there is no certificate', async () => {
        const { httpInput, httpStatus, store } = await built({ tls: { status: 'none', httpsPort: 8443 } });
        change(httpInput, '8443');
        expect(httpStatus.hidden).toBe(true);
        expect(store.changes().map((c) => [c.id, c.to])).toEqual([['webPort', 8443]]);
    });

    it('stages an http port of 8443 when /api/tls/state cannot be read', async () => {
        const { httpInput, store } = await built({ tls: 'fail' });
        change(httpInput, '8443');
        expect(store.changes().map((c) => [c.id, c.to])).toEqual([['webPort', 8443]]);
    });

    it('refuses an http port staged without a certificate once one appears, and takes it off the stage', async () => {
        const answers: Answers = { tls: { status: 'none', httpsPort: 8443 } };
        const { el, httpInput, httpsInput, httpStatus, store } = await built(answers);
        change(httpInput, '8443');
        expect(store.changes().map((c) => [c.id, c.to])).toEqual([['webPort', 8443]]);

        // A certificate is generated (TLS_CERT_CHANGED_EVENT -> re-read).
        answers.tls = { status: 'ready', httpsPort: 8443 };
        await refreshServerHttps(el);
        expect(httpStatus.hidden).toBe(false);
        expect(httpStatus.textContent).toBe(PORT_COLLISION_ERROR);
        // Not left for Save to send into a 409.
        expect(store.changes()).toEqual([]);
        expect(httpInput.value).toBe('8443');

        // Moving the https port away stages the http row's 8443 again (M9).
        change(httpsInput, '9443');
        expect(httpStatus.hidden).toBe(true);
        expect(store.changes().map((c) => [c.id, c.to])).toEqual([
            ['webPort', 8443],
            ['httpsPort', 9443],
        ]);
    });

    it('leaves an untouched http row alone when the certificate state changes', async () => {
        const answers: Answers = { tls: { status: 'none', httpsPort: 8443 } };
        const { el, httpStatus, store } = await built(answers);
        answers.tls = { status: 'ready', httpsPort: 8443 };
        await refreshServerHttps(el);
        expect(httpStatus.hidden).toBe(true);
        expect(store.changes()).toEqual([]);
    });

    it('lifts the http row refusal when the certificate goes away, and stages its value', async () => {
        const answers: Answers = { tls: { status: 'ready', httpsPort: 8443 } };
        const { el, httpInput, httpStatus, store } = await built(answers);
        change(httpInput, '8443');
        expect(httpStatus.textContent).toBe(PORT_COLLISION_ERROR);
        answers.tls = { status: 'none', httpsPort: 8443 };
        await refreshServerHttps(el);
        expect(httpStatus.hidden).toBe(true);
        expect(store.changes().map((c) => [c.id, c.to])).toEqual([['webPort', 8443]]);
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

    it('drops a staged https port when a re-read fails and the row closes (M3)', async () => {
        const answers: Answers = { tls: { status: 'ready', httpsPort: 8443 } };
        const { el, httpsInput, store } = await built(answers);
        change(httpsInput, '9443');
        expect(store.changes().map((c) => c.id)).toEqual(['httpsPort']);

        answers.tls = 'fail';
        await refreshServerHttps(el);
        expect(httpsInput.disabled).toBe(true);
        expect(httpsInput.value).toBe('8443');
        expect(store.changes()).toEqual([]);
    });

    it('builds both port rows and every note hidden until the probe answers (M6)', () => {
        vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => undefined)));
        const el = buildServerTab(ctx, new StagedSettingsStore());
        const p = parts(el);
        expect(rowOf(el, 'http port').style.display).toBe('none');
        expect(p.httpsRow.style.display).toBe('none');
        for (const note of [p.httpStatus, p.httpsStatus, p.gateNote, p.privilegeNotice, p.restartNote]) {
            expect(note.hidden).toBe(true);
        }
        applyServerHostMode(el);
        expect(rowOf(el, 'http port').style.display).toBe('');
        expect(p.httpsRow.style.display).toBe('');
        expect(p.restartNote.hidden).toBe(false);
        expect(p.gateNote.hidden).toBe(false);
    });

    it('names each port input after its row and describes it by the notes showing (M8)', async () => {
        const { el, httpInput, httpsInput, httpStatus, gateNote, restartNote } = await built({
            tls: { status: 'none', httpsPort: 8443 },
        });
        // The tab is not attached to the document, so the id is resolved within it.
        const nameOf = (input: HTMLInputElement): string | null | undefined =>
            el.querySelector(`#${input.getAttribute('aria-labelledby')}`)?.textContent;
        expect(nameOf(httpInput)).toBe('http port');
        expect(nameOf(httpsInput)).toBe('https port');
        expect(httpsInput.getAttribute('aria-describedby')?.split(' ')).toEqual([gateNote.id, restartNote.id]);
        expect(httpInput.getAttribute('aria-describedby')?.split(' ')).toEqual([restartNote.id]);

        change(httpInput, '80');
        expect(httpInput.getAttribute('aria-describedby')?.split(' ')).toEqual([httpStatus.id, restartNote.id]);
    });

    it('container mode hides the https row and every note with the http row', async () => {
        const fetchMock = stubReads({});
        const el = buildServerTab(ctx, new StagedSettingsStore());
        applyServerContainerMode(el);
        // A host decision arriving after the container one changes nothing.
        applyServerHostMode(el);
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

    it('subPrivilegedPortNotice fires only on linux/darwin for a sub-1024 port', () => {
        expect(subPrivilegedPortNotice(443, 'linux')).toMatch(/elevated privileges/i);
        expect(subPrivilegedPortNotice(443, 'darwin')).toMatch(/elevated privileges/i);
        expect(subPrivilegedPortNotice(443, 'win32')).toBeNull();
        // M2: an unknown platform claims nothing.
        expect(subPrivilegedPortNotice(443, undefined)).toBeNull();
        expect(subPrivilegedPortNotice(8443, 'linux')).toBeNull();
    });

    it('is not built for a role that cannot see the http port', () => {
        const el = buildServerTab({ ...ctx, role: 'user' }, new StagedSettingsStore());
        expect(el.querySelector('[data-tls-port]')).toBeNull();
        expect(el.querySelector('[data-port-restart-note]')).toBeNull();
    });
});
