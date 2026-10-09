// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCombobox, type Combobox } from '../Combobox';

/**
 * Combobox.ts (0.5.5): the certificate subject's address box. The pins are the
 * ones a native <datalist> got wrong (it filtered by the box's value) and the
 * ones the APG editable-combobox pattern asks for: roles and states, keyboard
 * movement, Escape that goes no further than the list, and a click outside.
 */

afterEach(() => {
    document.body.replaceChildren();
});

function build(values: string[] = ['192.168.86.3', '10.0.0.5', '172.16.4.9'], value = '192.168.86.3') {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = value;
    const combo = buildCombobox({ input, buttonLabel: "this computer's addresses" });
    combo.setOptions(values);
    // Connected, as in the dialog: focus and the outside-click listener need a document.
    document.body.appendChild(combo.root);
    return combo;
}

const options = (c: Combobox) => [...c.list.querySelectorAll<HTMLElement>('[role="option"]')];
const key = (c: Combobox, k: string): KeyboardEvent => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    c.input.dispatchEvent(e);
    return e;
};

describe('buildCombobox: shape and ARIA', () => {
    it('wraps the box, the ▾ button and the list, in that order', () => {
        const c = build();
        expect([...c.root.children]).toEqual([c.input, c.button, c.list]);
        expect(c.root.className).toBe('settings-combo');
        expect(c.input.classList.contains('settings-combo-input')).toBe(true);
    });

    it('marks the box as an editable combobox that completes nothing, controlling a listbox', () => {
        const c = build();
        expect(c.input.getAttribute('role')).toBe('combobox');
        expect(c.input.getAttribute('aria-autocomplete')).toBe('none');
        expect(c.input.getAttribute('aria-expanded')).toBe('false');
        expect(c.list.id).not.toBe('');
        expect(c.input.getAttribute('aria-controls')).toBe(c.list.id);
        expect(c.list.getAttribute('role')).toBe('listbox');
        expect(c.list.hidden).toBe(true);
        // Not a native datalist, which filters by what the box holds.
        expect(c.input.hasAttribute('list')).toBe(false);
        expect(c.root.querySelector('datalist')).toBeNull();
    });

    it('gives the ▾ a name and keeps it out of the tab order (ArrowDown is the keyboard way in)', () => {
        const c = build();
        expect(c.button.type).toBe('button');
        expect(c.button.textContent).toBe('▾');
        expect(c.button.getAttribute('aria-label')).toBe("this computer's addresses");
        expect(c.button.tabIndex).toBe(-1);
        expect(c.button.getAttribute('aria-controls')).toBe(c.list.id);
    });

    it('gives two comboboxes on one page different ids', () => {
        const a = build();
        const b = build();
        expect(a.list.id).not.toBe(b.list.id);
    });
});

describe('buildCombobox: opening and picking', () => {
    it('the ▾ opens a list of EVERY option, the current value ticked, and closes it again', () => {
        const c = build();
        c.button.click();
        expect(c.isOpen()).toBe(true);
        expect(c.input.getAttribute('aria-expanded')).toBe('true');
        expect(c.button.getAttribute('aria-expanded')).toBe('true');
        expect(options(c).map((o) => o.textContent)).toEqual(['192.168.86.3', '10.0.0.5', '172.16.4.9']);
        expect(options(c).map((o) => o.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
        // Opened by a click, nothing is singled out for the arrows yet.
        expect(c.input.hasAttribute('aria-activedescendant')).toBe(false);
        expect(c.list.querySelector('.settings-combo-option-active')).toBeNull();
        c.button.click();
        expect(c.isOpen()).toBe(false);
        expect(c.input.getAttribute('aria-expanded')).toBe('false');
    });

    it('never filters by what is typed', () => {
        const c = build(undefined, '10.');
        c.button.click();
        expect(options(c)).toHaveLength(3);
        // Nothing matches exactly, so nothing is ticked.
        expect(options(c).every((o) => o.getAttribute('aria-selected') === 'false')).toBe(true);
    });

    it('a click on an option fills the box, closes the list, keeps focus in the box and fires input', () => {
        const c = build();
        const heard = vi.fn();
        c.input.addEventListener('input', heard);
        c.button.click();
        options(c)[2]!.click();
        expect(c.input.value).toBe('172.16.4.9');
        expect(c.isOpen()).toBe(false);
        expect(document.activeElement).toBe(c.input);
        expect(heard).toHaveBeenCalledTimes(1);
    });

    it('a press on an option or the ▾ does not take focus from the box', () => {
        const c = build();
        const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        c.button.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
        c.button.click();
        const onOption = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        options(c)[0]!.dispatchEvent(onOption);
        expect(onOption.defaultPrevented).toBe(true);
        // The list's own padding, between or around the options, too.
        const onPadding = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        c.list.dispatchEvent(onPadding);
        expect(onPadding.defaultPrevented).toBe(true);
        expect(c.isOpen()).toBe(true);
    });

    it('a press outside closes the list; one inside does not', () => {
        const c = build();
        const outside = document.createElement('button');
        document.body.appendChild(outside);
        c.button.click();
        c.list.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(c.isOpen()).toBe(true);
        outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        expect(c.isOpen()).toBe(false);
    });

    it('stops listening outside once closed', () => {
        const c = build();
        const remove = vi.spyOn(document, 'removeEventListener');
        c.button.click();
        c.close();
        expect(remove).toHaveBeenCalledWith('mousedown', expect.any(Function), true);
    });

    it('leaving the box closes the list', () => {
        const c = build();
        c.button.click();
        c.input.dispatchEvent(new FocusEvent('blur'));
        expect(c.isOpen()).toBe(false);
    });
});

describe('buildCombobox: the keyboard', () => {
    it('ArrowDown opens the list on the current value, then moves down; ArrowUp moves up; both stop at the ends', () => {
        const c = build(undefined, '10.0.0.5');
        expect(key(c, 'ArrowDown').defaultPrevented).toBe(true);
        expect(c.isOpen()).toBe(true);
        const active = () => c.input.getAttribute('aria-activedescendant');
        expect(active()).toBe(options(c)[1]!.id);
        expect(options(c)[1]!.classList.contains('settings-combo-option-active')).toBe(true);
        key(c, 'ArrowDown');
        expect(active()).toBe(options(c)[2]!.id);
        key(c, 'ArrowDown');
        expect(active()).toBe(options(c)[2]!.id);
        key(c, 'ArrowUp');
        key(c, 'ArrowUp');
        key(c, 'ArrowUp');
        expect(active()).toBe(options(c)[0]!.id);
    });

    it('ArrowDown with a value that is not an option opens on the first', () => {
        const c = build(undefined, 'typed by hand');
        key(c, 'ArrowDown');
        expect(c.input.getAttribute('aria-activedescendant')).toBe(options(c)[0]!.id);
    });

    it('after a click opened the list, ArrowDown starts at the first option', () => {
        const c = build(undefined, '10.0.0.5');
        c.button.click();
        key(c, 'ArrowDown');
        expect(c.input.getAttribute('aria-activedescendant')).toBe(options(c)[0]!.id);
    });

    it('Enter picks the option the arrows are on', () => {
        const c = build();
        key(c, 'ArrowDown');
        key(c, 'ArrowDown');
        expect(key(c, 'Enter').defaultPrevented).toBe(true);
        expect(c.input.value).toBe('10.0.0.5');
        expect(c.isOpen()).toBe(false);
        expect(c.input.hasAttribute('aria-activedescendant')).toBe(false);
    });

    it('Enter with the list closed is left alone', () => {
        const c = build();
        expect(key(c, 'Enter').defaultPrevented).toBe(false);
    });

    it('Escape closes the list and goes no further, so the dialog behind it stays open', () => {
        const c = build();
        const reachedDialog = vi.fn();
        document.body.addEventListener('keydown', reachedDialog);
        c.button.click();
        const e = key(c, 'Escape');
        expect(c.isOpen()).toBe(false);
        // No cancel follows a prevented keydown, and nothing above hears it.
        expect(e.defaultPrevented).toBe(true);
        expect(reachedDialog).not.toHaveBeenCalled();
    });

    it('Escape with the list closed passes through, so it still closes the dialog', () => {
        const c = build();
        const reachedDialog = vi.fn();
        document.body.addEventListener('keydown', reachedDialog);
        const e = key(c, 'Escape');
        expect(e.defaultPrevented).toBe(false);
        expect(reachedDialog).toHaveBeenCalledTimes(1);
    });
});

describe('buildCombobox: when there is nothing to list', () => {
    it('hides the ▾ with no options, and neither the ▾ nor ArrowDown opens anything', () => {
        const c = build([]);
        expect(c.button.hidden).toBe(true);
        c.open();
        expect(c.isOpen()).toBe(false);
        expect(key(c, 'ArrowDown').defaultPrevented).toBe(false);
        expect(c.isOpen()).toBe(false);
        c.setOptions(['10.0.0.5']);
        expect(c.button.hidden).toBe(false);
    });

    it('setListAvailable(false) hides the ▾ and closes an open list; true brings the ▾ back', () => {
        const c = build();
        c.button.click();
        c.setListAvailable(false);
        expect(c.isOpen()).toBe(false);
        expect(c.button.hidden).toBe(true);
        key(c, 'ArrowDown');
        expect(c.isOpen()).toBe(false);
        c.setListAvailable(true);
        expect(c.button.hidden).toBe(false);
    });

    it('a disabled box does not open', () => {
        const c = build();
        c.input.disabled = true;
        c.open();
        expect(c.isOpen()).toBe(false);
    });

    it('re-renders an open list when the options change, and closes it when they run out', () => {
        const c = build();
        c.button.click();
        c.setOptions(['10.9.9.9']);
        expect(options(c).map((o) => o.textContent)).toEqual(['10.9.9.9']);
        c.setOptions([]);
        expect(c.isOpen()).toBe(false);
    });
});
