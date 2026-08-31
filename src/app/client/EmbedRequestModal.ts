import { Modal } from '../ui/Modal';

export interface EmbedRequestModalOptions {
    appName: string;
    origin: string;
    /** Milliseconds left before the server expires the request. */
    expiresInMs: number;
    /**
     * Current server-side status of this request, polled while the dialog is open. The asking app
     * can withdraw a request it no longer wants an answer to, and nothing else would tell us:
     * the background poller stops while a prompt is up. Omit to skip watching.
     */
    pollStatus?: () => Promise<string | null>;
}

export type EmbedRequestDecision = 'approved' | 'denied' | 'cancelled' | 'expired';

/**
 * Asks the user whether another local app may embed this one in an iframe.
 *
 * Deliberately not ConfirmModal: this needs a live countdown, and the buttons
 * have to say what they do. The requesting origin is shown verbatim and on its
 * own line, because the one attack this flow cannot rule out is a local process
 * asking for an origin it controls and hoping the user clicks through — so the
 * thing being granted must be the most legible part of the dialog.
 *
 * Only the two buttons produce a decision. It also resolves 'expired' when the countdown runs out
 * and 'cancelled' when the asking app withdraws the request — both match what the server has
 * already recorded by then, and neither sends a decision.
 */
export class EmbedRequestModal extends Modal {
    private resolveFn: ((value: EmbedRequestDecision) => void) | null = null;
    private resolved = false;
    private opts!: EmbedRequestModalOptions;
    private deadline = 0;
    private countdownEl: HTMLElement | null = null;
    private ticker: ReturnType<typeof setInterval> | null = null;
    private watcher: ReturnType<typeof setInterval> | null = null;
    private expired = false;
    private cancelled = false;

    public static ask(options: EmbedRequestModalOptions): Promise<EmbedRequestDecision> {
        return new Promise((resolve) => {
            new EmbedRequestModal(options, resolve);
        });
    }

    private constructor(options: EmbedRequestModalOptions, resolve: (value: EmbedRequestDecision) => void) {
        // A forced choice: no close button, and Escape / backdrop clicks are ignored. Granting
        // another origin permission to frame this app must be an explicit act, and dismissing the
        // dialog by mis-clicking outside it previously reported a denial the user never made.
        // The only exits are the deny and approve buttons, or the request expiring.
        super({ title: 'allow embedding?', dismissible: false });
        this.opts = options;
        this.resolveFn = resolve;
        this.deadline = Date.now() + options.expiresInMs;
        this.dialog.classList.add('confirm-modal');
        // Body is filled after super(), which runs before instance fields exist.
        queueMicrotask(() => this.fillBody(this.bodyEl));
    }

    protected buildBody(_container: HTMLElement): void {
        // See fillBody().
    }

    private fillBody(container: HTMLElement): void {
        const intro = document.createElement('p');
        intro.style.cssText = 'margin: 0 0 8px;';
        intro.textContent = `${this.opts.appName} is asking to display ws-scrcpy-web inside its own page.`;
        container.appendChild(intro);

        const origin = document.createElement('p');
        origin.style.cssText = 'margin: 0 0 8px; font-family: monospace; font-size: 1.05em; word-break: break-all;';
        origin.textContent = this.opts.origin;
        container.appendChild(origin);

        const warning = document.createElement('p');
        warning.style.cssText = 'margin: 0 0 8px;';
        warning.textContent =
            'Approving lets that address show this app in a frame, and saves it to your config. ' +
            'Only approve if you recognise it and started the request yourself.';
        container.appendChild(warning);

        this.countdownEl = document.createElement('p');
        this.countdownEl.style.cssText = 'margin: 0; opacity: 0.75;';
        container.appendChild(this.countdownEl);

        this.renderCountdown();
        this.ticker = setInterval(() => this.renderCountdown(), 1000);

        if (this.opts.pollStatus) {
            this.watcher = setInterval(() => void this.checkStillPending(), 3000);
        }
    }

    private async checkStillPending(): Promise<void> {
        if (this.resolved || this.expired || this.cancelled) return;

        let status: string | null;
        try {
            status = (await this.opts.pollStatus?.()) ?? null;
        } catch {
            return; // a failed read is not an answer — keep the dialog up
        }

        // null means we could not find out (server restarting); only act on a definite withdrawal.
        if (status === 'cancelled') this.showWithdrawn();
    }

    private renderCountdown(): void {
        const remainingMs = this.deadline - Date.now();
        if (remainingMs <= 0) {
            this.showExpired();
            return;
        }
        const totalSeconds = Math.ceil(remainingMs / 1000);
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        if (this.countdownEl) {
            this.countdownEl.textContent = `This request expires in ${minutes}:${String(seconds).padStart(2, '0')}.`;
        }
    }

    protected override buildFooter(): HTMLElement | null {
        const footer = document.createElement('div');
        footer.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

        const denyBtn = document.createElement('button');
        denyBtn.type = 'button';
        denyBtn.className = 'modal-button';
        denyBtn.textContent = 'deny';
        denyBtn.addEventListener('click', () => this.resolveAndClose('denied'));
        footer.appendChild(denyBtn);

        const approveBtn = document.createElement('button');
        approveBtn.type = 'button';
        approveBtn.className = 'modal-button modal-button-primary';
        approveBtn.textContent = 'approve';
        approveBtn.addEventListener('click', () => this.resolveAndClose('approved'));
        footer.appendChild(approveBtn);

        return footer;
    }

    /**
     * The window to answer has closed. The dialog stays up rather than vanishing
     * — the user may have been mid-read — but there is nothing left to grant, so
     * it becomes an acknowledgement with a single close button.
     */
    private showExpired(): void {
        if (this.expired || this.cancelled || this.resolved) return;
        this.expired = true;
        this.becomeAcknowledgement(
            'expired',
            `The five-minute window to approve this request has timed out. ${this.opts.appName} was not granted permission to embed this app.`,
            'Ask again from that app if you still want to allow it.',
        );
    }

    /** The asking app withdrew the request — approving it now would grant nobody anything. */
    private showWithdrawn(): void {
        if (this.expired || this.cancelled || this.resolved) return;
        this.cancelled = true;
        this.becomeAcknowledgement(
            'cancelled',
            `${this.opts.appName} withdrew this request, so there is nothing left to decide. It was not granted permission to embed this app.`,
            'Ask again from that app if you still want to allow it.',
        );
    }

    /**
     * Turn the dialog into a read-and-close notice. Deliberately does not vanish: the user may be
     * mid-read, and a prompt disappearing on its own is indistinguishable from one they dismissed.
     */
    private becomeAcknowledgement(outcome: EmbedRequestDecision, message: string, hintText: string): void {
        this.stopTimers();

        this.bodyEl.textContent = '';
        const messageEl = document.createElement('p');
        messageEl.style.cssText = 'margin: 0 0 8px;';
        messageEl.textContent = message;
        this.bodyEl.appendChild(messageEl);

        const hint = document.createElement('p');
        hint.style.cssText = 'margin: 0; opacity: 0.75;';
        hint.textContent = hintText;
        this.bodyEl.appendChild(hint);

        const footer = this.frameEl.querySelector('.modal-footer');
        if (footer) {
            footer.textContent = '';
            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'modal-button modal-button-primary';
            closeBtn.textContent = 'close';
            closeBtn.addEventListener('click', () => this.resolveAndClose(outcome));
            footer.appendChild(closeBtn);
        }
    }

    private stopTimers(): void {
        if (this.ticker !== null) {
            clearInterval(this.ticker);
            this.ticker = null;
        }
        if (this.watcher !== null) {
            clearInterval(this.watcher);
            this.watcher = null;
        }
    }

    // No onEscapeKey / onBackdropClick / onCloseButtonClick overrides: with dismissible:false the
    // base never invokes them, and a handler here would imply an exit route that does not exist.

    private resolveAndClose(value: EmbedRequestDecision): void {
        if (this.resolved) return;
        this.resolved = true;
        this.stopTimers();
        this.resolveFn?.(value);
        this.resolveFn = null;
        this.close(value);
    }
}
