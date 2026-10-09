// @vitest-environment jsdom

/**
 * Smoke row 14.10 sweep: a declined elevation prompt during the first-run
 * "yes, install service" answers 403 `reason: 'uac-declined'`. The modal showed
 * the server's raw error text; Settings → Service shows the mapped
 * "privileges were declined" line, and so does this modal now. Any other
 * failure still shows the server's error as it did.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WelcomeModal } from '../WelcomeModal';

const drainMicrotasks = async (rounds = 12): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
        await new Promise<void>((r) => queueMicrotask(r));
    }
};

const jsonResponse = (body: unknown, status = 200): Response =>
    ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as unknown as Response;

function stubInstallAnswer(answer: Response): void {
    vi.stubGlobal(
        'fetch',
        vi.fn((url: string, init?: RequestInit): Promise<Response> => {
            if (url === '/api/service/install' && init?.method === 'POST') return Promise.resolve(answer);
            if (url === '/api/service/status') {
                return Promise.resolve(jsonResponse({ supported: true, platform: 'linux', status: 'not-installed' }));
            }
            return Promise.resolve(jsonResponse(null, 500));
        }),
    );
}

beforeEach(() => {
    document.body.replaceChildren();
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
});

afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function clickInstall(): Promise<{ status: HTMLElement; yes: HTMLButtonElement }> {
    const modal = new WelcomeModal({ webPort: 8000, portWasAutoShifted: false, onDecision: () => {} });
    await drainMicrotasks();
    const yes = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
        (b) => b.textContent === 'yes, install service',
    );
    expect(yes, 'install button not rendered').toBeTruthy();
    yes!.click();
    await drainMicrotasks(20);
    return { status: (modal as unknown as { statusEl: HTMLElement }).statusEl, yes: yes! };
}

describe('WelcomeModal install: a declined elevation prompt (smoke 14.10 sweep)', () => {
    it('403 uac-declined shows the same declined line as Settings → Service, not the raw error', async () => {
        stubInstallAnswer(
            jsonResponse(
                {
                    ok: false,
                    error: 'install was canceled or not authorized at the authentication prompt',
                    reason: 'uac-declined',
                },
                403,
            ),
        );
        const { status, yes } = await clickInstall();

        expect(status.textContent).toBe('Administrative privileges were declined. Try again and approve the prompt.');
        expect(yes.disabled).toBe(false);
    });

    it('any other failure still shows the server error as before', async () => {
        stubInstallAnswer(jsonResponse({ ok: false, error: 'systemctl enable failed', reason: 'servy-failure' }, 500));
        const { status } = await clickInstall();

        expect(status.textContent).toBe('systemctl enable failed');
    });
});
