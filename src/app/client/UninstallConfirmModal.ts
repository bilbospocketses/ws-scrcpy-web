import { Modal } from '../ui/Modal';

export interface UninstallConfirmResult {
    confirmed: boolean;
    keep: boolean;
}

export interface UninstallConfirmOptions {
    /**
     * The server's platform, from /api/service/status. Absent when it is not
     * known yet, which shows no platform-specific text.
     */
    platform?: NodeJS.Platform | undefined;
}

/**
 * Shown on Windows while "keep my settings & logs" is unchecked. Unchecking
 * keep reads as "remove everything", but the uninstaller leaves the Local HTTPS
 * certificate authority in place on purpose (user decision 2026-10-03), so the
 * dialog says so and says how to remove it.
 */
export const WINDOWS_CA_KEPT_NOTE =
    'the local https certificate authority is kept, in %LOCALAPPDATA%\\WsScrcpyWeb-tls, ' +
    'so devices that already trust it keep trusting a reinstall. delete that folder to remove it.';

/**
 * Overlay modal shown when the user clicks "uninstall…" in the App section.
 * Replaces the inline confirm-panel pattern so the destructive action is
 * presented in a top-layer dialog that demands deliberate interaction.
 *
 * `UninstallConfirmModal.confirm()` is the only public API.
 * - cancel button → { confirmed: false, keep: <checkbox> }
 * - uninstall button → { confirmed: true, keep: <checkbox> }
 * - Esc / backdrop / close-X → { confirmed: false, keep: <checkbox> }
 *
 * The "keep my settings & logs" checkbox defaults to CHECKED so the
 * safer option (preserve data) is the default path. On Windows, unchecking it
 * reveals WINDOWS_CA_KEPT_NOTE.
 */
export class UninstallConfirmModal extends Modal {
    private resolveFn: ((value: UninstallConfirmResult) => void) | null = null;
    private resolved = false;
    private keepCheckboxEl!: HTMLInputElement;
    private readonly platform: NodeJS.Platform | undefined;

    public static confirm(options: UninstallConfirmOptions = {}): Promise<UninstallConfirmResult> {
        return new Promise((resolve) => {
            new UninstallConfirmModal(resolve, options);
        });
    }

    private constructor(resolve: (value: UninstallConfirmResult) => void, options: UninstallConfirmOptions) {
        super({ title: 'uninstall ws-scrcpy-web' });
        this.resolveFn = resolve;
        this.platform = options.platform;
        this.dialog.classList.add('uninstall-confirm-modal');
        queueMicrotask(() => this.fillBody(this.bodyEl));
    }

    protected buildBody(_container: HTMLElement): void {
        // Body content rendered by fillBody() via queueMicrotask (fields not yet set).
    }

    private fillBody(container: HTMLElement): void {
        const description = document.createElement('p');
        description.textContent = 'this removes the app, its dependencies, and any installed service.';
        container.appendChild(description);

        const keepLabel = document.createElement('label');
        keepLabel.style.cssText =
            'display: flex; align-items: center; gap: 0.5rem; margin-top: 0.75rem; cursor: pointer;';

        this.keepCheckboxEl = document.createElement('input');
        this.keepCheckboxEl.type = 'checkbox';
        this.keepCheckboxEl.checked = true; // default: keep data

        keepLabel.appendChild(this.keepCheckboxEl);
        keepLabel.appendChild(document.createTextNode('keep my settings & logs'));
        container.appendChild(keepLabel);

        if (this.platform === 'win32') {
            const caNote = document.createElement('p');
            caNote.className = 'uninstall-ca-note';
            caNote.textContent = WINDOWS_CA_KEPT_NOTE;
            caNote.hidden = this.keepCheckboxEl.checked;
            this.keepCheckboxEl.addEventListener('change', () => {
                caNote.hidden = this.keepCheckboxEl.checked;
            });
            container.appendChild(caNote);
        }
    }

    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'settings-btn uninstall-cancel';
        cancelBtn.textContent = 'cancel';
        cancelBtn.addEventListener('click', () => this.resolveAndClose(false));
        footer.appendChild(cancelBtn);

        const uninstallBtn = document.createElement('button');
        uninstallBtn.type = 'button';
        uninstallBtn.className = 'settings-btn settings-btn-danger-outline uninstall-confirm';
        uninstallBtn.textContent = 'uninstall';
        uninstallBtn.addEventListener('click', () => this.resolveAndClose(true));
        footer.appendChild(uninstallBtn);

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
        const keep = this.keepCheckboxEl?.checked ?? true;
        this.resolveFn?.({ confirmed, keep });
        this.resolveFn = null;
        this.close({ confirmed, keep });
    }
}
