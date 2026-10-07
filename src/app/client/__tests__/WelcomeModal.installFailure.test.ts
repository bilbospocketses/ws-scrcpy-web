// @vitest-environment jsdom

/**
 * The first-run welcome modal's "yes, install service" path opens a
 * ServiceOperationModal — the "installing service" spinner, which Escape, the
 * backdrop and × cannot dismiss. A failed install response and an unreachable
 * server both left it open over the welcome modal's error text, so the user was
 * stuck behind it for good. Settings → Service closes the same dialog on the same
 * outcomes; these tests hold the welcome modal to that.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WelcomeModal } from '../WelcomeModal';

/** Drain pending microtasks without touching the (fake) timer queues. */
const drainMicrotasks = async (rounds = 12): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
        await new Promise<void>((r) => queueMicrotask(r));
    }
};

const jsonResponse = (body: unknown, status = 200): Response =>
    ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as unknown as Response;

/** What the page's own server says before the install: Windows, supported, nothing installed. */
const winNotInstalled = { supported: true, platform: 'win32', status: 'not-installed' };

type InstallAnswer = Response | 'throw';

/** fetch by URL: the status probes get `winNotInstalled`; the install POST gets `install`. */
function stubFetch(install: InstallAnswer): void {
    const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
        if (url === '/api/service/install' && init?.method === 'POST') {
            if (install === 'throw') return Promise.reject(new TypeError('Failed to fetch'));
            return Promise.resolve(install);
        }
        if (url === '/api/service/status') return Promise.resolve(jsonResponse(winNotInstalled));
        return Promise.resolve(jsonResponse(null, 500));
    });
    vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
    document.body.replaceChildren();
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
    vi.stubGlobal('location', { href: 'http://192.168.1.20:8000/', port: '8000', reload: vi.fn() });
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const yesButton = (): HTMLButtonElement | undefined =>
    Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.textContent === 'yes, install service',
    );

/** The "installing service" spinner, if it is still showing. */
const openSpinner = (): Element | null => document.body.querySelector('dialog.service-operation-modal[open]');

/** Build the modal, click "yes, install service", and let the install POST settle. */
async function clickInstall(): Promise<HTMLElement> {
    const modal = new WelcomeModal({ webPort: 8000, portWasAutoShifted: false, onDecision: () => {} });
    await drainMicrotasks();
    const yes = yesButton();
    expect(yes, 'install button not rendered').toBeTruthy();
    yes!.click();
    await drainMicrotasks(20);
    return (modal as unknown as { statusEl: HTMLElement }).statusEl;
}

/** The welcome modal is still up and usable: its buttons are enabled again. */
function expectWelcomeUsable(): void {
    expect(document.body.querySelector('dialog.welcome-modal[open]'), 'welcome modal closed').not.toBeNull();
    expect(yesButton()?.disabled).toBe(false);
}

describe('WelcomeModal install never leaves the "installing service" spinner up', () => {
    it('a failed install ({ok:false}, 500) closes the spinner and shows the error', async () => {
        stubFetch(jsonResponse({ ok: false, error: 'servy exited with code 1', reason: 'servy-failure' }, 500));
        const status = await clickInstall();

        expect(openSpinner(), 'spinner still showing after a failed install').toBeNull();
        expect(status.textContent).toBe('servy exited with code 1');
        expectWelcomeUsable();
    });

    it('a non-ok response with no body closes the spinner and shows the status code', async () => {
        stubFetch(jsonResponse(null, 502));
        const status = await clickInstall();

        expect(openSpinner(), 'spinner still showing after a non-ok install').toBeNull();
        expect(status.textContent).toBe('install failed (502)');
        expectWelcomeUsable();
    });

    it('a declined elevation prompt (403 uac-declined) closes the spinner, as Settings → Service does', async () => {
        stubFetch(jsonResponse({ ok: false, error: 'the UAC prompt was declined', reason: 'uac-declined' }, 403));
        const status = await clickInstall();

        expect(openSpinner(), 'spinner still showing after a declined prompt').toBeNull();
        expect(status.textContent).toBe('the UAC prompt was declined');
        expectWelcomeUsable();
    });

    it('an unreachable server (the install request throws) closes the spinner', async () => {
        stubFetch('throw');
        const status = await clickInstall();

        expect(openSpinner(), 'spinner still showing after the request threw').toBeNull();
        expect(status.textContent).toBe("couldn't reach server. try again?");
        expectWelcomeUsable();
    });

    it('a successful install keeps the spinner up for the hand-off poll', async () => {
        stubFetch(jsonResponse({ ok: true, status: 'shutting-down', configMtime: 100, diskWebPort: 8000 }));
        const status = await clickInstall();

        expect(openSpinner(), 'spinner closed before the service took over').not.toBeNull();
        expect(status.textContent).toBe('service installed. waiting for it to start…');
        expect(yesButton()?.disabled).toBe(true);
    });
});
