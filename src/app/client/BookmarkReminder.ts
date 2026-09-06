import { sameOriginBase } from '../sameOriginUrl';
import { ConfirmModal } from './ConfirmModal';
import { settingsService } from './SettingsService';

/**
 * The "bookmark this URL" reminder, as a card at the top of the page.
 *
 * Replaces `PortChangeModal` and `ServiceFirstRunModal` (2026-09-06, todo item
 * 113, qa-harness Arc 1b finding 2). Both were `<dialog>`s opened with
 * `showModal()`: every click on the page went to them until they were
 * dismissed, and both came back on every page load until a checkbox had been
 * ticked. That wedged automation and, just as much, a user mid-task. This one is
 * in-flow — it covers nothing and makes nothing inert — and every button
 * persists its choice in one click.
 *
 * Two kinds, one component:
 *   - `bookmark`: the port this browser is on has not been acknowledged
 *     (`bookmarkGate.shouldShowBookmark`).
 *   - `service`: first load of a service instance (`serviceFirstRunSeen` is
 *     false). The same reminder with the "starts with your computer" line;
 *     its dismissals also record `serviceFirstRunSeen`.
 *
 * Three ways out:
 *   - **got it** — this port is acknowledged (`bookmarkDismissedForPort`).
 *   - **never again** — after a confirmation, `bookmarkDismissedGlobally`;
 *     the reminder never returns, even when the port changes.
 *   - **×** — gone for this page view only; it returns on the next load.
 *
 * The URL shown is the address THIS browser reached the app on
 * (`sameOriginBase`), never the serving machine's loopback — a LAN user
 * bookmarks their own address. No PATCH is issued at construction time (bug
 * #35: an eager per-port stamp used to clobber "reset welcome and bookmark
 * prompts").
 */
export type BookmarkReminderKind = 'bookmark' | 'service';

export interface BookmarkReminderOptions {
    webPort: number;
    kind: BookmarkReminderKind;
    /** Notified once the card has left the page, whatever the user chose. */
    onDismissed?: () => void;
}

export class BookmarkReminder {
    readonly element: HTMLElement;
    private readonly opts: BookmarkReminderOptions;
    private settled = false;

    constructor(opts: BookmarkReminderOptions) {
        this.opts = opts;
        this.element = this.build();
    }

    /** Insert at the top of the page. In-flow: nothing underneath is covered or inert. */
    mount(parent: HTMLElement = document.body): void {
        parent.insertBefore(this.element, parent.firstChild);
    }

    private build(): HTMLElement {
        const root = document.createElement('div');
        root.className = 'bookmark-reminder';
        root.setAttribute('role', 'status');
        root.dataset['kind'] = this.opts.kind;

        const inner = document.createElement('div');
        inner.className = 'bookmark-reminder-inner';
        root.appendChild(inner);

        const text = document.createElement('span');
        text.className = 'bookmark-reminder-text';
        const url = sameOriginBase(this.opts.webPort);
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = url;
        if (this.opts.kind === 'service') {
            text.appendChild(
                document.createTextNode(
                    'ws-scrcpy-web is running as a service and starts with your computer. this page lives at ',
                ),
            );
            text.appendChild(link);
            text.appendChild(document.createTextNode(' — bookmark it.'));
        } else {
            text.appendChild(document.createTextNode('this app lives at '));
            text.appendChild(link);
            text.appendChild(
                document.createTextNode(' — bookmark it. if the port ever changes, this reminder comes back.'),
            );
        }
        inner.appendChild(text);

        const actions = document.createElement('div');
        actions.className = 'bookmark-reminder-actions';
        inner.appendChild(actions);

        const gotIt = document.createElement('button');
        gotIt.type = 'button';
        gotIt.className = 'bookmark-reminder-got-it';
        gotIt.textContent = 'got it';
        gotIt.addEventListener('click', () => this.gotIt());
        actions.appendChild(gotIt);

        const never = document.createElement('button');
        never.type = 'button';
        never.className = 'bookmark-reminder-never';
        never.textContent = 'never again';
        never.addEventListener('click', () => void this.neverAgain());
        actions.appendChild(never);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'bookmark-reminder-close';
        close.setAttribute('aria-label', 'dismiss for now');
        close.title = 'dismiss for now';
        close.textContent = '×';
        close.addEventListener('click', () => this.remove());
        actions.appendChild(close);

        return root;
    }

    /** Acknowledge this port. On a service instance, the service notice too. */
    private gotIt(): void {
        if (this.settled) return;
        this.settled = true;
        const patch: Record<string, unknown> = { bookmarkDismissedForPort: this.opts.webPort };
        if (this.opts.kind === 'service') patch['serviceFirstRunSeen'] = true;
        // Fire-and-forget: the card leaves regardless; a network hiccup just
        // means it returns on the next load.
        void settingsService.patchGlobal(patch).catch(() => {});
        this.remove();
    }

    /**
     * The stronger choice, behind a confirmation so a stray click cannot commit
     * it. Cancel leaves the card up with nothing written.
     */
    private async neverAgain(): Promise<void> {
        if (this.settled) return;
        const ok = await ConfirmModal.confirm({
            title: 'dismiss bookmark reminder',
            message: "you won't see this bookmark helper again, even when the port changes.",
        });
        if (!ok || this.settled) return;
        this.settled = true;
        const patch: Record<string, unknown> = { bookmarkDismissedGlobally: true };
        if (this.opts.kind === 'service') patch['serviceFirstRunSeen'] = true;
        void settingsService.patchGlobal(patch).catch(() => {});
        this.remove();
    }

    private remove(): void {
        this.element.remove();
        this.opts.onDismissed?.();
    }
}
