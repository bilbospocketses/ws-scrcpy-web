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

function bodyText(): string {
    return (document.querySelector('.settings-modal .modal-body')?.textContent ?? '').toLowerCase();
}

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
                    status: 200,
                    json: () => Promise.resolve({}),
                }) as unknown as Promise<Response>,
        ),
    );
    // Stub window.location.reload so tests don't actually navigate.
    const locationStub = { reload: vi.fn() };
    Object.defineProperty(window, 'location', {
        value: locationStub,
        writable: true,
        configurable: true,
    });
});

afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('SettingsModal auth controls', () => {
    describe('admin + authEnabled=true', () => {
        beforeEach(() => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: true,
                user: { username: 'admin', role: 'admin' },
            });
        });

        it('shows a "manage users" button', async () => {
            new SettingsModal();
            await flush();
            await flush();
            expect(bodyText()).toContain('manage users');
        });

        it('clicking "manage users" opens a UsersModal (.users-modal appears in document)', async () => {
            // Stub listUsers to avoid errors during UsersModal render
            vi.spyOn(authClient, 'listUsers').mockResolvedValue([]);

            new SettingsModal();
            await flush();
            await flush();

            const manageBtn = [...document.querySelectorAll('button')].find(
                (b) => b.textContent?.toLowerCase() === 'manage users',
            );
            expect(manageBtn).toBeDefined();
            manageBtn!.click();
            await flush();
            await flush();

            // UsersModal adds a .users-modal dialog to the document
            expect(document.querySelector('.users-modal')).toBeTruthy();
        });

        it('shows a "disable login" button', async () => {
            new SettingsModal();
            await flush();
            await flush();
            expect(bodyText()).toContain('disable login');
        });

        it('clicking "disable login" calls authClient.disableAuth and reloads', async () => {
            const disableAuthSpy = vi.spyOn(authClient, 'disableAuth').mockResolvedValue(undefined);

            new SettingsModal();
            await flush();
            await flush();

            const disableBtn = [...document.querySelectorAll('button')].find((b) =>
                b.textContent?.toLowerCase().includes('disable login'),
            );
            expect(disableBtn).toBeDefined();
            disableBtn!.click();
            await flush();
            await flush();

            expect(disableAuthSpy).toHaveBeenCalledOnce();
            expect(window.location.reload).toHaveBeenCalledOnce();
        });

        it('shows a change-password control', async () => {
            new SettingsModal();
            await flush();
            await flush();
            expect(bodyText()).toContain('change password');
        });
    });

    describe('non-admin (role=user) + authEnabled=true', () => {
        beforeEach(() => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: true,
                user: { username: 'bob', role: 'user' },
            });
        });

        it('does NOT show "manage users"', async () => {
            new SettingsModal();
            await flush();
            await flush();
            expect(bodyText()).not.toContain('manage users');
        });

        it('does NOT show "disable login"', async () => {
            new SettingsModal();
            await flush();
            await flush();
            expect(bodyText()).not.toContain('disable login');
        });

        it('DOES show change-password (user-level when authEnabled)', async () => {
            new SettingsModal();
            await flush();
            await flush();
            expect(bodyText()).toContain('change password');
        });
    });

    describe('admin + authEnabled=false (open mode)', () => {
        beforeEach(() => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: false,
                user: { username: 'admin', role: 'admin' },
            });
        });

        it('change-password is ABSENT in open mode', async () => {
            new SettingsModal();
            await flush();
            await flush();
            expect(bodyText()).not.toContain('change password');
        });

        it('shows "enable login" button', async () => {
            new SettingsModal();
            await flush();
            await flush();
            expect(bodyText()).toContain('enable login');
        });

        it('clicking "enable login" when ok calls authClient.enableAuth and reloads', async () => {
            const enableAuthSpy = vi
                .spyOn(authClient, 'enableAuth')
                .mockResolvedValue({ ok: true, status: 200 } as Response);

            new SettingsModal();
            await flush();
            await flush();

            const enableBtn = [...document.querySelectorAll('button')].find((b) =>
                b.textContent?.toLowerCase().includes('enable login'),
            );
            expect(enableBtn).toBeDefined();
            enableBtn!.click();
            await flush();
            await flush();

            expect(enableAuthSpy).toHaveBeenCalledOnce();
            expect(window.location.reload).toHaveBeenCalledOnce();
        });

        it('clicking "enable login" when 409 shows inline hint', async () => {
            vi.spyOn(authClient, 'enableAuth').mockResolvedValue({ ok: false, status: 409 } as Response);

            new SettingsModal();
            await flush();
            await flush();

            const enableBtn = [...document.querySelectorAll('button')].find((b) =>
                b.textContent?.toLowerCase().includes('enable login'),
            );
            enableBtn!.click();
            await flush();
            await flush();

            expect(bodyText()).toContain('add a user with an admin password first');
        });
    });

    describe('change-password form interactions', () => {
        beforeEach(() => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: true,
                user: { username: 'alice', role: 'user' },
            });
        });

        it('on save → authClient.changePassword called with current and new password', async () => {
            const changePwSpy = vi.spyOn(authClient, 'changePassword').mockResolvedValue(true);

            new SettingsModal();
            await flush();
            await flush();

            // Click the trigger button to open the form
            const cpTrigger = [...document.querySelectorAll('button')].find(
                (b) => b.getAttribute('data-action') === 'change-password',
            );
            expect(cpTrigger).toBeDefined();
            cpTrigger!.click();

            // Fill in the inputs
            const curInput = document.querySelector<HTMLInputElement>('[data-field="cp-current"]');
            const newInput = document.querySelector<HTMLInputElement>('[data-field="cp-new"]');
            expect(curInput).toBeDefined();
            expect(newInput).toBeDefined();
            curInput!.value = 'cur';
            newInput!.value = 'new';

            // Click save
            const saveBtn = [...document.querySelectorAll('button')].find(
                (b) => b.textContent === 'save' && b.closest('.settings-section'),
            );
            expect(saveBtn).toBeDefined();
            saveBtn!.click();
            await flush();
            await flush();

            expect(changePwSpy).toHaveBeenCalledWith('cur', 'new');
        });

        it('on false return from changePassword, shows error status', async () => {
            vi.spyOn(authClient, 'changePassword').mockResolvedValue(false);

            new SettingsModal();
            await flush();
            await flush();

            const cpTrigger = [...document.querySelectorAll('button')].find(
                (b) => b.getAttribute('data-action') === 'change-password',
            );
            cpTrigger!.click();

            const curInput = document.querySelector<HTMLInputElement>('[data-field="cp-current"]');
            const newInput = document.querySelector<HTMLInputElement>('[data-field="cp-new"]');
            curInput!.value = 'wrong';
            newInput!.value = 'new';

            const saveBtn = [...document.querySelectorAll('button')].find(
                (b) => b.textContent === 'save' && b.closest('.settings-section'),
            );
            saveBtn!.click();
            await flush();
            await flush();

            expect(bodyText()).toContain('current password incorrect');
        });
    });
});
