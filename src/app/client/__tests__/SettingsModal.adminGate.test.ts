// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authClient } from '../AuthClient';
import { SettingsModal } from '../SettingsModal';

/**
 * Flush one macrotask tick — enough for the async queueMicrotask (which awaits
 * me() then fills the body) to settle after me() resolves synchronously via
 * mockResolvedValue. Call twice if fetch chains need extra settling.
 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
    // Stub fetch so refresh* calls don't throw — return a benign ok response.
    vi.stubGlobal(
        'fetch',
        vi.fn(
            () =>
                Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({}),
                }) as unknown as Promise<Response>,
        ),
    );
});

afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

function bodyText(): string {
    return (document.querySelector('.settings-modal .modal-body')?.textContent ?? '').toLowerCase();
}

describe('SettingsModal admin gating', () => {
    describe('non-admin user (role=user)', () => {
        it('does NOT show Updates or Service section headings', async () => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: true,
                user: { username: 'bob', role: 'user' },
            });

            new SettingsModal();
            // First flush: resolves me() + fillBody runs.
            await flush();
            // Second flush: lets any refresh* calls (none for user) settle.
            await flush();

            const text = bodyText();
            expect(text).not.toContain('updates');
            expect(text).not.toContain('service');
        });

        it('does NOT show the web port row', async () => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: true,
                user: { username: 'bob', role: 'user' },
            });

            new SettingsModal();
            await flush();
            await flush();

            const text = bodyText();
            expect(text).not.toContain('web port');
        });

        it('does NOT show stop-server or uninstall rows', async () => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: true,
                user: { username: 'bob', role: 'user' },
            });

            new SettingsModal();
            await flush();
            await flush();

            const text = bodyText();
            expect(text).not.toContain('stop the server');
            expect(text).not.toContain('uninstall ws-scrcpy-web');
        });

        it('DOES show the reset all my settings row', async () => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: true,
                user: { username: 'bob', role: 'user' },
            });

            new SettingsModal();
            await flush();
            await flush();

            const text = bodyText();
            expect(text).toContain('reset all my settings');
        });
    });

    describe('admin user (role=admin)', () => {
        it('shows the Updates section heading', async () => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: false,
                user: { username: 'admin', role: 'admin' },
            });

            new SettingsModal();
            await flush();
            await flush();

            const text = bodyText();
            expect(text).toContain('updates');
        });

        it('shows the Service section heading', async () => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: false,
                user: { username: 'admin', role: 'admin' },
            });

            new SettingsModal();
            await flush();
            await flush();

            const text = bodyText();
            expect(text).toContain('service');
        });

        it('shows the web port row', async () => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: false,
                user: { username: 'admin', role: 'admin' },
            });

            new SettingsModal();
            await flush();
            await flush();

            const text = bodyText();
            expect(text).toContain('web port');
        });

        it('shows the reset all my settings row', async () => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: false,
                user: { username: 'admin', role: 'admin' },
            });

            new SettingsModal();
            await flush();
            await flush();

            const text = bodyText();
            expect(text).toContain('reset all my settings');
        });
    });

    describe('fail-open: me() throws', () => {
        it('shows the full admin view when me() rejects', async () => {
            vi.spyOn(authClient, 'me').mockRejectedValue(new Error('network error'));

            new SettingsModal();
            await flush();
            await flush();

            const text = bodyText();
            // Fail-open = full admin view (server still enforces 403)
            expect(text).toContain('updates');
            expect(text).toContain('web port');
            expect(text).toContain('reset all my settings');
        });
    });
});
