// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAME_ANCESTORS_ADD_ID } from '../../../../common/embedderOrigin';
import { performDirtyClose, performStagedSave, type SaveDeps } from '../../SettingsModal';
import type { BatchResult } from '../SaveRunner';
import { type Change, StagedSettingsStore } from '../StagedSettingsStore';
import {
    applyEmbeddingContainerMode,
    askUnbound,
    buildEmbeddingTab,
    embedHttpsNote,
    formatEmbedAdditions,
    pendingEmbedOrigins,
} from '../tabs/EmbeddingTab';

/**
 * Settings → Embedding's pre-approval row (0.5.3). Adding STAGES: the origin
 * goes into the dialog's store, shows in the list as pending, and reaches the
 * server only through the dialog's Save (the batch, `frameAncestorsAdd`).
 * Nothing here may write on its own: every test asserts the only request the
 * tab made is the list read, unless Save is what is under test.
 */

let approved: string[] = [];
let listStatus = 200;
let hangList = false;
let calls: string[] = [];

beforeEach(() => {
    approved = [];
    listStatus = 200;
    hangList = false;
    calls = [];
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
            calls.push(`${init?.method ?? 'GET'} ${url}`);
            if (url === '/api/embed-origins' && hangList) return new Promise(() => undefined);
            if (url === '/api/embed-origins/revoke') return new Response('{}', { status: 500 });
            if (url === '/api/embed-origins') {
                return new Response(JSON.stringify({ origins: approved }), { status: listStatus });
            }
            return new Promise(() => undefined);
        }),
    );
});

const realShowModal = HTMLDialogElement.prototype.showModal;
const realClose = HTMLDialogElement.prototype.close;

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    HTMLDialogElement.prototype.showModal = realShowModal;
    HTMLDialogElement.prototype.close = realClose;
    document.body.replaceChildren();
});

function ctx() {
    return {
        role: 'admin' as const,
        authEnabled: false,
        reload: () => undefined,
        askChild: askUnbound,
        openChild: <T>(open: () => T) => open(),
    };
}

async function flush(): Promise<void> {
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setTimeout(r, 0));
}

async function buildTab(store = new StagedSettingsStore()) {
    const section = buildEmbeddingTab(ctx(), store);
    document.body.appendChild(section);
    await flush();
    const q = <T extends Element>(sel: string): T => {
        const el = section.querySelector<T>(sel);
        if (!el) throw new Error(`missing ${sel}`);
        return el;
    };
    const ui = {
        section,
        store,
        adder: q<HTMLElement>('[data-embed-add]'),
        address: q<HTMLInputElement>('[data-embed-address]'),
        port: q<HTMLInputElement>('[data-embed-port]'),
        scheme: q<HTMLSelectElement>('[data-embed-scheme]'),
        addBtn: q<HTMLButtonElement>('[data-embed-add-button]'),
        message: q<HTMLElement>('[data-embed-add-message]'),
        pendingRows: () => [...section.querySelectorAll<HTMLElement>('[data-embed-pending]')],
        listText: () => section.querySelector('[data-embed-list]')?.textContent ?? '',
        type(address: string, port = '', scheme: 'http' | 'https' | 'both' = 'http') {
            ui.address.value = address;
            ui.address.dispatchEvent(new Event('input'));
            ui.port.value = port;
            ui.port.dispatchEvent(new Event('input'));
            ui.scheme.value = scheme;
            ui.scheme.dispatchEvent(new Event('change'));
        },
        add(address: string, port = '', scheme: 'http' | 'https' | 'both' = 'http') {
            ui.type(address, port, scheme);
            ui.addBtn.click();
        },
    };
    return ui;
}

function writes(): string[] {
    return calls.filter((c) => !c.startsWith('GET '));
}

describe('the add row', () => {
    it('stays hidden until the approved list has loaded, then shows', async () => {
        hangList = true;
        const section = buildEmbeddingTab(ctx(), new StagedSettingsStore());
        await flush();
        const adder = section.querySelector<HTMLElement>('[data-embed-add]');
        // An item of the card since 0.5.5; modal.css's `.settings-item[hidden]`
        // takes it out of the layout, so `hidden` alone is the switch.
        expect(adder?.classList.contains('settings-item')).toBe(true);
        expect(adder?.hidden).toBe(true);
        expect(section.textContent).toContain('loading…');

        hangList = false;
        const ui = await buildTab();
        expect(ui.adder.hidden).toBe(false);
        expect(ui.adder.style.display).toBe('');
    });

    it('lays the tab out as one card: the list one item, the add row with all its notes another (0.5.5)', async () => {
        approved = ['http://a.lan'];
        const ui = await buildTab();
        const cards = ui.section.querySelectorAll(':scope > .settings-card');
        expect(cards).toHaveLength(1);
        const items = [...cards[0]!.children];
        expect(items.map((i) => i.className)).toEqual(['settings-item', 'settings-item']);
        expect(items[0]!.hasAttribute('data-embed-list')).toBe(true);
        expect(items[1]).toBe(ui.adder);
        // Every note under the add row belongs to its item, so no line can fall
        // between the row and them.
        for (const hook of ['data-embed-both-note', 'data-embed-add-message', 'data-embed-https-note']) {
            expect(ui.section.querySelector(`[${hook}]`)?.parentElement, hook).toBe(ui.adder);
        }
    });

    it('lets the empty-list line span both columns: it is a line of text, with no control beside it', async () => {
        const ui = await buildTab();
        const row = ui.section.querySelector<HTMLElement>('[data-embed-list] .settings-row')!;
        expect(row.textContent).toBe('No other origins may embed this app.');
        expect(row.querySelector('.settings-label')?.classList.contains('settings-label-wide')).toBe(true);
        expect(row.querySelector('.settings-control')).toBeNull();
    });

    it('stays hidden when the list cannot be read (another machine is refused), with the reason shown', async () => {
        listStatus = 403;
        const ui = await buildTab();
        expect(ui.adder.hidden).toBe(true);
        expect(ui.listText()).toContain('could not read the list');
    });

    it('offers http (the default), https and http & https', async () => {
        const ui = await buildTab();
        expect([...ui.scheme.options].map((o) => [o.value, o.textContent])).toEqual([
            ['http', 'http'],
            ['https', 'https'],
            ['both', 'http & https'],
        ]);
        expect(ui.scheme.value).toBe('http');
        // Sized to "http & https" and never squeezed below it (it used to read
        // "http & htt…"); the row wraps on a narrow dialog instead.
        expect(ui.scheme.style.width).toBe('auto');
        expect(ui.scheme.style.maxWidth).toBe('none');
        expect(ui.scheme.style.flexShrink).toBe('0');
        expect(ui.scheme.closest<HTMLElement>('.settings-control')?.style.flexWrap).toBe('wrap');
        // The address box is the one that gives way, so the row fits on one
        // line at the dialog's default width; the others keep their size.
        expect(ui.address.style.flex).toBe('1 1 9rem');
        expect(ui.address.style.minWidth).toBe('9rem');
        expect(ui.address.style.maxWidth).toBe('none');
        expect(ui.port.style.flexShrink).toBe('0');
        expect(ui.addBtn.style.flexShrink).toBe('0');
        expect(ui.port.placeholder).toBe('80');
        // A text box: a number input would report "8e3" as '' and read it as blank.
        expect(ui.port.type).toBe('text');
    });

    it('keeps add disabled, with nothing to complain about, while the address is empty', async () => {
        const ui = await buildTab();
        expect(ui.addBtn.disabled).toBe(true);
        ui.type('', '');
        expect(ui.addBtn.disabled).toBe(true);
        expect(ui.message.hidden).toBe(true);
    });

    it.each([
        ['tools_box', '', /not a valid ip address or hostname\. .*\(no underscores\).*punycode form \(xn--…\)/],
        ['256.1.1.1', '', /not a valid ipv4 address/],
        [
            '::1',
            '',
            /^browsers don't accept ipv6 addresses for embedding; use a hostname \(such as localhost\) or an ipv4 address\.$/,
        ],
        ['[fe80::1]', '', /browsers don't accept ipv6 addresses for embedding/],
        ['localhost:5159', '', /port box/],
        ['localhost', '0', /port must be a whole number from 1 to 65535/],
        ['localhost', '65536', /port must be a whole number from 1 to 65535/],
        ['localhost', '80.5', /port must be a whole number from 1 to 65535/],
    ])('shows an inline error and disables add for %s port %s', async (address, port, error) => {
        const ui = await buildTab();
        ui.type(address, port);
        expect(ui.addBtn.disabled).toBe(true);
        expect(ui.message.hidden).toBe(false);
        expect(ui.message.classList.contains('settings-status-error')).toBe(true);
        expect(ui.message.textContent).toMatch(error);

        // And a click (or Enter) is refused too, not just grayed out.
        ui.addBtn.disabled = false;
        ui.addBtn.click();
        ui.address.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(ui.store.isDirty()).toBe(false);
        expect(ui.pendingRows()).toHaveLength(0);
    });

    it('clears the error once the entry is corrected', async () => {
        const ui = await buildTab();
        ui.type('tools_box');
        expect(ui.message.hidden).toBe(false);
        ui.type('tools-box');
        expect(ui.message.hidden).toBe(true);
        expect(ui.addBtn.disabled).toBe(false);
    });
});

describe('adding stages, it does not write', () => {
    it('stages the origin, lists it as pending and makes the dialog dirty', async () => {
        const ui = await buildTab();
        ui.add('LocalHost', '5159');

        expect(ui.store.changes()).toEqual<Change[]>([
            {
                id: FRAME_ANCESTORS_ADD_ID,
                label: 'Allowed embedders',
                from: [],
                to: ['http://localhost:5159'],
                fromText: 'none added',
                toText: 'add http://localhost:5159',
            },
        ]);
        const rows = ui.pendingRows();
        expect(rows.map((r) => r.dataset['embedPending'])).toEqual(['http://localhost:5159']);
        expect(rows[0]?.textContent).toContain('pending — saved when you click save');
        expect(rows[0]?.querySelector('.settings-pending-tag')).not.toBeNull();
        // Nothing went to the server.
        expect(writes()).toEqual([]);
        // The row is ready for the next one.
        expect(ui.address.value).toBe('');
        expect(ui.port.value).toBe('');
        expect(ui.addBtn.disabled).toBe(true);
    });

    it('replaces the empty-state line once something is pending', async () => {
        const ui = await buildTab();
        expect(ui.listText()).toContain('No other origins may embed this app.');
        ui.add('localhost', '5159');
        expect(ui.listText()).not.toContain('No other origins may embed this app.');
    });

    it('adds by Enter as well as by the button', async () => {
        const ui = await buildTab();
        ui.type('localhost', '5159');
        ui.port.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(pendingEmbedOrigins(ui.store)).toEqual(['http://localhost:5159']);
    });

    it('stages two origins for http & https, each on its default port', async () => {
        const ui = await buildTab();
        ui.add('localhost', '', 'both');
        expect(pendingEmbedOrigins(ui.store)).toEqual(['http://localhost', 'https://localhost']);
        expect(ui.pendingRows()).toHaveLength(2);
    });

    it('stores a default port as no port at all', async () => {
        const ui = await buildTab();
        ui.add('tools.example', '80', 'http');
        ui.add('tools.example', '443', 'https');
        ui.add('box.example', '', 'https');
        expect(pendingEmbedOrigins(ui.store)).toEqual([
            'http://tools.example',
            'https://tools.example',
            'https://box.example',
        ]);
    });

    it('stages an IPv4 address as typed', async () => {
        const ui = await buildTab();
        ui.add('192.168.1.50', '5159');
        expect(pendingEmbedOrigins(ui.store)).toEqual(['http://192.168.1.50:5159']);
    });

    it('lists already-approved origins above the pending ones, with revoke', async () => {
        approved = ['https://frame.example'];
        const ui = await buildTab();
        ui.add('localhost', '5159');
        const labels = [...ui.section.querySelectorAll('[data-embed-list] .settings-label')].map((l) =>
            l.firstChild?.textContent?.trim(),
        );
        expect(labels).toEqual(['https://frame.example', 'http://localhost:5159']);
        const buttons = [...ui.section.querySelectorAll('[data-embed-list] button')].map((b) => b.textContent);
        expect(buttons).toEqual(['revoke', 'remove']);
    });
});

describe('duplicates', () => {
    it('refuses an origin that is already allowed', async () => {
        approved = ['http://localhost:5159'];
        const ui = await buildTab();
        ui.add('localhost', '5159');
        expect(ui.store.isDirty()).toBe(false);
        expect(ui.message.textContent).toBe('http://localhost:5159 is already allowed.');
        expect(ui.message.classList.contains('settings-status-error')).toBe(true);
        // What was typed stays, so it can be corrected.
        expect(ui.address.value).toBe('localhost');
    });

    it('treats an explicit default port as the same origin as none', async () => {
        approved = ['http://localhost'];
        const ui = await buildTab();
        ui.add('localhost', '80');
        expect(ui.store.isDirty()).toBe(false);
        expect(ui.message.textContent).toBe('http://localhost is already allowed.');
    });

    it('refuses an origin that is already pending', async () => {
        const ui = await buildTab();
        ui.add('localhost', '5159');
        ui.add('LOCALHOST', '5159');
        expect(pendingEmbedOrigins(ui.store)).toEqual(['http://localhost:5159']);
        expect(ui.message.textContent).toBe('http://localhost:5159 is already waiting to be saved.');
    });

    it('with http & https, stages the new half and names the duplicate', async () => {
        approved = ['http://localhost'];
        const ui = await buildTab();
        ui.add('localhost', '', 'both');
        expect(pendingEmbedOrigins(ui.store)).toEqual(['https://localhost']);
        expect(ui.message.textContent).toBe('http://localhost is already allowed; added https://localhost.');
        expect(ui.message.classList.contains('settings-status-error')).toBe(false);
    });
});

// After 0.5.3: http & https means each scheme on its default port, so it takes
// no port (port 80 with it used to stage https://host:80).
describe('http & https disables the port box', () => {
    const bothNote = (ui: Awaited<ReturnType<typeof buildTab>>): HTMLElement =>
        ui.section.querySelector<HTMLElement>('[data-embed-both-note]')!;

    it('clears and disables the port box, and says why, while http & https is chosen', async () => {
        const ui = await buildTab();
        expect(bothNote(ui).hidden).toBe(true);
        expect(ui.port.disabled).toBe(false);

        ui.address.value = 'localhost';
        ui.port.value = '5159';
        ui.port.dispatchEvent(new Event('input'));
        ui.scheme.value = 'both';
        ui.scheme.dispatchEvent(new Event('change'));

        expect(ui.port.value).toBe('');
        expect(ui.port.disabled).toBe(true);
        expect(bothNote(ui).hidden).toBe(false);
        expect(bothNote(ui).textContent).toBe(
            'uses 80 for http and 443 for https; for other ports, add each scheme separately.',
        );
        // The cleared box is valid with both: add is offered, nothing to complain about.
        expect(ui.addBtn.disabled).toBe(false);
        expect(ui.message.hidden).toBe(true);
        ui.addBtn.click();
        expect(pendingEmbedOrigins(ui.store)).toEqual(['http://localhost', 'https://localhost']);
        expect(writes()).toEqual([]);
    });

    it('gives the box back, empty, on switching to http or https', async () => {
        for (const back of ['http', 'https'] as const) {
            const ui = await buildTab();
            ui.scheme.value = 'both';
            ui.scheme.dispatchEvent(new Event('change'));
            ui.scheme.value = back;
            ui.scheme.dispatchEvent(new Event('change'));
            expect(ui.port.disabled, back).toBe(false);
            expect(ui.port.value, back).toBe('');
            expect(bothNote(ui).hidden, back).toBe(true);
            ui.section.remove();
        }
    });

    it('leaves a port typed under http alone when switching between http and https', async () => {
        const ui = await buildTab();
        ui.port.value = '5159';
        ui.scheme.value = 'https';
        ui.scheme.dispatchEvent(new Event('change'));
        expect(ui.port.value).toBe('5159');
        expect(ui.port.disabled).toBe(false);
    });

    it('refuses a port forced into the box with http & https, rather than staging https on it', async () => {
        const ui = await buildTab();
        ui.scheme.value = 'both';
        ui.scheme.dispatchEvent(new Event('change'));
        // Not reachable by typing (the box is disabled); the guard is what is under test.
        ui.address.value = 'localhost';
        ui.port.value = '80';
        ui.port.dispatchEvent(new Event('input'));
        expect(ui.addBtn.disabled).toBe(true);
        expect(ui.message.textContent).toBe(
            'http & https uses 80 for http and 443 for https; for another port, add each scheme separately.',
        );
        ui.port.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        expect(ui.store.isDirty()).toBe(false);
    });
});

describe('the https note under the add row', () => {
    const httpsNote = (ui: Awaited<ReturnType<typeof buildTab>>): HTMLElement =>
        ui.section.querySelector<HTMLElement>('[data-embed-https-note]')!;

    it('is always shown, under the add row, naming local https or a reverse proxy', async () => {
        const ui = await buildTab();
        const note = httpsNote(ui);
        expect(note.hidden).toBe(false);
        expect(ui.adder.contains(note)).toBe(true);
        expect(note.textContent).toBe(
            'an https page can only embed this app when this app is served over https too; browsers block an http ' +
                'frame inside an https page. set up local https or a reverse proxy first.',
        );
        ui.scheme.value = 'both';
        ui.scheme.dispatchEvent(new Event('change'));
        expect(note.hidden).toBe(false);
    });

    it('names the reverse proxy alone in a container, where local https is not supported', async () => {
        const ui = await buildTab();
        applyEmbeddingContainerMode(ui.section);
        expect(httpsNote(ui).textContent).toBe(
            'an https page can only embed this app when this app is served over https too; browsers block an http ' +
                'frame inside an https page. serve this app over https from your reverse proxy first.',
        );
        expect(embedHttpsNote(true)).toBe(httpsNote(ui).textContent);
        expect(embedHttpsNote(false)).toMatch(/set up local https or a reverse proxy first\.$/);
    });
});

describe('a list re-read that fails', () => {
    it('keeps showing what is pending, since Save would still send it', async () => {
        HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
            this.setAttribute('open', '');
        });
        HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
            this.removeAttribute('open');
        });
        approved = ['https://frame.example'];
        const ui = await buildTab();
        ui.add('localhost', '5159');

        // A revoke the server refuses makes the tab re-read the list, and that
        // read fails too.
        listStatus = 500;
        [...ui.section.querySelectorAll('button')].find((b) => b.textContent === 'revoke')?.click();
        await flush();
        const ok = [...document.querySelectorAll<HTMLButtonElement>('dialog.confirm-modal button')].find(
            (b) => b.textContent === 'ok',
        );
        expect(ok, 'the revoke confirm').toBeTruthy();
        ok?.click();
        await flush();

        expect(ui.listText()).toContain('could not read the list');
        expect(ui.pendingRows().map((r) => r.dataset['embedPending'])).toEqual(['http://localhost:5159']);
        expect(ui.adder.hidden).toBe(true);
        expect(pendingEmbedOrigins(ui.store)).toEqual(['http://localhost:5159']);
    });
});

describe('removing a pending entry before Save', () => {
    it('drops it, and the dialog is clean again once nothing is pending', async () => {
        const ui = await buildTab();
        ui.add('localhost', '', 'both');
        expect(ui.pendingRows()).toHaveLength(2);

        ui.pendingRows()[0]?.querySelector('button')?.click();
        expect(pendingEmbedOrigins(ui.store)).toEqual(['https://localhost']);
        expect(ui.store.isDirty()).toBe(true);

        ui.pendingRows()[0]?.querySelector('button')?.click();
        expect(pendingEmbedOrigins(ui.store)).toEqual([]);
        expect(ui.store.isDirty()).toBe(false);
        expect(ui.store.changes()).toEqual([]);
        expect(ui.listText()).toContain('No other origins may embed this app.');
        expect(writes()).toEqual([]);
    });
});

describe('Save, Cancel and discard go through the dialog', () => {
    function deps(over: Partial<SaveDeps> = {}): SaveDeps & { sent: Change[][] } {
        const sent: Change[][] = [];
        return {
            sent,
            confirm: async () => true,
            save: async (changes): Promise<BatchResult> => {
                sent.push(changes);
                return { ok: true, applied: changes.map((c) => c.id) };
            },
            promptDirtyClose: async () => 'cancel',
            navigate: () => undefined,
            ...over,
        };
    }

    it('Save sends the staged origins as one frameAncestorsAdd change', async () => {
        const ui = await buildTab();
        ui.add('localhost', '', 'both');
        const d = deps();

        const action = await performStagedSave(ui.store, d);

        expect(action).toEqual({ kind: 'close' });
        expect(d.sent).toHaveLength(1);
        expect(d.sent[0]?.map((c) => ({ id: c.id, to: c.to }))).toEqual([
            { id: FRAME_ANCESTORS_ADD_ID, to: ['http://localhost', 'https://localhost'] },
        ]);
    });

    it('after a successful Save nothing is pending, the list is re-read, and the field starts clean again', async () => {
        const ui = await buildTab();
        ui.add('localhost', '5159');
        // What the server holds once the batch lands.
        approved = ['http://localhost:5159'];
        const reads = calls.length;

        await performStagedSave(ui.store, deps());
        await flush();

        expect(ui.store.isDirty()).toBe(false);
        expect(ui.pendingRows()).toHaveLength(0);
        expect(calls.length).toBeGreaterThan(reads); // the list was read again
        expect(ui.listText()).toContain('http://localhost:5159');

        // A further add and remove compares against "nothing pending" again,
        // not against what was just saved.
        ui.add('localhost', '6000');
        expect(ui.store.changes()[0]?.from).toEqual([]);
        ui.pendingRows()[0]?.querySelector('button')?.click();
        expect(ui.store.isDirty()).toBe(false);
    });

    it('Cancel on the review sends nothing and keeps the entry pending', async () => {
        const ui = await buildTab();
        ui.add('localhost', '5159');
        const d = deps({ confirm: async () => false });

        expect(await performStagedSave(ui.store, d)).toEqual({ kind: 'stay' });

        expect(d.sent).toEqual([]);
        expect(pendingEmbedOrigins(ui.store)).toEqual(['http://localhost:5159']);
        expect(writes()).toEqual([]);
    });

    it('a refused Save keeps the entry pending', async () => {
        const ui = await buildTab();
        ui.add('localhost', '5159');
        const d = deps({
            save: async () => ({
                ok: false,
                applied: [],
                failed: { id: FRAME_ANCESTORS_ADD_ID, error: 'embed permission is decided on this machine only' },
            }),
        });

        expect(await performStagedSave(ui.store, d)).toEqual({
            kind: 'failed',
            message: "couldn't save Allowed embedders: embed permission is decided on this machine only",
        });
        expect(pendingEmbedOrigins(ui.store)).toEqual(['http://localhost:5159']);
    });

    // 0.5.3 review (M4): the server applies a batch one change at a time and
    // stops at the first refusal, so the origins can land while a later change
    // (the web port, always last) is refused. The tab used to go on listing
    // them as pending, and missing from the allowed list.
    it('a batch that applies the origins and then fails on another change drops them from pending and re-reads the list', async () => {
        const ui = await buildTab();
        ui.store.register({ id: 'webPort', label: 'HTTP port', initial: 8000 });
        ui.store.set('webPort', 80);
        ui.add('localhost', '5159');
        // What the server holds once frameAncestorsAdd has been applied.
        approved = ['http://localhost:5159'];
        const reads = calls.filter((c) => c === 'GET /api/embed-origins').length;
        const d = deps({
            save: async () => ({
                ok: false,
                applied: [FRAME_ANCESTORS_ADD_ID],
                failed: { id: 'webPort', error: 'port 80 is in use' },
            }),
        });

        expect(await performStagedSave(ui.store, d)).toEqual({
            kind: 'failed',
            message: "applied Allowed embedders; couldn't save HTTP port: port 80 is in use",
        });
        await flush();

        expect(ui.pendingRows()).toHaveLength(0);
        expect(pendingEmbedOrigins(ui.store)).toEqual([]);
        expect(calls.filter((c) => c === 'GET /api/embed-origins').length).toBe(reads + 1);
        expect(ui.listText()).toContain('http://localhost:5159');
        expect(ui.listText()).not.toContain('pending');
        // The refused change is still staged, and only it.
        expect(ui.store.changes().map((c) => [c.id, c.to])).toEqual([['webPort', 80]]);
        // A later add starts from "nothing pending" again.
        ui.add('localhost', '6000');
        expect(ui.store.changes().find((c) => c.id === FRAME_ANCESTORS_ADD_ID)?.from).toEqual([]);
    });

    it('a batch that fails before the origins are applied leaves them pending', async () => {
        const ui = await buildTab();
        ui.store.register({ id: 'channel', label: 'Update channel', initial: 'stable' });
        ui.store.set('channel', 'beta');
        ui.add('localhost', '5159');
        const reads = calls.length;
        const d = deps({
            save: async () => ({
                ok: false,
                applied: ['channel'],
                failed: { id: FRAME_ANCESTORS_ADD_ID, error: 'nope' },
            }),
        });

        await performStagedSave(ui.store, d);
        await flush();

        expect(pendingEmbedOrigins(ui.store)).toEqual(['http://localhost:5159']);
        expect(ui.pendingRows()).toHaveLength(1);
        expect(calls.length).toBe(reads);
        // Another applied change is still left staged, as before (only
        // frameAncestorsAdd is committed on a partial apply).
        expect(ui.store.changes().map((c) => c.id)).toEqual([FRAME_ANCESTORS_ADD_ID, 'channel']);
    });

    it('closing with an entry pending asks first, and discard sends nothing', async () => {
        const ui = await buildTab();
        ui.add('localhost', '5159');
        const prompt = vi.fn(async () => 'discard' as const);
        const d = deps({ promptDirtyClose: prompt });

        expect(await performDirtyClose(ui.store, d)).toEqual({ kind: 'close' });

        expect(prompt).toHaveBeenCalledTimes(1);
        expect(d.sent).toEqual([]);
        expect(writes()).toEqual([]);
    });

    it('a dialog with nothing pending closes without asking', async () => {
        const ui = await buildTab();
        const prompt = vi.fn(async () => 'discard' as const);
        expect(await performDirtyClose(ui.store, deps({ promptDirtyClose: prompt }))).toEqual({ kind: 'close' });
        expect(prompt).not.toHaveBeenCalled();
    });
});

describe('formatEmbedAdditions', () => {
    it('renders the summary text', () => {
        expect(formatEmbedAdditions([])).toBe('none added');
        expect(formatEmbedAdditions(['http://a.example', 'https://a.example'])).toBe(
            'add http://a.example, https://a.example',
        );
        expect(formatEmbedAdditions(undefined)).toBe('none added');
    });
});
