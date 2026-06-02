import { Modal } from '../ui/Modal';

export interface ConfirmModalOptions {
    title: string;
    message: string;
}

/**
 * A small reusable yes/no confirmation dialog. `ConfirmModal.confirm(opts)`
 * resolves `true` when the user confirms and `false` on cancel / Esc /
 * backdrop / the close button. Buttons use the white-outline `modal-button`
 * style (matching the welcome/bookmark/service modals from beta.29).
 *
 * Pattern mirrors ShellCloseConfirmModal; button text is fixed ('cancel'/'ok')
 * because the footer is built during super() before instance fields are set.
 */
export class ConfirmModal extends Modal {
    private resolveFn: ((value: boolean) => void) | null = null;
    private resolved = false;
    private confirmOpts!: ConfirmModalOptions;

    public static confirm(options: ConfirmModalOptions): Promise<boolean> {
        return new Promise((resolve) => {
            new ConfirmModal(options, resolve);
        });
    }

    private constructor(options: ConfirmModalOptions, resolve: (value: boolean) => void) {
        super({ title: options.title });
        this.confirmOpts = options;
        this.resolveFn = resolve;
        this.dialog.classList.add('confirm-modal');
        queueMicrotask(() => this.fillBody(this.bodyEl));
    }

    protected buildBody(_container: HTMLElement): void {
        // Body rendered by fillBody() via queueMicrotask (confirmOpts set after super()).
    }

    private fillBody(container: HTMLElement): void {
        const message = document.createElement('p');
        message.style.cssText = 'margin: 0 0 8px;';
        message.textContent = this.confirmOpts.message;
        container.appendChild(message);
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

        const okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'modal-button modal-button-primary';
        okBtn.textContent = 'ok';
        okBtn.addEventListener('click', () => this.resolveAndClose(true));
        footer.appendChild(okBtn);

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
