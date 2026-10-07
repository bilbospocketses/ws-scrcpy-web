// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authClient } from '../../AuthClient';
import { SettingsModal } from '../../SettingsModal';

/**
 * The confirms the Settings TABS raise (reset, uninstall, stop & exit, the TLS
 * and embedding revokes, the service install's admin pre-flight) and the Users
 * dialog belong to the Settings dialog. If it closes while one is up, the
 * confirm goes with it and its action never runs -- no reset, no uninstall, no
 * shutdown, no revoke, no install. Answering normally is unchanged.
 *
 * Driven through a real SettingsModal so what is pinned is the shipped wiring
 * from SettingsModal through the tab context to each confirm.
 */

/** Every request the dialog makes, as "METHOD url". */
let calls: string[] = [];

const ROUTES: Record<string, unknown> = {
    'GET /api/config': {
        config: { webPort: 8000 },
        runtime: { firstRunComplete: true, portWasAutoShifted: false, webPort: 8000, docker: false },
    },
    'GET /api/service/status': { supported: true, status: 'not-installed', platform: 'win32' },
    'GET /api/embed-origins': { origins: ['https://frame.example'] },
    'GET /api/tls/state': { status: 'ready', kind: 'ip', subject: '192.168.86.3' },
    'POST /api/settings/reset': {},
    'PATCH /api/config': {},
    'POST /api/service/uninstall-app': {},
    'POST /api/server/shutdown': {},
    'POST /api/tls/revoke': { ok: true },
    'POST /api/embed-origins/revoke': { origins: [] },
};

let reload: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    document.body.replaceChildren();
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
    vi.spyOn(authClient, 'me').mockResolvedValue({ authEnabled: false, user: { username: 'admin', role: 'admin' } });
    vi.spyOn(authClient, 'listUsers').mockResolvedValue([]);
    calls = [];
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit) => {
            const key = `${init?.method ?? 'GET'} ${url}`;
            calls.push(key);
            if (key in ROUTES) {
                return Promise.resolve(new Response(JSON.stringify(ROUTES[key]), { status: 200 }));
            }
            return new Promise(() => undefined); // anything else stalls
        }),
    );
    reload = vi.fn();
    // As SettingsModal.authControls.test.ts does: the tab context's reload is
    // window.location.reload(), which jsdom cannot perform.
    Object.defineProperty(window, 'location', {
        value: { reload, href: 'http://localhost:8000/', hostname: 'localhost', port: '8000', protocol: 'http:' },
        writable: true,
        configurable: true,
    });
    vi.spyOn(window, 'close').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    document.body.replaceChildren();
});

async function settle(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await vi.advanceTimersByTimeAsync(0);
}

function buttonIn(root: ParentNode | null | undefined, label: string): HTMLButtonElement {
    const btn = [...(root?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        (b) => b.textContent?.trim() === label,
    );
    expect(btn, `button "${label}"`).toBeTruthy();
    return btn as HTMLButtonElement;
}

function settingsSection(heading: string): HTMLElement | null {
    const headings = [...document.querySelectorAll<HTMLElement>('dialog.settings-modal .settings-section-heading')];
    return headings.find((h) => h.textContent === heading)?.closest('section') ?? null;
}

interface Case {
    name: string;
    /** Click whatever opens the confirm. */
    open: () => void;
    /** The confirm's own dialog class. */
    child: string;
    /** Its affirmative button. */
    yes: string;
    /** The request(s) that mean the action ran. */
    action: string[];
}

const CASES: Case[] = [
    {
        name: 'reset all my settings',
        open: () => buttonIn(settingsSection('Server'), 'reset').click(),
        child: 'reset-confirm-modal',
        yes: 'confirm reset',
        action: ['POST /api/settings/reset', 'PATCH /api/config'],
    },
    {
        name: 'uninstall ws-scrcpy-web',
        open: () => buttonIn(settingsSection('Server'), 'uninstall…').click(),
        child: 'uninstall-confirm-modal',
        yes: 'uninstall',
        action: ['POST /api/service/uninstall-app'],
    },
    {
        name: 'stop server & exit',
        open: () => buttonIn(settingsSection('Server'), 'stop server & exit').click(),
        child: 'confirm-modal',
        yes: 'ok',
        action: ['POST /api/server/shutdown'],
    },
    {
        name: 'revoke the local https certificate',
        open: () => document.querySelector<HTMLButtonElement>('dialog.settings-modal [data-tls-revoke]')?.click(),
        child: 'confirm-modal',
        yes: 'ok',
        action: ['POST /api/tls/revoke'],
    },
    {
        name: 'revoke an embedding origin',
        open: () => buttonIn(settingsSection('Embedding'), 'revoke').click(),
        child: 'confirm-modal',
        yes: 'ok',
        action: ['POST /api/embed-origins/revoke'],
    },
    {
        name: 'install the service (admin pre-flight)',
        open: () => buttonIn(settingsSection('Service'), 'not installed — install?').click(),
        child: 'admin-confirm-modal',
        yes: 'continue',
        action: ['POST /api/service/install'],
    },
];

async function openSettings(): Promise<SettingsModal> {
    const modal = new SettingsModal();
    await settle();
    return modal;
}

function childDialog(cls: string): HTMLDialogElement | null {
    return document.querySelector<HTMLDialogElement>(`dialog.${cls}`);
}

function actionCalls(c: Case): string[] {
    return calls.filter((k) => c.action.includes(k));
}

describe.each(CASES)('Settings tab confirm: $name', (c) => {
    it('is dismissed, and its action never runs, when Settings closes while it is open', async () => {
        const modal = await openSettings();
        c.open();
        await settle();
        expect(childDialog(c.child)?.hasAttribute('open'), 'the confirm opened').toBe(true);
        const yes = buttonIn(childDialog(c.child), c.yes);

        modal.close();
        await settle();
        // Whatever is left of the confirm, its "yes" must now do nothing.
        yes.click();
        await settle();
        vi.advanceTimersByTime(250);
        await settle();

        expect(childDialog(c.child), 'the confirm must not outlive Settings').toBeNull();
        expect(actionCalls(c), 'the action of a confirm whose Settings has closed').toEqual([]);
        expect(reload).not.toHaveBeenCalled();
        expect(document.querySelector('dialog.service-operation-modal')).toBeNull();
    });

    it('runs its action when answered yes', async () => {
        await openSettings();
        c.open();
        await settle();

        buttonIn(childDialog(c.child), c.yes).click();
        await settle();

        expect(actionCalls(c).length, `${c.action.join(' + ')} after "${c.yes}"`).toBeGreaterThan(0);
    });

    it('runs nothing and keeps Settings open when cancelled', async () => {
        await openSettings();
        c.open();
        await settle();

        buttonIn(childDialog(c.child), 'cancel').click();
        await settle();
        vi.advanceTimersByTime(250);

        expect(actionCalls(c)).toEqual([]);
        expect(childDialog(c.child)).toBeNull();
        expect(document.querySelector('dialog.settings-modal')?.hasAttribute('open')).toBe(true);
    });
});

describe('Settings tab child: the Users dialog', () => {
    it('closes with Settings', async () => {
        const modal = await openSettings();
        buttonIn(settingsSection('Users'), 'manage users').click();
        await settle();
        expect(childDialog('users-modal')?.hasAttribute('open')).toBe(true);

        modal.close();
        await settle();
        vi.advanceTimersByTime(250);

        expect(childDialog('users-modal'), 'the Users dialog must not outlive Settings').toBeNull();
    });

    it('stays open, over an open Settings, until closed itself', async () => {
        await openSettings();
        buttonIn(settingsSection('Users'), 'manage users').click();
        await settle();

        expect(childDialog('users-modal')?.hasAttribute('open')).toBe(true);
        expect(document.querySelector('dialog.settings-modal')?.hasAttribute('open')).toBe(true);
    });
});
