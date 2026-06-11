import { Modal } from '../ui/Modal';

/**
 * Overlay modal shown when the user clicks "reset" in the App section's
 * "reset welcome and bookmark prompts" row. Replaces the former inline
 * settings-confirm-panel so the action is presented in a top-layer dialog,
 * matching the UninstallConfirmModal pattern used by the sibling uninstall
 * action in the same section.
 *
 * `ResetConfirmModal.confirm()` is the only public API.
 * - confirm reset button → resolves true
 * - cancel button → resolves false
 * - Esc / backdrop / close-X → resolves false
 *
 * Reset is non-destructive (it clears the first-run / bookmark flags and
 * reloads the page), so the confirm button uses the primary/accent colour
 * (settings-btn-primary, #5b9aff) — NOT the danger-outline red the uninstall
 * modal uses for its genuinely destructive action.
 */
export class ResetConfirmModal extends Modal {
    private resolveFn: ((value: boolean) => void) | null = null;
    private resolved = false;

    public static confirm(): Promise<boolean> {
        return new Promise((resolve) => {
            new ResetConfirmModal(resolve);
        });
    }

    private constructor(resolve: (value: boolean) => void) {
        super({ title: 'reset prompts' });
        this.resolveFn = resolve;
        this.dialog.classList.add('reset-confirm-modal');
    }

    protected buildBody(container: HTMLElement): void {
        const description = document.createElement('p');
        description.textContent =
            'this resets the welcome modal, service-mode modal, the per-port bookmark ' +
            'reminder, and the global bookmark dismissal. the page will reload so the ' +
            'appropriate modal can re-fire. it does not affect install mode, audio ' +
            'preferences, or scan history.';
        container.appendChild(description);
    }

    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'settings-btn reset-cancel';
        cancelBtn.textContent = 'cancel';
        cancelBtn.addEventListener('click', () => this.resolveAndClose(false));
        footer.appendChild(cancelBtn);

        const confirmBtn = document.createElement('button');
        confirmBtn.type = 'button';
        confirmBtn.className = 'settings-btn settings-btn-primary reset-confirm';
        confirmBtn.textContent = 'confirm reset';
        confirmBtn.addEventListener('click', () => this.resolveAndClose(true));
        footer.appendChild(confirmBtn);

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

    private resolveAndClose(confirmed: boolean): void {
        if (this.resolved) return;
        this.resolved = true;
        this.resolveFn?.(confirmed);
        this.resolveFn = null;
        this.close(confirmed);
    }
}
