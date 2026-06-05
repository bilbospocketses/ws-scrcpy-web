import { Modal } from '../ui/Modal';

export interface SystemWideInstallModalOptions {
    /**
     * Called when the user clicks "install for all users". The caller is
     * responsible for initiating the machine-wide install flow.
     */
    onInstall: () => void;
    /**
     * Called when the user clicks "not now". The caller can record the
     * decline so the modal is not shown again this session.
     */
    onDecline: () => void;
}

/**
 * First-run modal offering to install the app machine-wide (system scope,
 * /opt). Shown once per session when the install-gate determines the app
 * is not yet installed system-wide and the user hasn't previously declined.
 *
 * Two actions:
 *   - "install for all users" → calls onInstall, then closes.
 *   - "not now"              → calls onDecline, then closes.
 *
 * Mirrors WelcomeModal: same base class, same DOM-construction helpers,
 * same queueMicrotask body-fill pattern, same lowercase copy convention.
 */
export class SystemWideInstallModal extends Modal {
    private opts!: SystemWideInstallModalOptions;
    private installBtn!: HTMLButtonElement;
    private declineBtn!: HTMLButtonElement;

    constructor(options: SystemWideInstallModalOptions) {
        super({ title: 'install for all users?' });
        this.opts = options;
        this.dialog.classList.add('system-wide-install-modal');
        // Defer body fill past class-field init phase (ES2022 useDefineForClassFields).
        // Same pattern as WelcomeModal / ServiceFirstRunModal.
        queueMicrotask(() => {
            this.fillBody(this.bodyEl);
        });
    }

    protected buildBody(_container: HTMLElement): void {
        // Body content is rendered by fillBody() from the constructor via queueMicrotask.
    }

    private fillBody(container: HTMLElement): void {
        const body = document.createElement('p');
        body.style.cssText = 'margin: 0 0 16px;';
        body.textContent =
            'run ws-scrcpy-web for all users on this machine? installs the app to /opt with one administrator prompt. ' +
            'you can keep using it just for yourself instead.';
        container.appendChild(body);

        const buttons = document.createElement('div');
        buttons.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap;';

        this.installBtn = document.createElement('button');
        this.installBtn.textContent = 'install for all users';
        this.installBtn.className = 'modal-button modal-button-primary';
        this.installBtn.addEventListener('click', () => {
            this.opts.onInstall();
            this.close();
        });
        buttons.appendChild(this.installBtn);

        this.declineBtn = document.createElement('button');
        this.declineBtn.textContent = 'not now';
        this.declineBtn.className = 'modal-button';
        this.declineBtn.addEventListener('click', () => {
            this.opts.onDecline();
            this.close();
        });
        buttons.appendChild(this.declineBtn);

        container.appendChild(buttons);
    }

    /** No-op: Modal base shows the dialog from its constructor. Provided for caller ergonomics. */
    public show(): void {
        if (!this.dialog.open) {
            this.dialog.showModal();
        }
    }
}
