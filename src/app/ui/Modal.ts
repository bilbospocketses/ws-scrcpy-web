import '../../style/modal.css';
import { createThemeToggle } from '../client/ThemeToggle';

export interface ModalOptions {
    title: string;
    onClose?: ((result: unknown) => void) | undefined;
    /**
     * When false, the modal is a forced choice: no close (×) button is
     * rendered, and Escape / backdrop clicks are ignored — the only way to
     * dismiss it is an explicit in-body action. Defaults to true.
     */
    dismissible?: boolean;
}

export abstract class Modal {
    protected readonly dialog: HTMLDialogElement;
    protected readonly frameEl: HTMLElement;
    protected readonly bodyEl: HTMLElement;
    private readonly headerControls: HTMLElement;
    private readonly closeBtn?: HTMLButtonElement;
    private readonly dismissible: boolean;
    private readonly options: ModalOptions;

    constructor(options: ModalOptions) {
        this.options = options;
        this.dismissible = options.dismissible !== false;

        // Create <dialog>
        this.dialog = document.createElement('dialog');
        this.dialog.classList.add('modal');

        // Create .modal-frame (the visible glassmorphism box)
        this.frameEl = document.createElement('div');
        this.frameEl.classList.add('modal-frame');

        // Header
        const header = document.createElement('div');
        header.classList.add('modal-header');

        const title = document.createElement('span');
        title.classList.add('modal-title');
        title.textContent = options.title;
        header.appendChild(title);

        // Header right-side controls: theme toggle + (optional subclass buttons) + close button
        this.headerControls = document.createElement('div');
        this.headerControls.classList.add('modal-header-controls');

        const themeBtn = createThemeToggle();
        themeBtn.classList.add('modal-close'); // reuse close button sizing
        this.headerControls.appendChild(themeBtn);

        // Forced-choice modals (dismissible: false) render no \u00d7 \u2014 the user
        // must pick an in-body action.
        if (this.dismissible) {
            this.closeBtn = document.createElement('button');
            this.closeBtn.classList.add('modal-close');
            this.closeBtn.textContent = '\u00d7';
            this.closeBtn.addEventListener('click', () => this.onCloseButtonClick());
            this.headerControls.appendChild(this.closeBtn);
        }

        header.appendChild(this.headerControls);

        // Body
        this.bodyEl = document.createElement('div');
        this.bodyEl.classList.add('modal-body');
        this.buildBody(this.bodyEl);

        // Assemble frame
        this.frameEl.appendChild(header);
        this.frameEl.appendChild(this.bodyEl);

        // Optional footer
        const footer = this.buildFooter();
        if (footer) {
            footer.classList.add('modal-footer');
            this.frameEl.appendChild(footer);
        }

        this.dialog.appendChild(this.frameEl);

        // Event listeners
        this.dialog.addEventListener('cancel', (e) => {
            e.preventDefault();
            if (this.dismissible) {
                this.onEscapeKey(e);
            }
        });

        this.dialog.addEventListener('click', (e) => {
            if (this.dismissible && e.target === this.dialog) {
                this.onBackdropClick(e as MouseEvent);
            }
        });

        // Show
        document.body.appendChild(this.dialog);
        this.dialog.showModal();
    }

    /** Required. Subclass fills the modal body content. */
    protected abstract buildBody(container: HTMLElement): void;

    /** Optional. Override to return a footer element (modal-footer class is added automatically). */
    protected buildFooter(): HTMLElement | null {
        return null;
    }

    /** Override to handle Escape key. Default: close the modal. */
    protected onEscapeKey(_event: Event): void {
        this.close();
    }

    /** Override to handle backdrop click. Default: close the modal. */
    protected onBackdropClick(_event: MouseEvent): void {
        this.close();
    }

    /** Override to handle X button click. Default: close the modal. */
    protected onCloseButtonClick(): void {
        this.close();
    }

    /** Override for cleanup before DOM removal (dispose terminals, close sockets, etc.). */
    protected onBeforeClose(): void {}

    /** Insert a button into the header controls at the far left, keeping the
     *  theme toggle + close X together on the right for consistent UX across modals. */
    protected addHeaderButton(btn: HTMLElement): void {
        this.headerControls.insertBefore(btn, this.headerControls.firstChild);
    }

    /** Close the modal. Calls onBeforeClose, triggers exit animation, removes from DOM, fires callback. */
    public close(result?: unknown): void {
        this.onBeforeClose();
        this.dialog.close();
        // Remove from DOM after exit transition completes (200ms matches CSS)
        this.dialog.addEventListener('transitionend', () => this.dialog.remove(), { once: true });
        // Fallback: remove after 250ms if transitionend doesn't fire (e.g., reduced motion)
        setTimeout(() => {
            if (this.dialog.parentElement) this.dialog.remove();
        }, 250);
        this.options.onClose?.(result);
    }
}
