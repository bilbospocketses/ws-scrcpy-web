import { Modal } from '../ui/Modal';
import type { Role, UserRow } from './AuthClient';
import { authClient } from './AuthClient';

export class UsersModal extends Modal {
    // NOTE: Do NOT store a ref to the body container in buildBody() — class field
    // initializers (ES2022 useDefineForClassFields) run AFTER super() returns and
    // would null any assignment made inside buildBody(). Use this.bodyEl directly.
    private statusEl: HTMLElement | null = null;

    constructor() {
        super({ title: 'Users' });
        this.dialog.classList.add('users-modal');
        queueMicrotask(() => void this.refresh());
    }

    protected buildBody(_container: HTMLElement): void {
        // Body content is rendered by refresh() via queueMicrotask in the constructor.
    }

    // -----------------------------------------------------------------------
    // Main list view
    // -----------------------------------------------------------------------

    async refresh(): Promise<void> {
        const me = await authClient.me().catch(() => ({ authEnabled: true, user: null }));
        const users = await authClient.listUsers().catch(() => [] as UserRow[]);

        const container = this.bodyEl;
        container.replaceChildren();
        this.statusEl = null;

        // Shared inline status area (used by delete 409, etc.)
        const statusDiv = document.createElement('div');
        statusDiv.className = 'users-modal-status';
        statusDiv.style.cssText = 'color: #e05555; font-size: 13px; margin-bottom: 8px; min-height: 1.4em;';
        this.statusEl = statusDiv;
        container.appendChild(statusDiv);

        const list = document.createElement('ul');
        list.style.cssText = 'list-style: none; margin: 0 0 16px; padding: 0;';

        for (const u of users) {
            const isLocked = u.lockedUntil != null && u.lockedUntil > Date.now();

            const li = document.createElement('li');
            li.style.cssText =
                'margin-bottom: 12px; padding-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.08);';

            // Username + role + status
            const infoRow = document.createElement('div');
            infoRow.style.cssText = 'display: flex; align-items: center; gap: 10px; margin-bottom: 6px;';

            const nameSpan = document.createElement('span');
            nameSpan.textContent = u.username;
            nameSpan.style.fontWeight = 'bold';
            infoRow.appendChild(nameSpan);

            const roleSpan = document.createElement('span');
            roleSpan.textContent = u.role;
            roleSpan.style.cssText = 'font-size: 12px; opacity: 0.7;';
            infoRow.appendChild(roleSpan);

            if (u.disabled) {
                const s = document.createElement('span');
                s.textContent = 'disabled';
                s.style.cssText = 'font-size: 12px; color: #e05555;';
                infoRow.appendChild(s);
            } else if (isLocked) {
                const s = document.createElement('span');
                s.textContent = 'locked';
                s.style.cssText = 'font-size: 12px; color: #e0a455;';
                infoRow.appendChild(s);
            }

            li.appendChild(infoRow);

            // Controls row
            const ctrlRow = document.createElement('div');
            ctrlRow.style.cssText = 'display: flex; align-items: center; gap: 8px; flex-wrap: wrap;';

            // Role select
            const roleSelect = document.createElement('select');
            roleSelect.className = 'modal-select';
            for (const rv of ['user', 'admin'] as Role[]) {
                const opt = document.createElement('option');
                opt.value = rv;
                opt.textContent = rv;
                if (rv === u.role) opt.selected = true;
                roleSelect.appendChild(opt);
            }
            roleSelect.addEventListener('change', () => {
                void (async () => {
                    const res = await authClient.patchUser(u.id, { role: roleSelect.value as Role });
                    if (!res.ok) {
                        this.showStatus(`Failed to change role (HTTP ${res.status})`);
                    }
                    await this.refresh();
                })();
            });
            ctrlRow.appendChild(roleSelect);

            // Disable checkbox
            const disabledLabel = document.createElement('label');
            disabledLabel.style.cssText =
                'display: flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer;';
            const disabledCb = document.createElement('input');
            disabledCb.type = 'checkbox';
            disabledCb.checked = u.disabled;
            disabledCb.setAttribute('data-user-id', String(u.id));
            disabledCb.addEventListener('change', () => {
                void (async () => {
                    const res = await authClient.patchUser(u.id, { disabled: disabledCb.checked });
                    if (!res.ok) {
                        this.showStatus(`Failed to update disabled state (HTTP ${res.status})`);
                    }
                    await this.refresh();
                })();
            });
            disabledLabel.appendChild(disabledCb);
            disabledLabel.appendChild(document.createTextNode('disable'));
            ctrlRow.appendChild(disabledLabel);

            // Unlock button (only if locked)
            if (isLocked) {
                const unlockBtn = document.createElement('button');
                unlockBtn.type = 'button';
                unlockBtn.className = 'modal-button';
                unlockBtn.textContent = 'unlock';
                unlockBtn.setAttribute('data-action', 'unlock');
                unlockBtn.addEventListener('click', () => {
                    void (async () => {
                        const res = await authClient.patchUser(u.id, { unlock: true });
                        if (!res.ok) {
                            this.showStatus(`Failed to unlock (HTTP ${res.status})`);
                        }
                        await this.refresh();
                    })();
                });
                ctrlRow.appendChild(unlockBtn);
            }

            // Reset password button + inline form
            const pwContainer = document.createElement('span');
            const resetBtn = document.createElement('button');
            resetBtn.type = 'button';
            resetBtn.className = 'modal-button';
            resetBtn.textContent = 'reset password';
            resetBtn.addEventListener('click', () => {
                resetBtn.style.display = 'none';
                pwContainer.appendChild(
                    this.buildInlinePasswordReset(u.id, () => {
                        resetBtn.style.display = '';
                        pwContainer.replaceChildren(resetBtn);
                    }),
                );
            });
            pwContainer.appendChild(resetBtn);
            ctrlRow.appendChild(pwContainer);

            // Delete button
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'modal-button';
            deleteBtn.textContent = 'delete';
            deleteBtn.addEventListener('click', () => {
                void (async () => {
                    const res = await authClient.deleteUser(u.id);
                    if (!res.ok) {
                        this.showStatus(
                            `Cannot delete: HTTP ${res.status}${res.status === 409 ? ' (last admin)' : ''}`,
                        );
                        return; // do NOT refresh — keep the inline error visible
                    }
                    await this.refresh();
                })();
            });
            ctrlRow.appendChild(deleteBtn);

            li.appendChild(ctrlRow);
            list.appendChild(li);
        }

        container.appendChild(list);

        // Add user button
        const addBtn = document.createElement('button');
        addBtn.type = 'button';
        addBtn.className = 'modal-button modal-button-primary';
        addBtn.textContent = 'Add user';
        addBtn.addEventListener('click', () => void this.openAddUser(me.authEnabled));
        container.appendChild(addBtn);
    }

    private showStatus(msg: string): void {
        if (this.statusEl) this.statusEl.textContent = msg;
    }

    private buildInlinePasswordReset(userId: number, onCancel: () => void): HTMLElement {
        const wrap = document.createElement('span');
        wrap.style.cssText = 'display: inline-flex; align-items: center; gap: 4px;';

        const pwInput = document.createElement('input');
        pwInput.type = 'password';
        pwInput.placeholder = 'new password';
        pwInput.style.cssText = 'padding: 2px 6px; font-size: 13px;';

        const eyeBtn = document.createElement('button');
        eyeBtn.type = 'button';
        eyeBtn.className = 'modal-button';
        eyeBtn.textContent = '👁';
        eyeBtn.title = 'Show/hide password';
        eyeBtn.addEventListener('click', () => {
            pwInput.type = pwInput.type === 'password' ? 'text' : 'password';
        });

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'modal-button';
        confirmBtn.textContent = 'confirm';
        confirmBtn.addEventListener('click', () => {
            void (async () => {
                const res = await authClient.patchUser(userId, { password: pwInput.value });
                if (!res.ok) {
                    this.showStatus(`Failed to reset password (HTTP ${res.status})`);
                    return;
                }
                onCancel();
            })();
        });

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'modal-button';
        cancelBtn.textContent = 'cancel';
        cancelBtn.addEventListener('click', onCancel);

        wrap.appendChild(pwInput);
        wrap.appendChild(eyeBtn);
        wrap.appendChild(confirmBtn);
        wrap.appendChild(cancelBtn);
        return wrap;
    }

    // -----------------------------------------------------------------------
    // Add user / lockdown flow
    // -----------------------------------------------------------------------

    async openAddUser(authEnabled: boolean): Promise<void> {
        const container = this.bodyEl;
        container.replaceChildren();

        // Shared status
        const statusDiv = document.createElement('div');
        statusDiv.className = 'users-modal-status';
        statusDiv.style.cssText = 'color: #e05555; font-size: 13px; margin-bottom: 8px; min-height: 1.4em;';
        this.statusEl = statusDiv;
        container.appendChild(statusDiv);

        // -----------------------------------------------------------------------
        // LOCKDOWN SECTION — only when authEnabled === false
        // -----------------------------------------------------------------------
        let adminUsernameInput: HTMLInputElement | null = null;
        let adminPasswordInput: HTMLInputElement | null = null;

        if (!authEnabled) {
            const lockSection = document.createElement('div');
            lockSection.className = 'lockdown-section';
            lockSection.style.cssText =
                'background: rgba(224,85,85,0.08); border-left: 3px solid #e05555; ' +
                'padding: 10px 12px; margin-bottom: 16px; border-radius: 4px;';

            const lockHeading = document.createElement('div');
            lockHeading.textContent = 'Secure the admin account';
            lockHeading.style.cssText = 'font-weight: bold; margin-bottom: 8px; color: #e05555;';
            lockSection.appendChild(lockHeading);

            const lockDesc = document.createElement('p');
            lockDesc.textContent =
                'Auth is currently disabled. Set an admin username and password — the app will require login after this.';
            lockDesc.style.cssText = 'margin: 0 0 10px; font-size: 13px; opacity: 0.85;';
            lockSection.appendChild(lockDesc);

            // Admin username
            const adminUserLabel = document.createElement('label');
            adminUserLabel.style.cssText = 'display: block; margin-bottom: 6px; font-size: 13px;';
            adminUserLabel.textContent = 'Admin username';
            lockSection.appendChild(adminUserLabel);

            adminUsernameInput = document.createElement('input');
            adminUsernameInput.type = 'text';
            adminUsernameInput.value = 'admin';
            adminUsernameInput.required = true;
            adminUsernameInput.style.cssText =
                'display: block; width: 100%; margin-bottom: 10px; padding: 4px 8px; box-sizing: border-box;';
            adminUsernameInput.setAttribute('data-field', 'admin-username');
            lockSection.appendChild(adminUsernameInput);

            // Admin password + eye toggle
            const adminPwLabel = document.createElement('label');
            adminPwLabel.style.cssText = 'display: block; margin-bottom: 4px; font-size: 13px;';
            adminPwLabel.textContent = 'Admin password';
            lockSection.appendChild(adminPwLabel);

            const adminPwRow = document.createElement('div');
            adminPwRow.style.cssText = 'display: flex; gap: 4px; margin-bottom: 10px;';

            adminPasswordInput = document.createElement('input');
            adminPasswordInput.type = 'password';
            adminPasswordInput.required = true;
            adminPasswordInput.style.cssText = 'flex: 1; padding: 4px 8px;';
            adminPasswordInput.setAttribute('data-field', 'admin-password');

            const adminEyeBtn = document.createElement('button');
            adminEyeBtn.type = 'button';
            adminEyeBtn.className = 'modal-button';
            adminEyeBtn.textContent = '👁';
            adminEyeBtn.title = 'Show/hide admin password';
            adminEyeBtn.addEventListener('click', () => {
                adminPasswordInput!.type = adminPasswordInput!.type === 'password' ? 'text' : 'password';
            });

            adminPwRow.appendChild(adminPasswordInput);
            adminPwRow.appendChild(adminEyeBtn);
            lockSection.appendChild(adminPwRow);

            container.appendChild(lockSection);
        }

        // -----------------------------------------------------------------------
        // NEW USER FIELDS
        // -----------------------------------------------------------------------
        const newUserSection = document.createElement('div');
        newUserSection.className = 'new-user-section';

        const newUserHeading = document.createElement('div');
        newUserHeading.textContent = 'New user';
        newUserHeading.style.cssText = 'font-weight: bold; margin-bottom: 8px;';
        newUserSection.appendChild(newUserHeading);

        // Username
        const userLabel = document.createElement('label');
        userLabel.style.cssText = 'display: block; margin-bottom: 4px; font-size: 13px;';
        userLabel.textContent = 'Username';
        newUserSection.appendChild(userLabel);

        const usernameInput = document.createElement('input');
        usernameInput.type = 'text';
        usernameInput.required = true;
        usernameInput.style.cssText =
            'display: block; width: 100%; margin-bottom: 10px; padding: 4px 8px; box-sizing: border-box;';
        newUserSection.appendChild(usernameInput);

        // Role select
        const roleLabel = document.createElement('label');
        roleLabel.style.cssText = 'display: block; margin-bottom: 4px; font-size: 13px;';
        roleLabel.textContent = 'Role';
        newUserSection.appendChild(roleLabel);

        const roleSelect = document.createElement('select');
        roleSelect.className = 'modal-select';
        roleSelect.style.cssText = 'display: block; margin-bottom: 10px;';
        for (const rv of ['user', 'admin'] as Role[]) {
            const opt = document.createElement('option');
            opt.value = rv;
            opt.textContent = rv;
            roleSelect.appendChild(opt);
        }
        newUserSection.appendChild(roleSelect);

        // Password + eye toggle
        const pwLabel = document.createElement('label');
        pwLabel.style.cssText = 'display: block; margin-bottom: 4px; font-size: 13px;';
        pwLabel.textContent = 'Password';
        newUserSection.appendChild(pwLabel);

        const pwRow = document.createElement('div');
        pwRow.style.cssText = 'display: flex; gap: 4px; margin-bottom: 16px;';

        const passwordInput = document.createElement('input');
        passwordInput.type = 'password';
        passwordInput.required = true;
        passwordInput.style.cssText = 'flex: 1; padding: 4px 8px;';

        const eyeBtn = document.createElement('button');
        eyeBtn.type = 'button';
        eyeBtn.className = 'modal-button';
        eyeBtn.textContent = '👁';
        eyeBtn.title = 'Show/hide password';
        eyeBtn.addEventListener('click', () => {
            passwordInput.type = passwordInput.type === 'password' ? 'text' : 'password';
        });

        pwRow.appendChild(passwordInput);
        pwRow.appendChild(eyeBtn);
        newUserSection.appendChild(pwRow);

        container.appendChild(newUserSection);

        // -----------------------------------------------------------------------
        // Action buttons
        // -----------------------------------------------------------------------
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; gap: 8px;';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'modal-button';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', () => void this.refresh());
        btnRow.appendChild(cancelBtn);

        const submitLabel = authEnabled ? 'Add user' : 'Secure & add user';
        const submitBtn = document.createElement('button');
        submitBtn.type = 'button';
        submitBtn.className = 'modal-button modal-button-primary';
        submitBtn.textContent = submitLabel;
        submitBtn.addEventListener('click', () => {
            void (async () => {
                statusDiv.textContent = '';

                const username = usernameInput.value.trim();
                const role = roleSelect.value as Role;
                const password = passwordInput.value;

                if (!username || !password) {
                    statusDiv.textContent = 'Username and password are required.';
                    return;
                }

                if (!authEnabled) {
                    // Lockdown flow
                    const adminUsername = adminUsernameInput?.value.trim() ?? 'admin';
                    const adminPassword = adminPasswordInput?.value ?? '';

                    if (!adminUsername || !adminPassword) {
                        statusDiv.textContent = 'Admin username and password are required to secure the account.';
                        return;
                    }

                    const res = await authClient.lockdown({ adminUsername, adminPassword, username, role, password });
                    if (!res.ok) {
                        statusDiv.textContent = `Lockdown failed: HTTP ${res.status}`;
                        return;
                    }

                    // App is now locked — show message and reload
                    container.replaceChildren();
                    const msg = document.createElement('p');
                    msg.textContent = 'Login is now required. Reloading…';
                    msg.style.cssText = 'text-align: center; padding: 24px;';
                    container.appendChild(msg);
                    window.location.reload();
                } else {
                    // Normal create-user flow
                    const res = await authClient.createUser({ username, role, password });
                    if (!res.ok) {
                        statusDiv.textContent = `Failed to add user: HTTP ${res.status}`;
                        return;
                    }
                    await this.refresh();
                }
            })();
        });
        btnRow.appendChild(submitBtn);

        container.appendChild(btnRow);
    }
}
