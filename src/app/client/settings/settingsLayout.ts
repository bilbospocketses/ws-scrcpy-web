/**
 * The shared DOM shape of a Settings tab (0.5.5): every tab but Dependencies is
 * built from these helpers, so every tab has the Dependencies tab's look.
 *
 *   <section class="settings-section">
 *     <h3 class="settings-section-heading">Server</h3>   <-- the tab title
 *     <h4 class="settings-card-heading">Ports</h4>       <-- split tabs only
 *     <div class="settings-card">                        <-- the boxed card
 *       <div class="settings-item">                      <-- the two-column grid
 *         <div class="settings-row">                     <-- display: contents
 *           <span class="settings-label">…               <-- grid-column: labels
 *           <div  class="settings-control">…             <-- grid-column: controls
 *         </div>
 *         <p class="settings-status">…                   <-- notes span both columns
 *       </div>
 *       <div class="settings-item">…</div>               <-- a line above it (modal.css)
 *     </div>
 *   </section>
 *
 * An ITEM is one setting and the notes under it, and it is the unit the
 * dividing lines run between, so a line never separates a control from its own
 * note. Every item is its own grid with the same fixed labels column, which is
 * what keeps the controls lined up across items, cards and tabs.
 *
 * The grouping is made here, when a tab builds its DOM, rather than inferred
 * afterwards from which elements happen to sit next to each other: the tabs
 * show, hide and replace rows and notes long after they are built, and only
 * the code that builds an item knows which notes belong to it.
 *
 * Until 0.5.5 each of the six tab modules carried its own private copy of
 * `buildSection` and `buildRow` (and two of them `buildDynamicLabelRow`); the
 * copies were identical, and a layout change would have had to be made six
 * times over. Dependencies is the one tab that does not use this module: it
 * wraps the home page's dependency panel, which brings its own card.
 */

import { ADMIN_ONLY_NOTE, ADMIN_UNREACHABLE_NOTE, type AdminRefusal } from '../adminGate';

/** A single-card tab: its title, and the one card its items go into. */
export interface SettingsSection {
    section: HTMLElement;
    heading: HTMLHeadingElement;
    card: HTMLElement;
}

function buildSectionShell(title: string): { section: HTMLElement; heading: HTMLHeadingElement } {
    const section = document.createElement('section');
    section.className = 'settings-section';
    const heading = document.createElement('h3');
    heading.className = 'settings-section-heading';
    heading.textContent = title;
    section.appendChild(heading);
    return { section, heading };
}

function buildCardElement(): HTMLElement {
    const card = document.createElement('div');
    card.className = 'settings-card';
    return card;
}

/**
 * A tab with ONE card under its title (Users, Embedding, Updates, Service, and
 * every placeholder and container note). The items go into `card`.
 */
export function buildSection(title: string): SettingsSection {
    const { section, heading } = buildSectionShell(title);
    const card = buildCardElement();
    section.appendChild(card);
    return { section, heading, card };
}

/**
 * A tab split into several cards, each under its own heading (Server, Local
 * HTTPS); `addCard` adds them.
 *
 * The tab title stays in the DOM, visually hidden: the tab strip already names
 * the tab, and the cards' headings take the title's place on screen. Hidden
 * from the eye only, not with `hidden`, so a screen reader still meets the tab
 * title as the heading above the cards' own, and everything that finds a tab by
 * its title (the e2e suite's `settingsSection`) still does.
 */
export function buildSplitSection(title: string): { section: HTMLElement; heading: HTMLHeadingElement } {
    const shell = buildSectionShell(title);
    shell.heading.classList.add('visually-hidden');
    return shell;
}

/** Each card's heading, so `setCardShown` can hide the two together. */
const cardHeadings = new WeakMap<HTMLElement, HTMLElement>();

/**
 * Append a card under its own heading to a split tab's section, and return the
 * card. The heading is the next level down from the (hidden) tab title, and is
 * drawn at the title's size (modal.css `.settings-card-heading`).
 *
 * Above the tab's status line when it already has one (`buildTabAlert`), so
 * the line stays the last thing in the tab whichever is built first.
 */
export function addCard(section: HTMLElement, headingText: string): HTMLElement {
    const heading = document.createElement('h4');
    heading.className = 'settings-card-heading';
    heading.textContent = headingText;
    const card = buildCardElement();
    cardHeadings.set(card, heading);
    const line = section.querySelector(':scope > [data-settings-alert]');
    section.insertBefore(heading, line);
    section.insertBefore(card, line);
    return card;
}

/**
 * `addCard` with no heading (0.5.8): a card that stands in for the cards around
 * it rather than naming a group of its own -- the Server tab's note where the
 * admin API will not answer this page, in place of its Ports and Application
 * cards. Above the tab's status line in the same way. With no heading to set
 * it off, modal.css's `.settings-card + .settings-card` gives it the space a
 * heading's top margin would.
 */
export function addUntitledCard(section: HTMLElement): HTMLElement {
    const card = buildCardElement();
    section.insertBefore(card, section.querySelector(':scope > [data-settings-alert]'));
    return card;
}

/**
 * Show or hide a split tab's card together with its heading. A card whose
 * every item is hidden would otherwise still draw an empty box under a heading
 * (the Server tab's Ports card before the dialog knows it is on a host, and in
 * a container).
 */
export function setCardShown(card: HTMLElement, shown: boolean): void {
    card.hidden = !shown;
    const heading = cardHeadings.get(card);
    if (heading) heading.hidden = !shown;
}

/**
 * One setting and the notes under it: the unit a card draws its dividing lines
 * between. An item whose children are all hidden takes no space and draws no
 * line (modal.css), so a row that is hidden for now does not leave a gap.
 */
export function buildItem(...children: HTMLElement[]): HTMLElement {
    const item = document.createElement('div');
    item.className = 'settings-item';
    item.append(...children);
    return item;
}

/**
 * A single grid row: the description label on the left, the control(s) on the
 * right. With no control (`null`) the label spans both columns, as a note does:
 * the Embedding tab's "No other origins may embed this app." and "loading…"
 * are lines of text, not settings, and an empty controls cell would squeeze
 * them into the labels column.
 */
export function buildRow(labelText: string, control: HTMLElement | DocumentFragment | null): HTMLElement {
    return buildDynamicLabelRow(labelText, control).row;
}

/**
 * `buildRow`, with the LABEL returned alongside the row, so the caller can keep
 * changing the text on the left while the control on the right stays put: the
 * Updates and Service tabs' error + retry rows, and the Updates action row
 * whose label IS the live update-status line.
 */
export function buildDynamicLabelRow(
    labelText: string,
    control: HTMLElement | DocumentFragment | null,
): { row: HTMLElement; labelEl: HTMLSpanElement } {
    const row = document.createElement('div');
    row.className = 'settings-row';

    const labelEl = document.createElement('span');
    labelEl.className = 'settings-label';
    labelEl.textContent = labelText;
    row.appendChild(labelEl);

    if (control === null) {
        labelEl.classList.add('settings-label-wide');
        return { row, labelEl };
    }

    const controlWrap = document.createElement('div');
    controlWrap.className = 'settings-control';
    controlWrap.appendChild(control);
    row.appendChild(controlWrap);

    return { row, labelEl };
}

/**
 * Show or hide a row. Both the inline `display` and the `hidden` attribute:
 * `.settings-row`'s `display: contents` outranks the UA's `[hidden]` rule, so
 * `hidden` alone would leave the row on screen, while the attribute is what
 * modal.css reads to tell an item with nothing showing.
 */
export function setRowShown(row: HTMLElement, shown: boolean): void {
    row.hidden = !shown;
    row.style.display = shown ? '' : 'none';
}

/**
 * How long a tab's line shows a result. A success is read at a glance; an
 * error may need reading and acting on, so it stays twice as long.
 */
export const TAB_ALERT_SUCCESS_MS = 5_000;
export const TAB_ALERT_ERROR_MS = 10_000;

/**
 * `success` and `error` hide themselves after their time; `busy` (saving…,
 * installing…) stays until the result replaces it, however long the action
 * takes.
 */
export type TabAlertKind = 'success' | 'error' | 'busy';

/**
 * A piece of a tab line's message: text, or `{ echo }` for a value
 * round-tripped from the server or typed by the user (a certificate's
 * subject), which goes in through a `<span>`'s textContent, never into markup.
 */
export type TabAlertPart = string | { echo: string };

/** A tab's one status line, from `buildTabAlert`. */
export interface TabAlert {
    element: HTMLElement;
    /** Show a message, replacing whatever was showing, and restart the clock. */
    show(kind: TabAlertKind, ...parts: TabAlertPart[]): void;
    /** Hide the line now. */
    clear(): void;
    /** Stop the clock for good: the dialog is closing. Later `show` calls do nothing. */
    destroy(): void;
}

/** Each line's controller, so the dialog can find the active tab's (`tabAlertIn`). */
const tabAlerts = new WeakMap<HTMLElement, TabAlert>();

/**
 * The tab's ONE status line (0.5.5): every action result on the tab -- a
 * failed install, a changed password, the dialog's own save -- is reported
 * here, at the bottom of the tab, rather than beside whichever control caused
 * it. A user who just clicked something looks in one place for the result.
 * What stays beside its control is what describes the control and not an
 * action: a field's validation, and a standing condition (a gate, a privilege
 * warning, "loading…").
 *
 * Appended straight into `section`, after every card, and never through
 * `buildRow()`: modal.css's `.settings-row:has(.settings-status-error)` would
 * start matching the row on an error and change its layout. It goes after
 * whatever the section holds when it is built, and `addCard` puts a later card
 * above it, so the line is the last thing in the tab either way.
 *
 * `role="status"` makes it a polite live region, so a screen reader announces
 * the result without moving focus. It is never `hidden`: a live region that
 * appears together with its text may not be announced at all, so the element
 * stays in the accessibility tree and is EMPTY when idle, and modal.css's
 * `.settings-tab-alert:empty` takes its margin away so it costs no room.
 */
export function buildTabAlert(section: HTMLElement): TabAlert {
    const element = document.createElement('p');
    element.className = 'settings-status settings-tab-alert';
    element.setAttribute('data-settings-alert', '');
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    section.appendChild(element);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let destroyed = false;

    const stopClock = (): void => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
    };
    /** Idle: no text (so `:empty` collapses it) and no tone. */
    const empty = (): void => {
        element.textContent = '';
        element.classList.remove('settings-status-error', 'settings-status-ready');
    };

    const alert: TabAlert = {
        element,
        show(kind, ...parts) {
            if (destroyed) return;
            stopClock();
            element.textContent = '';
            for (const part of parts) {
                if (typeof part === 'string') {
                    element.appendChild(document.createTextNode(part));
                } else {
                    const span = document.createElement('span');
                    span.textContent = part.echo;
                    element.appendChild(span);
                }
            }
            element.classList.toggle('settings-status-error', kind === 'error');
            element.classList.toggle('settings-status-ready', kind === 'success');
            if (kind === 'busy') return;
            timer = setTimeout(
                () => {
                    timer = null;
                    empty();
                },
                kind === 'success' ? TAB_ALERT_SUCCESS_MS : TAB_ALERT_ERROR_MS,
            );
        },
        clear() {
            stopClock();
            empty();
        },
        destroy() {
            destroyed = true;
            stopClock();
        },
    };
    tabAlerts.set(element, alert);
    return alert;
}

/** The status line inside `root` (a tab body), or null if it has none. */
export function tabAlertIn(root: HTMLElement): TabAlert | null {
    const el = root.matches('[data-settings-alert]') ? root : root.querySelector<HTMLElement>('[data-settings-alert]');
    return el ? (tabAlerts.get(el) ?? null) : null;
}

/** Destroy every status line inside `root`: the dialog is closing, or this body is being replaced. */
export function destroyTabAlerts(root: HTMLElement): void {
    for (const el of root.querySelectorAll<HTMLElement>('[data-settings-alert]')) tabAlerts.get(el)?.destroy();
}

/**
 * The muted note a tab shows, once, when its admin controls are held back
 * because the admin API will not answer this page (`adminApiReachable` false;
 * 0.5.5): `admin changes are limited to the machine running the server.`
 * Built hidden, as its own item; the tab shows it when it learns.
 */
export function buildAdminUnreachableNote(): HTMLElement {
    const note = document.createElement('p');
    note.className = 'settings-status';
    note.style.gridColumn = '1 / -1';
    note.setAttribute('data-admin-unreachable-note', '');
    note.textContent = ADMIN_UNREACHABLE_NOTE;
    note.hidden = true;
    return note;
}

/**
 * What a tab shows in place of its controls when the server refused its read
 * (`adminRefusal`; 0.5.6): why, and no retry, since a retry can only be
 * refused again. An operator refusal is `buildAdminUnreachableNote`'s note,
 * hook and all; a role refusal says only an admin can change these settings
 * (`data-admin-only-note`). Shown, unlike `buildAdminUnreachableNote`.
 */
export function buildRefusedNote(refusal: AdminRefusal): HTMLElement {
    const note = buildAdminUnreachableNote();
    note.hidden = false;
    if (refusal === 'role') {
        note.removeAttribute('data-admin-unreachable-note');
        note.setAttribute('data-admin-only-note', '');
        note.textContent = ADMIN_ONLY_NOTE;
    }
    return note;
}
