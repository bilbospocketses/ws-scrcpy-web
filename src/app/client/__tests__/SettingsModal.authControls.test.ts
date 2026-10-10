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

/** The status line at the bottom of the tab titled `title`, where its actions' results go (0.5.5). */
function tabLine(title: string): HTMLElement | null {
    const section = [...document.querySelectorAll<HTMLElement>('.settings-modal section.settings-section')].find(
        (s) => s.querySelector('h3')?.textContent === title,
    );
    return section?.querySelector<HTMLElement>(':scope > [data-settings-alert]') ?? null;
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

        it('clicking "enable login" when 409 says why on the Users tab line', async () => {
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

            const line = tabLine('Users');
            expect(line?.textContent).not.toBe('');
            expect(line?.textContent).toBe('Add a user with an admin password first (Users → manage users)');
            expect(line?.classList.contains('settings-status-error')).toBe(true);
            // Nothing is said beside the button any more.
            expect(enableBtn!.closest('.settings-item')?.querySelector('.settings-status')).toBeNull();
        });
    });

    describe('change-password blank guard (FIX 2)', () => {
        beforeEach(() => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: true,
                user: { username: 'alice', role: 'user' },
            });
        });

        it('clicking save with blank fields shows validation message and does NOT call changePassword', async () => {
            const changePwSpy = vi.spyOn(authClient, 'changePassword').mockResolvedValue(true);

            new SettingsModal();
            await flush();
            await flush();

            // Open the change-password form
            const cpTrigger = [...document.querySelectorAll('button')].find(
                (b) => b.getAttribute('data-action') === 'change-password',
            );
            expect(cpTrigger).toBeDefined();
            cpTrigger!.click();

            // Leave inputs blank and click save
            const saveBtn = [...document.querySelectorAll('button')].find(
                (b) => b.textContent === 'save' && b.closest('.settings-section'),
            );
            expect(saveBtn).toBeDefined();
            saveBtn!.click();
            await flush();
            await flush();

            expect(changePwSpy).not.toHaveBeenCalled();
            expect(bodyText()).toContain('enter your current and new password');
            // A field's validation: under the form, not on the tab's line.
            expect(tabLine('Server')?.textContent).toBe('');
            const guard = [...document.querySelectorAll<HTMLElement>('.settings-card .settings-status')].find(
                (el) => el.textContent === 'enter your current and new password',
            );
            expect(guard?.hidden).toBe(false);
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
            expect(tabLine('Server')?.textContent).toBe('password changed');
            expect(tabLine('Server')?.textContent).not.toBe('');
        });

        it('on false return from changePassword, says so on the Server tab line', async () => {
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

            const line = tabLine('Server');
            expect(line?.textContent).toBe('current password incorrect');
            expect(line?.textContent).not.toBe('');
            expect(line?.classList.contains('settings-status-error')).toBe(true);
        });
    });

    describe('logout control (FIX 3)', () => {
        it('log out button is present for admin when authEnabled=true', async () => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: true,
                user: { username: 'admin', role: 'admin' },
            });

            new SettingsModal();
            await flush();
            await flush();

            const logoutBtn = [...document.querySelectorAll('button')].find(
                (b) => b.getAttribute('data-action') === 'logout',
            );
            expect(logoutBtn).toBeDefined();
        });

        it('log out button is present for non-admin user when authEnabled=true', async () => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: true,
                user: { username: 'bob', role: 'user' },
            });

            new SettingsModal();
            await flush();
            await flush();

            const logoutBtn = [...document.querySelectorAll('button')].find(
                (b) => b.getAttribute('data-action') === 'logout',
            );
            expect(logoutBtn).toBeDefined();
        });

        it('log out button is ABSENT when authEnabled=false', async () => {
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: false,
                user: { username: 'admin', role: 'admin' },
            });

            new SettingsModal();
            await flush();
            await flush();

            const logoutBtn = [...document.querySelectorAll('button')].find(
                (b) => b.getAttribute('data-action') === 'logout',
            );
            expect(logoutBtn).toBeUndefined();
        });

        it('clicking log out calls authClient.logout() then window.location.reload()', async () => {
            const logoutSpy = vi.spyOn(authClient, 'logout').mockResolvedValue(undefined);
            vi.spyOn(authClient, 'me').mockResolvedValue({
                authEnabled: true,
                user: { username: 'alice', role: 'user' },
            });

            new SettingsModal();
            await flush();
            await flush();

            const logoutBtn = [...document.querySelectorAll('button')].find(
                (b) => b.getAttribute('data-action') === 'logout',
            ) as HTMLButtonElement | undefined;
            expect(logoutBtn).toBeDefined();
            logoutBtn!.click();
            await flush();
            await flush();

            expect(logoutSpy).toHaveBeenCalledOnce();
            expect(window.location.reload).toHaveBeenCalledOnce();
        });
    });
});
