// @vitest-environment jsdom

/**
 * A Linux system-scope service uninstall from a non-root instance waits on its
 * polkit prompt now, and a cancelled prompt answers 403 `reason: 'uac-declined'`
 * instead of "shutting down". Settings → Service shows the declined line, not a
 * removal in progress.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reasonToUserMessage } from '../../serviceFailureMessage';
import { StagedSettingsStore } from '../StagedSettingsStore';
import type { AskChild } from '../tabs/EmbeddingTab';
import { buildServiceTab, refreshService } from '../tabs/ServiceTab';

const DECLINED = reasonToUserMessage('uac-declined', '');

const jsonResponse = (body: unknown, status = 200): Response =>
    ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }) as unknown as Response;

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
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

describe('Settings → Service: a declined system-scope uninstall prompt', () => {
    it('shows the declined line, not a removal in progress', async () => {
        const fetchMock = vi.fn((url: string, init?: RequestInit): Promise<Response> => {
            if (url === '/api/service/status') {
                return Promise.resolve(
                    jsonResponse({
                        supported: true,
                        platform: 'linux',
                        status: 'running',
                        scope: 'system',
                        installMode: 'system-service',
                    }),
                );
            }
            if (url === '/api/service/uninstall' && init?.method === 'POST') {
                return Promise.resolve(
                    jsonResponse(
                        {
                            ok: false,
                            error: 'uninstall was cancelled or not authorized at the authentication prompt',
                            reason: 'uac-declined',
                        },
                        403,
                    ),
                );
            }
            return Promise.resolve(jsonResponse(null, 500));
        });
        vi.stubGlobal('fetch', fetchMock);

        const section = buildServiceTab(
            {
                role: 'admin',
                authEnabled: false,
                reload: () => undefined,
                // Confirm any "privileges required" dialog.
                askChild: (() => Promise.resolve(true)) as unknown as AskChild,
                openChild: <T>(open: () => T) => open(),
            },
            new StagedSettingsStore(),
        );
        document.body.appendChild(section);
        await refreshService(section, { onServiceStatus: () => {} });

        const uninstall = [...section.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
            /uninstall\?$/.test(b.textContent ?? ''),
        );
        expect(uninstall, 'uninstall button not rendered').toBeTruthy();
        uninstall!.click();
        for (let i = 0; i < 5; i++) await flush();

        expect(fetchMock).toHaveBeenCalledWith('/api/service/uninstall', { method: 'POST' });
        const error = section.querySelector<HTMLElement>('.settings-status-error');
        expect(error?.textContent).toBe(DECLINED);
        expect(error?.hidden).toBe(false);
        expect(section.textContent).not.toContain('removing the system service');
    });
});
