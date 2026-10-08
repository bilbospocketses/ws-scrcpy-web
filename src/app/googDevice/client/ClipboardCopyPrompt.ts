const TAG = '[ClipboardCopyPrompt]';

/**
 * Puts the device's clipboard on this computer's clipboard, and asks for a click
 * when the browser will not allow that unprompted.
 *
 * The device's text arrives as a WebSocket message, outside any user gesture.
 * Chrome lets a focused page write the clipboard then; Safari and Firefox may
 * refuse, and on plain HTTP there is no `navigator.clipboard` at all. In those
 * cases a small prompt over the stream offers the text, and its button does the
 * write inside the click — the gesture those browsers want.
 *
 * Only the newest device clipboard is ever offered: a later one replaces the
 * pending text, and a later one that copied fine hides the prompt, since what
 * it offered is no longer what the device holds.
 */
export class ClipboardCopyPrompt {
    /** The prompt hides itself after this long; the device clipboard can be fetched again. */
    public static readonly AUTO_HIDE_MS = 30_000;

    public readonly element: HTMLElement;
    private pendingText: string | undefined;
    private hideTimer: ReturnType<typeof setTimeout> | undefined;
    /** Bumped per delivery, so an older write that settles late cannot overrule a newer one. */
    private generation = 0;

    constructor() {
        const element = document.createElement('div');
        element.className = 'stream-clipboard-prompt';
        element.hidden = true;
        element.setAttribute('role', 'status');

        const label = document.createElement('span');
        label.textContent = 'Device clipboard ready —';

        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'stream-clipboard-prompt-copy';
        copy.textContent = 'click to copy';
        copy.addEventListener('click', this.onCopyClick);

        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'stream-clipboard-prompt-dismiss';
        dismiss.title = 'dismiss';
        dismiss.setAttribute('aria-label', 'dismiss');
        dismiss.textContent = '×';
        dismiss.addEventListener('click', () => this.hide());

        element.append(label, copy, dismiss);
        this.element = element;
    }

    /** The text the prompt is offering, or undefined while it is hidden. */
    public getPendingText(): string | undefined {
        return this.pendingText;
    }

    /** Write the device's clipboard text to the host clipboard, prompting if the browser refuses. */
    public deliver(text: string): void {
        const generation = ++this.generation;
        if (!navigator.clipboard?.writeText) {
            this.offer(text);
            return;
        }
        navigator.clipboard.writeText(text).then(
            () => {
                if (generation === this.generation) this.hide();
            },
            (err: unknown) => {
                console.warn(TAG, 'the browser refused the clipboard write; asking for a click:', err);
                if (generation === this.generation) this.offer(text);
            },
        );
    }

    public hide(): void {
        this.clearTimer();
        this.pendingText = undefined;
        this.element.hidden = true;
    }

    /** Stop the auto-hide timer; for when the stream view is torn down. */
    public dispose(): void {
        this.clearTimer();
    }

    private offer(text: string): void {
        this.pendingText = text;
        this.element.hidden = false;
        this.clearTimer();
        this.hideTimer = setTimeout(() => this.hide(), ClipboardCopyPrompt.AUTO_HIDE_MS);
    }

    private clearTimer(): void {
        if (this.hideTimer !== undefined) {
            clearTimeout(this.hideTimer);
            this.hideTimer = undefined;
        }
    }

    /**
     * Must stay synchronous up to the write: the user gesture is only honoured
     * for work started inside the click handler itself.
     */
    private onCopyClick = (): void => {
        const text = this.pendingText;
        if (text === undefined) return;
        if (navigator.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(
                () => {
                    // Only if nothing newer replaced it while the write ran.
                    if (this.pendingText === text) this.hide();
                },
                (err: unknown) => {
                    console.error(TAG, 'clipboard write failed even from a click:', err);
                },
            );
            return;
        }
        // No async clipboard API (plain HTTP is not a secure context). The
        // legacy copy command still works from a click.
        if (copyWithExecCommand(text)) {
            this.hide();
        } else {
            console.error(TAG, 'this browser offers no way to write the clipboard from this page');
        }
    };
}

function copyWithExecCommand(text: string): boolean {
    if (typeof document.execCommand !== 'function') return false;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        area.remove();
    }
}
