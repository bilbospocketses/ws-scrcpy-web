// @vitest-environment jsdom

/**
 * Settings → Service when an install or uninstall HAPPENED but its hand-off was
 * not seen to finish: the install's take-over timed out, or no fresh instance
 * turned up after an uninstall. Neither is a failure, so the button that would
 * repeat the action must not come back: the message goes on the tab's line and
 * the card is read again, showing the service as it now is (0.5.5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../installHandoffPoll', async (importOriginal) => {
    const real = await importOriginal<typeof import('../../installHandoffPoll')>();
    return {
        ...real,
        // The take-over is never seen: time out at once.
        startInstallHandoffPoll: (opts: { onTimeout: () => void }) => {
            queueMicrotask(() => opts.onTimeout());
            return { stop: () => undefined };
        },
    };
});

import { INSTALL_HANDOFF_TIMEOUT_MESSAGE } from '../../installHandoffPoll';
import { StagedSettingsStore } from '../StagedSettingsStore';
import type { AskChild } from '../tabs/EmbeddingTab';
import { buildServiceTab, refreshService } from '../tabs/ServiceTab';

const jsonResponse = (body: unknown, status = 200): Response =>
    ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as unknown as Response;

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
});

afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function mount(): HTMLElement {
    const section = buildServiceTab(
        {
            role: 'admin',
            authEnabled: false,
            reload: () => undefined,
            // Confirm the "privileges required" dialog.
            askChild: (() => Promise.resolve(true)) as unknown as AskChild,
            openChild: <T>(open: () => T) => open(),
        },
        new StagedSettingsStore(),
    );
    document.body.appendChild(section);
    return section;
}

const buttons = (section: HTMLElement): string[] =>
    [...section.querySelectorAll<HTMLButtonElement>('.settings-card button')].map((b) => b.textContent ?? '');

const line = (section: HTMLElement): HTMLElement =>
    section.querySelector<HTMLElement>(':scope > [data-settings-alert]')!;

async function settle(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

describe('Settings → Service: an action that happened, its hand-off unseen', () => {
    it('an install whose take-over timed out is not offered again: the card is read again', async () => {
        let installed = false;
        vi.stubGlobal(
            'fetch',
            vi.fn((url: string, init?: RequestInit): Promise<Response> => {
                if (url === '/api/service/status') {
                    return Promise.resolve(
                        jsonResponse({
                            supported: true,
                            platform: 'win32',
                            status: installed ? 'running' : 'not-installed',
                        }),
                    );
                }
                if (url === '/api/service/install' && init?.method === 'POST') {
                    installed = true;
                    return Promise.resolve(jsonResponse({ ok: true, status: 'shutting-down', configMtime: 1 }));
                }
                return Promise.resolve(jsonResponse(null, 500));
            }),
        );
        const section = mount();
        await refreshService(section, { onServiceStatus: () => {} });
        expect(buttons(section)).toContain('not installed — install?');

        [...section.querySelectorAll<HTMLButtonElement>('button')]
            .find((b) => b.textContent === 'not installed — install?')!
            .click();
        await settle(40);
        await new Promise((r) => setTimeout(r, 0));
        await settle(40);

        expect(line(section).textContent).toBe(INSTALL_HANDOFF_TIMEOUT_MESSAGE);
        // The card shows the service as it is now, and no install button
        // offers to repeat what already ran.
        expect(buttons(section)).toEqual(['running — uninstall?']);
    });

    it('an uninstall whose fresh instance never turned up is not offered again: the card is read again', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
        let uninstalled = false;
        const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
            if (url === '/api/service/status') {
                return Promise.resolve(
                    jsonResponse({
                        supported: true,
                        platform: 'win32',
                        status: uninstalled ? 'not-installed' : 'running',
                    }),
                );
            }
            if (url === '/api/service/uninstall' && init?.method === 'POST') {
                uninstalled = true;
                return Promise.resolve(
                    jsonResponse({ ok: true, status: 'shutting-down', installMode: 'user-service', configMtime: 5 }),
                );
            }
            // The discovery poll: the relaunch never rewrites config.json.
            if (url === '/api/discover') return Promise.resolve(jsonResponse({ configMtime: 5, webPort: 8000 }));
            return Promise.resolve(jsonResponse(null, 500));
        });
        vi.stubGlobal('fetch', fetchMock);
        const section = mount();
        await refreshService(section, { onServiceStatus: () => {} });
        expect(buttons(section)).toEqual(['running — uninstall?']);

        [...section.querySelectorAll<HTMLButtonElement>('button')]
            .find((b) => b.textContent === 'running — uninstall?')!
            .click();
        // 30 discovery reads, two seconds apart, then it gives up.
        await vi.advanceTimersByTimeAsync(2_000 * 32);
        await settle(40);

        expect(line(section).textContent).toBe('service uninstalled but fresh instance not detected. try reloading.');
        expect(buttons(section)).toEqual(['not installed — install?']);
        expect(fetchMock.mock.calls.filter((c) => c[0] === '/api/service/uninstall')).toHaveLength(1);
    });
});
