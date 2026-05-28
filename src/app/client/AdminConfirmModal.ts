import { Modal } from '../ui/Modal';

export interface AdminConfirmOptions {
    action: 'install service' | 'uninstall service';
    platform?: 'win32' | 'linux';
}

/**
 * Pre-flight modal shown before any action that triggers Windows UAC,
 * so the user can bail out before the OS prompt fires. Resolves to
 * true if the user clicked Continue, false for any cancellation path
 * (Cancel button, Esc, backdrop click, X close button).
 *
 * Static `confirm()` is the only public API — callers don't construct
 * the class directly. The promise resolves exactly once; subsequent
 * close events are ignored.
 */
export class AdminConfirmModal extends Modal {
    private resolveFn: ((value: boolean) => void) | null = null;
    private resolved = false;
    private readonly action: 'install service' | 'uninstall service';

    public static confirm(opts: AdminConfirmOptions): Promise<boolean> {
        return new Promise((resolve) => {
            // The Modal base-class constructor (src/app/ui/Modal.ts) already
            // appends the dialog to document.body AND calls .showModal()
            // during construction. Calling them again here throws
            // InvalidStateError per HTML spec ("dialog already has 'open'
            // attribute"). That throw rejects this Promise — which then
            // silently breaks the Continue/Cancel handlers because
            // resolveAndClose() calls resolve() on an already-rejected
            // Promise (no-op). The dialog from the first showModal is still
            // visible, so the user sees the modal but Continue does nothing.
            //
            // Asymmetry diagnosed via user-report 2026-05-21: only the
            // Settings install/uninstall paths (which use this method) were
            // broken; the Welcome modal's install path bypasses
            // AdminConfirmModal and calls /api/service/install directly, so
            // it always worked. The test stub for showModal didn't throw on
            // double-call, so unit tests stayed green while the real browser
            // throw broke production. Test stub is now spec-realistic.
            new AdminConfirmModal(opts, resolve);
        });
    }

    private readonly platform: 'win32' | 'linux';

    private constructor(opts: AdminConfirmOptions, resolve: (value: boolean) => void) {
        const isLinux = opts.platform === 'linux';
        super({ title: isLinux ? 'Root Privileges Required' : 'Administrative Privileges Required' });
        this.resolveFn = resolve;
        this.action = opts.action;
        this.platform = opts.platform ?? 'win32';
        this.dialog.classList.add('admin-confirm-modal');
        queueMicrotask(() => this.fillBody(this.bodyEl));
    }

    protected buildBody(_container: HTMLElement): void {
        // Body content rendered by fillBody() from the constructor via queueMicrotask.
    }

    private fillBody(container: HTMLElement): void {
        const message = document.createElement('p');
        message.style.cssText = 'margin: 0 0 12px;';
        message.textContent = this.platform === 'linux'
            ? `${this.capitalizedAction()} with system scope needs administrator privileges. polkit will show a password prompt next.`
            : `${this.capitalizedAction()} requires administrative privileges. Windows will show a UAC prompt next.`;
        container.appendChild(message);

        const question = document.createElement('p');
        question.style.cssText = 'margin: 0 0 8px;';
        question.textContent = 'Continue?';
        container.appendChild(question);
    }

    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'settings-btn';
        cancelBtn.textContent = 'cancel';
        cancelBtn.addEventListener('click', () => this.resolveAndClose(false));
        footer.appendChild(cancelBtn);

        const continueBtn = document.createElement('button');
        continueBtn.type = 'button';
        continueBtn.className = 'settings-btn settings-btn-primary';
        continueBtn.textContent = 'continue';
        continueBtn.addEventListener('click', () => this.resolveAndClose(true));
        footer.appendChild(continueBtn);

        return footer;
    }

    protected override onEscapeKey(_event: Event): void {
        this.resolveAndClose(false);
    }

    protected override onBackdropClick(_event: MouseEvent): void {
        this.resolveAndClose(false);
    }

    protected override onCloseButtonClick(): void {
        this.resolveAndClose(false);
    }

    private resolveAndClose(value: boolean): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resolveFn?.(value);
        this.resolveFn = null;
        this.close(value);
    }

    private capitalizedAction(): string {
        return this.action.charAt(0).toUpperCase() + this.action.slice(1);
    }
}
