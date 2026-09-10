import { Modal } from '../ui/Modal';

/**
 * The red confirmation in front of "allow remote admin without sign-in".
 *
 * Resolves true ONLY for the explicit accept button. Every other exit — the recommended button,
 * Esc, backdrop, the × — resolves false, so a mis-click or a dismissal can never widen the
 * server's exposure. The recommended button takes initial focus for the same reason.
 */
export class RemoteAdminWarningModal extends Modal {
    private resolveFn: ((value: boolean) => void) | null = null;
    private resolved = false;

    public static confirm(): Promise<boolean> {
        return new Promise((resolve) => {
            // See AdminConfirmModal's note: the Modal base constructor already
            // appends the dialog to document.body AND calls showModal(). Doing
            // either again throws InvalidStateError, which rejects this promise
            // and leaves a visible dialog whose buttons silently do nothing.
            // Construct once and do nothing else here.
            new RemoteAdminWarningModal(resolve);
        });
    }

    private constructor(resolve: (value: boolean) => void) {
        super({ title: 'Allow remote admin without sign-in?' });
        this.resolveFn = resolve;
        this.dialog.classList.add('remote-admin-warning-modal');
        // The base constructor calls buildBody() before the subclass fields
        // exist, so the body is filled on the next microtask instead — the same
        // shape AdminConfirmModal uses.
        queueMicrotask(() => this.fillBody(this.bodyEl));
        // Queried rather than stashed from buildFooter(): with ES2022 class
        // fields, a field assigned during super() is overwritten by its own
        // declaration initializer the moment super() returns.
        //
        // By this point the dialog is appended and shown, so this genuinely
        // takes focus. The recommended button, never the risky one: a stray
        // Enter must not be able to open the server up.
        this.dialog.querySelector<HTMLButtonElement>('.remote-admin-warning__recommended')?.focus();
    }

    protected buildBody(_container: HTMLElement): void {
        // Rendered by fillBody() from the constructor via queueMicrotask.
    }

    private fillBody(container: HTMLElement): void {
        const title = document.createElement('strong');
        title.className = 'remote-admin-warning__title';
        title.textContent = '⚠ This makes anyone on your network an administrator.';

        const body = document.createElement('p');
        body.textContent =
            'With no sign-in configured, allowing remote admin means any device that can reach this ' +
            'server can create and delete users, change configuration, and shut the server down. ' +
            'Nothing is protected by a password.';

        const scope = document.createElement('p');
        scope.textContent = 'Only do this on a network you fully control.';

        container.append(title, body, scope);
    }

    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

        // Sign-in first and focused: this card is a funnel toward authEnabled,
        // not a switch that defeats the guard.
        const signIn = document.createElement('button');
        signIn.type = 'button';
        signIn.className = 'modal-button remote-admin-warning__recommended';
        signIn.textContent = 'Set up sign-in instead';
        signIn.addEventListener('click', () => this.resolveAndClose(false));
        footer.appendChild(signIn);

        const accept = document.createElement('button');
        accept.type = 'button';
        accept.className = 'modal-button remote-admin-warning__accept';
        accept.textContent = 'I understand — allow remote admin';
        accept.addEventListener('click', () => this.resolveAndClose(true));
        footer.appendChild(accept);

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
}
