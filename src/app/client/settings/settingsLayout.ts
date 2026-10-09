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
 */
export function addCard(section: HTMLElement, headingText: string): HTMLElement {
    const heading = document.createElement('h4');
    heading.className = 'settings-card-heading';
    heading.textContent = headingText;
    const card = buildCardElement();
    cardHeadings.set(card, heading);
    section.append(heading, card);
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
