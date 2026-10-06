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
    /** The parent whose `openChild` is running; every modal built meanwhile becomes its child. */
    private static openingParent: Modal | null = null;
    /** Child dialogs opened through `openChild` that are still up; closed when this one closes. */
    private readonly openChildren = new Set<Modal>();
    // A field initialiser rather than a constructor line, so a child registers
    // before anything in its constructor runs.
    private parentModal: Modal | null = Modal.openingParent?.adopt(this) ?? null;
    /** Set when close() begins; a child's answer arriving after it is no answer. */
    private closeStarted = false;
    protected readonly dialog: HTMLDialogElement;
    protected readonly frameEl: HTMLElement;
    protected readonly bodyEl: HTMLElement;
    private readonly headerControls: HTMLElement;
    private readonly closeBtn?: HTMLButtonElement;
    private readonly dismissible: boolean;
    private readonly options: ModalOptions;
    // A modal closes once. Set by close(); every later close() is a no-op.
    private closed = false;
    // The pending close scheduled by closeAfter(), cleared by close().
    private closeTimer?: ReturnType<typeof setTimeout> | undefined;

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

    /**
     * Open a child dialog bound to this modal's lifetime: every modal built
     * while `open` runs is closed when this one closes, whichever way that is.
     * `open` is the child's usual opener (`new X(...)`, `X.confirm()`), so the
     * child needs no knowledge of its parent. A child whose answer arrives as a
     * promise must settle it when closed unanswered, so nothing awaits forever.
     */
    protected openChild<T>(open: () => T): T {
        const previous = Modal.openingParent;
        Modal.openingParent = this;
        try {
            return open();
        } finally {
            Modal.openingParent = previous;
            // Opened after this modal began closing: there is nothing to answer for.
            if (this.closeStarted) this.closeChildren();
        }
    }

    /**
     * `openChild` for a child that answers with a promise. Resolves to
     * `unanswered` -- which the caller must treat as doing nothing -- if this
     * modal has begun closing by the time the answer would be acted on,
     * including an answer the user gave just before it closed.
     */
    protected askChild<T>(ask: () => Promise<T>, unanswered: T): Promise<T> {
        return this.openChild(ask).then((answer) => (this.closeStarted ? unanswered : answer));
    }

    private adopt(child: Modal): Modal {
        this.openChildren.add(child);
        return this;
    }

    /** Detach from the parent and close any open children; the first thing close() does. */
    private releaseFamily(): void {
        this.closeStarted = true;
        this.parentModal?.openChildren.delete(this);
        this.parentModal = null;
        this.closeChildren();
    }

    private closeChildren(): void {
        const children = [...this.openChildren];
        this.openChildren.clear();
        for (const child of children) child.close();
    }

    /**
     * Close the modal after `ms` (an error message left up long enough to read).
     * Closing it any other way first cancels the timed close, and on a modal
     * that has already closed this schedules nothing.
     */
    protected closeAfter(ms: number): void {
        if (this.closed) return;
        clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => this.close(), ms);
    }

    /**
     * Close the modal. Calls onBeforeClose, triggers exit animation, removes from DOM, fires callback.
     * Only the first call does anything: a timed close that fires after the user
     * closed the modal, or a stream disconnect that arrives after its own stop,
     * must not run the teardown or the onClose callback a second time.
     */
    public close(result?: unknown): void {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.closeTimer);
        this.closeTimer = undefined;
        this.releaseFamily();
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
