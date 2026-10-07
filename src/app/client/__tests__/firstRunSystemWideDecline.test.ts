// @vitest-environment jsdom

/**
 * First-run "install for all users": the user said yes, then cancelled the
 * polkit prompt (403 `reason: 'uac-declined'`). The page went on to the
 * welcome screen with no word about why nothing was installed. It still goes
 * on to the welcome screen (user ruling), and the welcome screen now says the
 * privileges were declined, in the wording every other declined prompt uses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSystemWideInstall } from '../SystemWideInstallModal';
import { reasonToUserMessage } from '../serviceFailureMessage';
import { WelcomeModal } from '../WelcomeModal';

const DECLINED = reasonToUserMessage('uac-declined', '');

const drainMicrotasks = async (rounds = 12): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
        await Promise.resolve();
        await new Promise<void>((r) => queueMicrotask(r));
    }
};

const jsonResponse = (body: unknown, status = 200): Response =>
    ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as unknown as Response;

/** jsdom matches textContent on hidden elements, so check the element is actually displayed. */
function isDisplayed(el: HTMLElement): boolean {
    if (!el.isConnected) return false;
    for (let node: HTMLElement | null = el; node; node = node.parentElement) {
        if (node.hidden || node.style.display === 'none') return false;
        if (node instanceof HTMLDialogElement && !node.hasAttribute('open')) return false;
    }
    return true;
}

beforeEach(() => {
    document.body.replaceChildren();
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
    // The welcome modal's platform probe; nothing here depends on its answer.
    vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(jsonResponse(null, 500))),
    );
});

afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

async function openWelcome(notice?: string): Promise<HTMLElement> {
    const modal = new WelcomeModal({
        webPort: 8000,
        portWasAutoShifted: false,
        onDecision: () => {},
        ...(notice !== undefined ? { notice } : {}),
    });
    await drainMicrotasks();
    return (modal as unknown as { statusEl: HTMLElement }).statusEl;
}

describe('runSystemWideInstall: what the first-run flow does after "yes, all users"', () => {
    it('a declined prompt continues to the welcome screen with the declined line', async () => {
        const post = vi.fn(() =>
            Promise.resolve(
                jsonResponse(
                    {
                        ok: false,
                        error: 'authentication was dismissed or not authorized. install-system-wide cancelled.',
                        reason: 'uac-declined',
                    },
                    403,
                ),
            ),
        );
        expect(await runSystemWideInstall(post)).toEqual({ kind: 'continue', notice: DECLINED });
        expect(post).toHaveBeenCalledWith('/api/service/install-system-wide', { method: 'POST' });
    });

    it('a successful install reloads', async () => {
        const post = vi.fn(() => Promise.resolve(jsonResponse({ ok: true, status: 'shutting-down' })));
        expect(await runSystemWideInstall(post)).toEqual({ kind: 'reload' });
    });

    it('any other failure continues to the welcome screen with no line, as before', async () => {
        const post = vi.fn(() =>
            Promise.resolve(
                jsonResponse({ ok: false, error: 'pkexec install-system-wide failed: x', reason: 'unknown' }, 500),
            ),
        );
        expect(await runSystemWideInstall(post)).toEqual({ kind: 'continue' });
    });

    it('an unreachable server continues to the welcome screen with no line, as before', async () => {
        const post = vi.fn(() => Promise.reject(new Error('network down')));
        expect(await runSystemWideInstall(post)).toEqual({ kind: 'continue' });
    });
});

describe('WelcomeModal notice', () => {
    it('shows the declined line, visibly, when the machine-wide install prompt was declined', async () => {
        const outcome = await runSystemWideInstall(() =>
            Promise.resolve(jsonResponse({ ok: false, error: 'cancelled', reason: 'uac-declined' }, 403)),
        );
        const status = await openWelcome(outcome.kind === 'continue' ? outcome.notice : undefined);

        expect(status.textContent).toBe(DECLINED);
        expect(status.hidden).toBe(false);
        expect(isDisplayed(status)).toBe(true);
    });

    it('a normal continue shows no line', async () => {
        const status = await openWelcome();

        expect(status.textContent).toBe('');
    });
});
