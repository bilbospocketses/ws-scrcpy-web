const TAG = '[ClipboardCopyPrompt]';

/**
 * Puts the device's clipboard on this computer's clipboard, and asks for a click
 * when the browser will not allow that unprompted.
 *
 * The device's text arrives as a WebSocket message, outside any user gesture.
 * Chrome lets a focused page write the clipboard then; Safari and Firefox may
 * refuse, and so does any browser when the stream is embedded in an iframe the
 * host page did not grant `clipboard-write` (permissions policy). In those cases
 * a small prompt over the stream offers the text, and its button does the write
 * inside the click — the gesture those browsers want.
 *
 * Only the newest device clipboard is ever offered: a later one replaces the
 * pending text, and a later one that copied fine hides the prompt, since what
 * it offered is no longer what the device holds.
 */
export class ClipboardCopyPrompt {
    /**
     * The prompt hides itself after this long. Its text is not lost from the
     * device, but nothing here re-reads it: copying it again on the device (or
     * the toolbar's copy button over a selection) sends it again.
     */
    public static readonly AUTO_HIDE_MS = 30_000;

    public readonly element: HTMLElement;
    private pendingText: string | undefined;
    private hideTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * Bumped per delivery and on dispose, so a write that settles late cannot
     * overrule a newer delivery, nor re-arm a prompt whose stream has stopped.
     */
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
            // No async Clipboard API on this page at all: only a click can copy.
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

    /**
     * Stop the auto-hide timer, and disown any write still in flight so it
     * cannot show the prompt again; for when the stream view is torn down.
     */
    public dispose(): void {
        this.generation++;
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
     *
     * The legacy copy command goes first because it is synchronous, so it runs
     * wholly inside this click. That is what rescues an iframe embed whose host
     * did not grant `clipboard-write`: there the async API rejects even from a
     * click, while the copy command still works. Only if the command is
     * unavailable or refuses does the async API get its turn.
     */
    private onCopyClick = (): void => {
        const text = this.pendingText;
        if (text === undefined) return;
        if (copyWithExecCommand(text)) {
            this.hide();
            return;
        }
        if (!navigator.clipboard?.writeText) {
            console.error(TAG, 'this browser offers no way to write the clipboard from this page');
            return;
        }
        const generation = this.generation;
        navigator.clipboard.writeText(text).then(
            () => {
                // Only if no newer delivery arrived while the write ran.
                if (generation === this.generation) this.hide();
            },
            (err: unknown) => {
                console.error(TAG, 'clipboard write failed even from a click:', err);
            },
        );
    };
}

/** The pre-Clipboard-API copy: select a hidden textarea's text and run the copy command. */
function copyWithExecCommand(text: string): boolean {
    if (typeof document.execCommand !== 'function') return false;
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    // Pinned to the viewport's corner, so selecting it never scrolls the page,
    // and transparent, so it is never seen.
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.opacity = '0';
    document.body.appendChild(area);
    try {
        area.select();
        return document.execCommand('copy');
    } catch {
        return false;
    } finally {
        area.remove();
    }
}
