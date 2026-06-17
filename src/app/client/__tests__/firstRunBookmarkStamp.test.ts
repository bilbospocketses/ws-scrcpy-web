// @vitest-environment jsdom

/**
 * Bug #35: "reset welcome and bookmark prompts" left bookmarkDismissedForPort
 * stale. Root cause: WelcomeModal + ServiceFirstRunModal eagerly PATCH
 * bookmarkDismissedForPort=<webPort> in their constructors. The reset sets
 * firstRunComplete=false -> the reload re-shows the modal -> the constructor
 * re-stamps the current port, clobbering the reset's null.
 *
 * The eager stamp is redundant: index.ts already gates modal priority on the
 * same load (welcome/service-first-run shows, port-change early-returns), and
 * the modal's COMPLETION path stamps the port legitimately. So neither modal
 * should issue the bookmark PATCH at construction time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceFirstRunModal } from '../ServiceFirstRunModal';
import { WelcomeModal } from '../WelcomeModal';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
    vi.stubGlobal(
        'fetch',
        vi.fn(() =>
            Promise.resolve({
                ok: true,
                json: () => Promise.resolve({}),
            } as unknown as Response),
        ),
    );
});

afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function bookmarkPortWasStamped(): boolean {
    const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as unknown[][];
    return calls.some((args) => {
        const init = args[1] as RequestInit | undefined;
        const body = typeof init?.body === 'string' ? init.body : '';
        return body.includes('bookmarkDismissedForPort');
    });
}

describe('first-run modals do not eagerly stamp bookmarkDismissedForPort (#35)', () => {
    it('WelcomeModal construction issues no bookmarkDismissedForPort PATCH', async () => {
        new WelcomeModal({ webPort: 8000, portWasAutoShifted: false, onDecision: () => {} });
        await flush();
        expect(bookmarkPortWasStamped()).toBe(false);
    });

    it('ServiceFirstRunModal construction issues no bookmarkDismissedForPort PATCH', async () => {
        new ServiceFirstRunModal({ webPort: 8000 });
        await flush();
        expect(bookmarkPortWasStamped()).toBe(false);
    });
});
