import { Modal } from '../ui/Modal';

export interface SystemWideInstallModalOptions {
    /**
     * Called when the user clicks "yes, all users". The caller is
     * responsible for initiating the machine-wide install flow.
     */
    onInstall: () => void;
    /**
     * Called when the user clicks "no, me only". The caller can record the
     * decline so the modal is not shown again this session.
     */
    onDecline: () => void;
}

/**
 * First-run modal offering to install the app machine-wide (system scope,
 * /opt). Shown once per session when the install-gate determines the app
 * is not yet installed system-wide and the user hasn't previously declined.
 *
 * Forced choice (dismissible: false) — no ×, and Escape / backdrop clicks are
 * ignored; the user must pick one of:
 *   - "yes, all users" → calls onInstall, then closes.
 *   - "no, me only"    → calls onDecline, then closes.
 *
 * Mirrors WelcomeModal: same base class, same DOM-construction helpers,
 * same queueMicrotask body-fill pattern, same lowercase copy convention.
 */
export class SystemWideInstallModal extends Modal {
    private opts!: SystemWideInstallModalOptions;
    private installBtn!: HTMLButtonElement;
    private declineBtn!: HTMLButtonElement;

    constructor(options: SystemWideInstallModalOptions) {
        super({ title: 'install for all users?', dismissible: false });
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
        const question = document.createElement('p');
        question.style.cssText = 'margin: 0 0 12px;';
        question.textContent = 'run ws-scrcpy-web for all users on this machine?';
        container.appendChild(question);

        const yesLine = document.createElement('p');
        yesLine.style.cssText = 'margin: 0 0 12px;';
        yesLine.textContent = 'clicking "yes, all users" installs the app to /opt with one administrator prompt.';
        container.appendChild(yesLine);

        const noLine = document.createElement('p');
        noLine.style.cssText = 'margin: 0 0 16px;';
        noLine.textContent =
            'clicking "no, me only" will leave the application running from wherever you launch it from.';
        container.appendChild(noLine);

        const buttons = document.createElement('div');
        buttons.style.cssText = 'display: flex; gap: 12px; justify-content: flex-end; flex-wrap: wrap;';

        this.installBtn = document.createElement('button');
        this.installBtn.textContent = 'yes, all users';
        this.installBtn.className = 'modal-button modal-button-primary';
        this.installBtn.addEventListener('click', () => {
            this.opts.onInstall();
            this.close();
        });
        buttons.appendChild(this.installBtn);

        this.declineBtn = document.createElement('button');
        this.declineBtn.textContent = 'no, me only';
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
