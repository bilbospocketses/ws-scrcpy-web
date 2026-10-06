import { Modal } from '../ui/Modal';

export class ShellCloseConfirmModal extends Modal {
    private resolveFn: ((value: boolean) => void) | null = null;
    private resolved = false;
    /** The user's answer: true to close the shell, false to keep it. */
    public readonly result: Promise<boolean>;

    /**
     * Returns the open confirm rather than a bare promise so the ShellModal
     * that asked can `dismiss()` it if that modal closes some other way first.
     */
    public static open(): ShellCloseConfirmModal {
        return new ShellCloseConfirmModal();
    }

    private constructor() {
        super({ title: 'End Shell Session' });
        this.result = new Promise((resolve) => {
            this.resolveFn = resolve;
        });
        this.dialog.classList.add('shell-close-confirm-modal');
        queueMicrotask(() => this.fillBody(this.bodyEl));
    }

    protected buildBody(_container: HTMLElement): void {
        // Body content rendered by fillBody() from the constructor via queueMicrotask.
    }

    private fillBody(container: HTMLElement): void {
        const message = document.createElement('p');
        message.style.cssText = 'margin: 0 0 12px;';
        message.textContent = 'ending the shell session loses any active work in the shell.';
        container.appendChild(message);

        const question = document.createElement('p');
        question.style.cssText = 'margin: 0 0 8px;';
        question.textContent = 'close anyway?';
        container.appendChild(question);
    }

    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'modal-button';
        cancelBtn.textContent = 'cancel';
        cancelBtn.addEventListener('click', () => this.resolveAndClose(false));
        footer.appendChild(cancelBtn);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'modal-button';
        closeBtn.textContent = 'close';
        closeBtn.addEventListener('click', () => this.resolveAndClose(true));
        footer.appendChild(closeBtn);

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

    /**
     * Take the confirm down without an answer from the user, resolving false so
     * nothing acts on it. A no-op once the user has answered.
     */
    public dismiss(): void {
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
