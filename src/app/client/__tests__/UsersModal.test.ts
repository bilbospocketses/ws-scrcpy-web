// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeResponse, UserRow } from '../AuthClient';
import { authClient } from '../AuthClient';
import { UsersModal } from '../UsersModal';

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ------------------------------------------------------------------
// Test data
// ------------------------------------------------------------------
const adminUser: UserRow = {
    id: 1,
    username: 'admin',
    role: 'admin',
    hasPassword: true,
    disabled: false,
    lockedUntil: null,
    lastLogin: null,
};
const bobUser: UserRow = {
    id: 2,
    username: 'bob',
    role: 'user',
    hasPassword: true,
    disabled: false,
    lockedUntil: null,
    lastLogin: null,
};
const lockedUser: UserRow = {
    id: 3,
    username: 'carol',
    role: 'user',
    hasPassword: true,
    disabled: false,
    lockedUntil: Date.now() + 60_000, // locked for 1 minute
    lastLogin: null,
};
const disabledUser: UserRow = {
    id: 4,
    username: 'dave',
    role: 'user',
    hasPassword: true,
    disabled: true,
    lockedUntil: null,
    lastLogin: null,
};

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function modalBody(): string {
    return document.querySelector('.users-modal .modal-body')?.textContent ?? '';
}
function buttons(): HTMLButtonElement[] {
    return Array.from(document.querySelectorAll('.users-modal button')) as HTMLButtonElement[];
}
function findBtn(text: string): HTMLButtonElement | undefined {
    return buttons().find((b) => b.textContent?.trim().toLowerCase() === text.toLowerCase());
}
function statusEl(): string {
    return (document.querySelector('.users-modal-status') as HTMLElement | null)?.textContent ?? '';
}

// ------------------------------------------------------------------
// Setup / teardown
// ------------------------------------------------------------------
beforeEach(() => {
    HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
    });
    HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
        this.removeAttribute('open');
    });
    // Provide a fetch stub so any un-spied authClient calls don't throw
    vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as unknown as Response)),
    );
});

afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

// ------------------------------------------------------------------
// Helper to mount the modal with mocked API
// ------------------------------------------------------------------
function mountModal(
    meResult: MeResponse = { authEnabled: true, user: adminUser },
    usersList: UserRow[] = [adminUser, bobUser],
): UsersModal {
    vi.spyOn(authClient, 'me').mockResolvedValue(meResult);
    vi.spyOn(authClient, 'listUsers').mockResolvedValue(usersList);
    return new UsersModal();
}

// ------------------------------------------------------------------
// Tests
// ------------------------------------------------------------------
describe('UsersModal — list view', () => {
    it('lists users: body contains usernames and roles', async () => {
        mountModal();
        await flush();
        await flush(); // double flush for async refresh chain
        const body = modalBody();
        expect(body).toContain('admin');
        expect(body).toContain('bob');
        expect(body).toContain('user');
    });

    it('shows "disabled" status for a disabled user', async () => {
        mountModal({ authEnabled: true, user: adminUser }, [adminUser, disabledUser]);
        await flush();
        await flush();
        const body = modalBody();
        expect(body).toContain('dave');
        expect(body).toContain('disabled');
    });

    it('shows "locked" status for a locked user', async () => {
        mountModal({ authEnabled: true, user: adminUser }, [adminUser, lockedUser]);
        await flush();
        await flush();
        const body = modalBody();
        expect(body).toContain('carol');
        expect(body).toContain('locked');
    });
});

describe('UsersModal — disable toggle', () => {
    it('calls patchUser with { disabled: true } when checkbox is checked', async () => {
        const patchSpy = vi.spyOn(authClient, 'patchUser').mockResolvedValue({ ok: true } as Response);
        // Provide listUsers mock for the post-patch refresh too
        vi.spyOn(authClient, 'listUsers').mockResolvedValue([adminUser, bobUser]);
        vi.spyOn(authClient, 'me').mockResolvedValue({ authEnabled: true, user: adminUser });

        new UsersModal();
        await flush();
        await flush();

        // Find the disable checkbox for bob (id=2)
        const checkboxes = Array.from(
            document.querySelectorAll('input[type="checkbox"][data-user-id="2"]'),
        ) as HTMLInputElement[];
        expect(checkboxes.length).toBeGreaterThan(0);
        const cb = checkboxes[0]!;
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));

        await flush();
        await flush();

        expect(patchSpy).toHaveBeenCalledWith(2, { disabled: true });
    });
});

describe('UsersModal — disable toggle failure keeps error visible', () => {
    it('on failed patchUser (409) the error message stays visible and does not throw', async () => {
        vi.spyOn(authClient, 'patchUser').mockResolvedValue({ ok: false, status: 409 } as Response);
        vi.spyOn(authClient, 'listUsers').mockResolvedValue([adminUser, bobUser]);
        vi.spyOn(authClient, 'me').mockResolvedValue({ authEnabled: true, user: adminUser });

        new UsersModal();
        await flush();
        await flush();

        // Find bob's disable checkbox (id=2)
        const cb = document.querySelector('input[type="checkbox"][data-user-id="2"]') as HTMLInputElement | null;
        expect(cb).toBeTruthy();
        cb!.checked = true;
        cb!.dispatchEvent(new Event('change'));

        await flush();
        await flush();

        // Error must still be visible — refresh must NOT have been called (which would clear it)
        const status = statusEl();
        expect(status).toContain('Failed');
        expect(status).toContain('409');
    });
});

describe('UsersModal — unlock button', () => {
    it('shows unlock button for a locked user and calls patchUser({ unlock: true })', async () => {
        const patchSpy = vi.spyOn(authClient, 'patchUser').mockResolvedValue({ ok: true } as Response);
        vi.spyOn(authClient, 'listUsers').mockResolvedValue([adminUser, lockedUser]);
        vi.spyOn(authClient, 'me').mockResolvedValue({ authEnabled: true, user: adminUser });

        new UsersModal();
        await flush();
        await flush();

        const unlockBtn = buttons().find((b) => b.getAttribute('data-action') === 'unlock');
        expect(unlockBtn).toBeTruthy();
        unlockBtn!.click();

        await flush();
        await flush();

        expect(patchSpy).toHaveBeenCalledWith(lockedUser.id, { unlock: true });
    });
});

describe('UsersModal — delete with 409 error', () => {
    it('shows inline error message on 409 and does not throw', async () => {
        vi.spyOn(authClient, 'deleteUser').mockResolvedValue({ ok: false, status: 409 } as Response);
        mountModal({ authEnabled: true, user: adminUser }, [adminUser]);
        await flush();
        await flush();

        const deleteBtn = findBtn('delete');
        expect(deleteBtn).toBeTruthy();
        deleteBtn!.click();

        await flush();
        await flush();

        const status = statusEl();
        expect(status).toContain('409');
        expect(status.length).toBeGreaterThan(0);
    });
});

describe('UsersModal — add user (authEnabled = true)', () => {
    it('shows "Add user" button; clicking it opens form WITHOUT lockdown section', async () => {
        mountModal({ authEnabled: true, user: adminUser }, [adminUser]);
        await flush();
        await flush();

        const addBtn = findBtn('add user');
        expect(addBtn).toBeTruthy();
        addBtn!.click();

        await flush();

        // lockdown section should NOT exist
        const lockSection = document.querySelector('.lockdown-section');
        expect(lockSection).toBeNull();

        // New user section should exist
        const newUserSection = document.querySelector('.new-user-section');
        expect(newUserSection).toBeTruthy();
    });

    it('submit calls createUser with correct args', async () => {
        const createSpy = vi.spyOn(authClient, 'createUser').mockResolvedValue({ ok: true } as Response);
        // listUsers for the post-create refresh
        vi.spyOn(authClient, 'listUsers').mockResolvedValue([adminUser]);
        vi.spyOn(authClient, 'me').mockResolvedValue({ authEnabled: true, user: adminUser });

        new UsersModal();
        await flush();
        await flush();

        const addBtn = findBtn('add user');
        expect(addBtn).toBeTruthy();
        addBtn!.click();
        await flush();

        // Fill in the form
        const inputs = Array.from(
            document.querySelectorAll('.users-modal input[type="text"], .users-modal input[type="password"]'),
        ) as HTMLInputElement[];
        const usernameInput = inputs.find((i) => i.getAttribute('type') === 'text' || i.placeholder === '');
        const passwordInput = inputs.find((i) => i.getAttribute('type') === 'password');

        // More targeted: get the visible text inputs in the new-user section
        const newSection = document.querySelector('.new-user-section');
        expect(newSection).toBeTruthy();
        const textInputs = Array.from(newSection!.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
        const pwInputs = Array.from(newSection!.querySelectorAll('input[type="password"]')) as HTMLInputElement[];

        expect(textInputs.length).toBeGreaterThan(0);
        expect(pwInputs.length).toBeGreaterThan(0);

        textInputs[0]!.value = 'newuser';
        pwInputs[0]!.value = 'secret123';

        const submitBtn = findBtn('add user');
        expect(submitBtn).toBeTruthy();
        submitBtn!.click();

        await flush();
        await flush();

        expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ username: 'newuser', password: 'secret123' }));

        // Keep linter happy
        void usernameInput;
        void passwordInput;
    });
});

describe('UsersModal — me() failure is fail-closed (not fail-open)', () => {
    it('when me() rejects, shows a reload-page error and does NOT render add-user button', async () => {
        vi.spyOn(authClient, 'me').mockRejectedValue(new Error('network error'));
        new UsersModal();
        await flush();
        await flush();

        // Must show the error message in the modal body
        const body = modalBody();
        expect(body).toContain("Couldn't load auth state");

        // Must NOT render the Add user button (that would be fail-open)
        const addBtn = findBtn('add user');
        expect(addBtn).toBeUndefined();

        // Must NOT render the lockdown section (authEnabled must not be assumed false)
        const lockSection = document.querySelector('.lockdown-section');
        expect(lockSection).toBeNull();
    });
});

describe('UsersModal — add user lockdown flow (authEnabled = false)', () => {
    it('shows "Secure the admin account" section when authEnabled is false', async () => {
        mountModal({ authEnabled: false, user: null }, []);
        await flush();
        await flush();

        const addBtn = findBtn('add user');
        expect(addBtn).toBeTruthy();
        addBtn!.click();
        await flush();

        const lockSection = document.querySelector('.lockdown-section');
        expect(lockSection).toBeTruthy();
        // The admin-password field should be present
        const adminPwInput = document.querySelector('[data-field="admin-password"]');
        expect(adminPwInput).toBeTruthy();
    });

    it('submit calls authClient.lockdown with admin creds + new user, then reloads', async () => {
        const lockdownSpy = vi.spyOn(authClient, 'lockdown').mockResolvedValue({ ok: true } as Response);
        const reloadMock = vi.fn();
        vi.stubGlobal('location', { reload: reloadMock });

        mountModal({ authEnabled: false, user: null }, []);
        await flush();
        await flush();

        // Click "Add user"
        const addBtn = findBtn('add user');
        expect(addBtn).toBeTruthy();
        addBtn!.click();
        await flush();

        // Fill admin creds
        const adminUserInput = document.querySelector('[data-field="admin-username"]') as HTMLInputElement;
        const adminPwInput = document.querySelector('[data-field="admin-password"]') as HTMLInputElement;
        expect(adminUserInput).toBeTruthy();
        expect(adminPwInput).toBeTruthy();

        adminUserInput.value = 'admin';
        adminPwInput.value = 'strongpassword';

        // Fill new user
        const newSection = document.querySelector('.new-user-section');
        expect(newSection).toBeTruthy();
        const textInputs = Array.from(newSection!.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
        const pwInputs = Array.from(newSection!.querySelectorAll('input[type="password"]')) as HTMLInputElement[];

        expect(textInputs.length).toBeGreaterThan(0);
        textInputs[0]!.value = 'firstuser';
        pwInputs[0]!.value = 'userpassword';

        // Submit
        const submitBtn = findBtn('secure & add user');
        expect(submitBtn).toBeTruthy();
        submitBtn!.click();

        await flush();
        await flush();

        expect(lockdownSpy).toHaveBeenCalledWith({
            adminUsername: 'admin',
            adminPassword: 'strongpassword',
            username: 'firstuser',
            role: expect.any(String),
            password: 'userpassword',
        });

        expect(reloadMock).toHaveBeenCalledTimes(1);
    });

    it('shows error inline and does NOT reload when lockdown returns non-OK', async () => {
        vi.spyOn(authClient, 'lockdown').mockResolvedValue({ ok: false, status: 400 } as Response);
        const reloadMock = vi.fn();
        vi.stubGlobal('location', { reload: reloadMock });

        mountModal({ authEnabled: false, user: null }, []);
        await flush();
        await flush();

        const addBtn = findBtn('add user');
        addBtn!.click();
        await flush();

        const adminUserInput = document.querySelector('[data-field="admin-username"]') as HTMLInputElement;
        const adminPwInput = document.querySelector('[data-field="admin-password"]') as HTMLInputElement;
        adminUserInput.value = 'admin';
        adminPwInput.value = 'pw';

        const newSection = document.querySelector('.new-user-section');
        const textInputs = Array.from(newSection!.querySelectorAll('input[type="text"]')) as HTMLInputElement[];
        const pwInputs = Array.from(newSection!.querySelectorAll('input[type="password"]')) as HTMLInputElement[];
        textInputs[0]!.value = 'user';
        pwInputs[0]!.value = 'pass';

        const submitBtn = findBtn('secure & add user');
        submitBtn!.click();

        await flush();
        await flush();

        expect(reloadMock).not.toHaveBeenCalled();
        const status = statusEl();
        expect(status).toContain('400');
    });
});
