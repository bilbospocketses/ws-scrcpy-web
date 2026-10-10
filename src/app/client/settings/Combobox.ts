/**
 * An editable combobox: a text box that takes any value, with a ▾ button on its
 * right edge that opens a list of suggestions (0.5.5, the Local HTTPS
 * certificate subject, where the suggestions are this computer's addresses).
 *
 * NOT a native `<datalist>`, which is the obvious way to get "a box with
 * suggestions" and the wrong one here: a datalist FILTERS its options by what
 * the box holds, so a box already holding one address offered only that
 * address, and the others could not be reached without first clearing it. This
 * list always shows every option, whatever is typed, with the box's current
 * value ticked.
 *
 * The ARIA follows the APG's editable combobox with a list popup: the input is
 * the `combobox` (`aria-expanded`, `aria-controls`, `aria-autocomplete="none"`
 * because nothing is completed or filtered as the user types) and keeps focus
 * throughout; the list is a `listbox` of `option`s, and the option the arrow
 * keys are on is announced through the input's `aria-activedescendant`. The ▾
 * button is out of the tab order (`tabindex=-1`), as the pattern has it: from
 * the keyboard, ArrowDown in the box opens the list.
 *
 * - ArrowDown opens the list, or moves down it; ArrowUp moves up it.
 * - Enter picks the option the arrow keys are on.
 * - Escape closes the list and goes no further: an open list is what Escape
 *   is for, so the Settings dialog behind it must not see the key and close.
 * - A click on an option picks it; a click anywhere outside closes the list.
 *
 * Picking puts the option in the box and fires the box's own `input` event, so
 * everything that listens to the box (a validation line, a remembered value)
 * hears about it exactly as it would hear about typing.
 */

/** Gives each combobox's list and options their own ids, unique on the page. */
let comboSeq = 0;

export interface Combobox {
    /** The wrapper holding the box, its button and the list; goes where the box would. */
    readonly root: HTMLElement;
    readonly input: HTMLInputElement;
    readonly button: HTMLButtonElement;
    readonly list: HTMLUListElement;
    /** Replace the suggestions. With none, the button hides: there is nothing to open. */
    setOptions(values: readonly string[]): void;
    /** Allow the list or not (the subject's hostname mode has none); `false` closes it and hides the button. */
    setListAvailable(available: boolean): void;
    open(): void;
    close(): void;
    isOpen(): boolean;
}

export interface ComboboxOptions {
    /** The text box to wrap. It keeps every attribute and listener it already has. */
    input: HTMLInputElement;
    /** The ▾ button's accessible name, e.g. "this computer's addresses". */
    buttonLabel: string;
}

export function buildCombobox(opts: ComboboxOptions): Combobox {
    const { input } = opts;
    const seq = ++comboSeq;
    const listId = `settings-combo-${seq}-list`;

    const root = document.createElement('span');
    root.className = 'settings-combo';

    input.classList.add('settings-combo-input');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'none');
    input.setAttribute('aria-controls', listId);
    input.setAttribute('aria-expanded', 'false');
    input.autocomplete = 'off';

    const button = document.createElement('button');
    button.type = 'button';
    // `.settings-input` for the box's own background, border and disabled look.
    button.className = 'settings-input settings-combo-button';
    button.textContent = '▾';
    button.tabIndex = -1;
    button.setAttribute('aria-label', opts.buttonLabel);
    button.setAttribute('aria-controls', listId);
    button.setAttribute('aria-expanded', 'false');

    const list = document.createElement('ul');
    list.className = 'settings-combo-list';
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', opts.buttonLabel);
    list.hidden = true;
    // mousedown, not click, is canceled: it is what would move focus out of the
    // box, and the box keeps focus throughout. On the whole list, not on each
    // option, so a press in the list's own padding or scrollbar does not blur
    // the box either (a blur closes the list).
    list.addEventListener('mousedown', (e) => e.preventDefault());

    root.append(input, button, list);

    let values: string[] = [];
    let available = true;
    /** Index into `values` of the option the arrow keys are on, or -1 for none. */
    let active = -1;

    function optionEls(): HTMLLIElement[] {
        return [...list.querySelectorAll<HTMLLIElement>('li[role="option"]')];
    }

    function setActive(index: number): void {
        active = index;
        const els = optionEls();
        for (const [i, li] of els.entries()) li.classList.toggle('settings-combo-option-active', i === index);
        const current = els[index];
        if (current) {
            input.setAttribute('aria-activedescendant', current.id);
            current.scrollIntoView?.({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    }

    function syncButton(): void {
        button.hidden = !available || values.length === 0;
    }

    function setExpanded(expanded: boolean): void {
        list.hidden = !expanded;
        input.setAttribute('aria-expanded', String(expanded));
        button.setAttribute('aria-expanded', String(expanded));
    }

    /**
     * Rendered fresh on every open: the tick has to follow whatever the box
     * holds by then, which the user may have typed since the last open.
     */
    function render(): void {
        list.replaceChildren(
            ...values.map((value, i) => {
                const li = document.createElement('li');
                li.className = 'settings-combo-option';
                li.id = `settings-combo-${seq}-option-${i}`;
                li.setAttribute('role', 'option');
                li.setAttribute('aria-selected', String(value === input.value));
                li.textContent = value;
                li.addEventListener('click', () => pick(value));
                return li;
            }),
        );
    }

    function isOpen(): boolean {
        return !list.hidden;
    }

    /** A press anywhere outside the box, its button and the list closes it. */
    function onOutsidePointer(e: Event): void {
        if (e.target instanceof Node && root.contains(e.target)) return;
        close();
    }

    /** Opened by a click: the tick shows the value, and no option is singled out until an arrow key is pressed. */
    function open(): void {
        if (!available || values.length === 0 || input.disabled) return;
        render();
        setExpanded(true);
        setActive(-1);
        input.ownerDocument.addEventListener('mousedown', onOutsidePointer, true);
    }

    function close(): void {
        input.ownerDocument.removeEventListener('mousedown', onOutsidePointer, true);
        if (!isOpen()) return;
        setExpanded(false);
        setActive(-1);
    }

    function pick(value: string): void {
        input.value = value;
        close();
        input.focus();
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    button.addEventListener('click', () => {
        if (isOpen()) {
            close();
        } else {
            open();
        }
        input.focus();
    });
    // The button takes no focus either, for the same reason as the options.
    button.addEventListener('mousedown', (e) => e.preventDefault());

    input.addEventListener('keydown', (e) => {
        switch (e.key) {
            case 'ArrowDown':
                if (!isOpen()) {
                    if (!available || values.length === 0 || input.disabled) return;
                    e.preventDefault();
                    open();
                    // On the value the box holds when it is one of the options,
                    // so the arrows start from there; otherwise on the first.
                    setActive(Math.max(values.indexOf(input.value), 0));
                    return;
                }
                e.preventDefault();
                setActive(Math.min(active + 1, values.length - 1));
                return;
            case 'ArrowUp':
                if (!isOpen()) return;
                e.preventDefault();
                setActive(active <= 0 ? 0 : active - 1);
                return;
            case 'Enter': {
                if (!isOpen()) return;
                const value = values[active];
                if (value === undefined) return;
                e.preventDefault();
                pick(value);
                return;
            }
            case 'Escape':
                if (!isOpen()) return;
                // Stopped here: the dialog closes on an Escape that reaches it
                // (its `cancel` event follows an unprevented keydown).
                e.preventDefault();
                e.stopPropagation();
                close();
                return;
        }
    });

    // Leaving the box by the keyboard (Tab) closes the list too.
    input.addEventListener('blur', () => close());

    return {
        root,
        input,
        button,
        list,
        setOptions(next) {
            values = [...next];
            syncButton();
            if (isOpen()) {
                if (values.length === 0) close();
                else open();
            }
        },
        setListAvailable(next) {
            available = next;
            syncButton();
            if (!next) close();
        },
        open,
        close,
        isOpen,
    };
}
