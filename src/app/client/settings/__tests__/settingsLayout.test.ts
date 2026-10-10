// @vitest-environment jsdom
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    addCard,
    addUntitledCard,
    buildDynamicLabelRow,
    buildItem,
    buildRow,
    buildSection,
    buildSplitSection,
    buildTabAlert,
    destroyTabAlerts,
    setCardShown,
    setRowShown,
    TAB_ALERT_ERROR_MS,
    TAB_ALERT_SUCCESS_MS,
    tabAlertIn,
} from '../settingsLayout';

/**
 * settingsLayout.ts (0.5.5): the one place every Settings tab but Dependencies
 * gets its shape from -- section, card(s), items, rows. jsdom applies no
 * stylesheet, so the DOM is checked here, and the modal.css rules that turn
 * that DOM into cards and lines are checked as text at the end; the rendered
 * result is the e2e suite's (settings-dialog.spec.ts).
 */

describe('buildSection', () => {
    it('makes a section with its title over ONE card', () => {
        const { section, heading, card } = buildSection('Users');
        expect(section.tagName).toBe('SECTION');
        expect(section.className).toBe('settings-section');
        expect(heading.tagName).toBe('H3');
        expect(heading.className).toBe('settings-section-heading');
        expect(heading.textContent).toBe('Users');
        expect(card.className).toBe('settings-card');
        expect([...section.children]).toEqual([heading, card]);
    });
});

describe('buildSplitSection and addCard', () => {
    it('keeps the tab title in the DOM but visually hidden, and puts each card under its own heading', () => {
        const { section, heading } = buildSplitSection('Server');
        expect(heading.textContent).toBe('Server');
        expect(heading.classList.contains('settings-section-heading')).toBe(true);
        // Hidden from the eye only: a screen reader still meets the title, and
        // the e2e suite still finds the tab by it.
        expect(heading.classList.contains('visually-hidden')).toBe(true);
        expect(heading.hidden).toBe(false);

        const ports = addCard(section, 'Ports');
        const app = addCard(section, 'Application');
        const [title, h1, c1, h2, c2] = [...section.children];
        expect(title).toBe(heading);
        expect(h1?.tagName).toBe('H4');
        expect(h1?.className).toBe('settings-card-heading');
        expect(h1?.textContent).toBe('Ports');
        expect(c1).toBe(ports);
        expect(h2?.textContent).toBe('Application');
        expect(c2).toBe(app);
        expect(ports.className).toBe('settings-card');
    });

    it('setCardShown hides and shows a card together with its heading', () => {
        const { section } = buildSplitSection('Server');
        const card = addCard(section, 'Ports');
        const heading = card.previousElementSibling as HTMLElement;
        setCardShown(card, false);
        expect(card.hidden).toBe(true);
        expect(heading.hidden).toBe(true);
        setCardShown(card, true);
        expect(card.hidden).toBe(false);
        expect(heading.hidden).toBe(false);
    });

    // 0.5.8: the Server tab's note where the admin API will not answer.
    it('addUntitledCard adds a card with no heading, in order with the titled ones and above the status line', () => {
        const { section, heading } = buildSplitSection('Server');
        const alert = buildTabAlert(section);
        const settings = addCard(section, 'Settings');
        const untitled = addUntitledCard(section);
        const ports = addCard(section, 'Ports');
        expect(untitled.className).toBe('settings-card');
        const kids = [...section.children];
        expect(kids).toEqual([
            heading,
            settings.previousElementSibling,
            settings,
            untitled,
            ports.previousElementSibling,
            ports,
            alert.element,
        ]);
        // No heading of its own: setCardShown touches the card alone, and the
        // heading before it (Settings') is left as it was.
        expect(section.querySelectorAll('h4')).toHaveLength(2);
        setCardShown(untitled, false);
        expect(untitled.hidden).toBe(true);
        expect((settings.previousElementSibling as HTMLElement).hidden).toBe(false);
        setCardShown(untitled, true);
        expect(untitled.hidden).toBe(false);
    });

    it('setCardShown on a single-card tab card (no heading of its own) touches only the card', () => {
        const { heading, card } = buildSection('Users');
        setCardShown(card, false);
        expect(card.hidden).toBe(true);
        expect(heading.hidden).toBe(false);
    });
});

describe('buildItem', () => {
    it('wraps a row and the notes under it, in order', () => {
        const row = buildRow('http port', document.createElement('input'));
        const note = document.createElement('p');
        const item = buildItem(row, note);
        expect(item.className).toBe('settings-item');
        expect([...item.children]).toEqual([row, note]);
    });

    it('starts empty when given nothing, for a caller that fills it later', () => {
        expect(buildItem().children).toHaveLength(0);
    });
});

describe('buildRow', () => {
    it('puts the label on the left and the control in its own cell on the right', () => {
        const input = document.createElement('input');
        const row = buildRow('http port', input);
        expect(row.className).toBe('settings-row');
        const [label, control] = [...row.children];
        expect(label?.className).toBe('settings-label');
        expect(label?.textContent).toBe('http port');
        expect(control?.className).toBe('settings-control');
        expect(control?.firstElementChild).toBe(input);
    });

    it('takes a fragment of several controls into the one control cell', () => {
        const frag = document.createDocumentFragment();
        frag.append(document.createElement('button'), document.createElement('button'));
        const row = buildRow('certificate', frag);
        expect(row.querySelector('.settings-control')?.children).toHaveLength(2);
    });

    it('with no control, has no control cell and lets the label span both columns', () => {
        const row = buildRow('No other origins may embed this app.', null);
        expect(row.querySelector('.settings-control')).toBeNull();
        const label = row.querySelector('.settings-label')!;
        expect(label.classList.contains('settings-label-wide')).toBe(true);
        expect(label.textContent).toBe('No other origins may embed this app.');
    });

    it('a row WITH a control does not span', () => {
        const row = buildRow('login', document.createElement('button'));
        expect(row.querySelector('.settings-label-wide')).toBeNull();
    });
});

describe('buildDynamicLabelRow', () => {
    it('hands back the label, so its text can change while the control stays', () => {
        const btn = document.createElement('button');
        const { row, labelEl } = buildDynamicLabelRow("couldn't reach server", btn);
        expect(row.querySelector('.settings-label')).toBe(labelEl);
        labelEl.textContent = 'checking…';
        expect(row.textContent).toBe('checking…');
        expect(row.querySelector('.settings-control')?.firstElementChild).toBe(btn);
    });
});

describe('setRowShown', () => {
    it('sets the inline display a display:contents row needs AND the hidden attribute modal.css reads', () => {
        const row = buildRow('install for all users', document.createElement('button'));
        setRowShown(row, false);
        expect(row.style.display).toBe('none');
        expect(row.hidden).toBe(true);
        setRowShown(row, true);
        expect(row.style.display).toBe('');
        expect(row.hidden).toBe(false);
    });
});

describe('the modal.css rules the layout relies on', () => {
    const modal = fs.readFileSync(path.resolve('src', 'style', 'modal.css'), 'utf8');
    const rule = (selector: string): string => {
        const at = modal.indexOf(`${selector} {`);
        expect(at, selector).toBeGreaterThan(-1);
        return modal.slice(at, modal.indexOf('}', at));
    };

    it('draws a card as the Dependencies card: border, 8px corners, 4px 16px padding, the token background', () => {
        const card = rule('dialog.settings-modal .settings-card');
        expect(card).toContain('border: 1px solid var(--device-border-color);');
        expect(card).toContain('border-radius: 8px;');
        expect(card).toContain('padding: 4px 16px;');
        expect(card).toContain('background: var(--settings-card-bg);');
        expect(rule('dialog.settings-modal .settings-card[hidden]')).toContain('display: none;');
    });

    it('sets a card with no heading off from the card before it, as a heading would (0.5.8)', () => {
        expect(rule('dialog.settings-modal .settings-card + .settings-card')).toContain('margin-top: 1.25rem;');
    });

    it('gives every item the two-column grid with an 18rem labels column and 0.6rem padding', () => {
        const item = rule('dialog.settings-modal .settings-item');
        expect(item).toContain('display: grid;');
        expect(item).toContain('grid-template-columns: [labels] 18rem [controls] 1fr;');
        expect(item).toContain('padding: 0.6rem 0;');
    });

    it('takes an item with nothing showing out of the layout', () => {
        const at = modal.indexOf('dialog.settings-modal .settings-item[hidden],');
        expect(at).toBeGreaterThan(-1);
        const block = modal.slice(at, modal.indexOf('}', at));
        expect(block).toContain('dialog.settings-modal .settings-item:not(:has(> :not([hidden])))');
        expect(block).toContain('display: none;');
    });

    it('draws the line between two showing items only, in the table row line color', () => {
        const at = modal.indexOf('.settings-item:not([hidden]):has(> :not([hidden]))\n    ~ .settings-item');
        expect(at).toBeGreaterThan(-1);
        expect(modal.slice(at, modal.indexOf('}', at))).toContain('border-top: 1px solid var(--button-border-color);');
    });

    it('sizes the tab title and the card headings as the Dependencies h2', () => {
        const title = rule('dialog.settings-modal .settings-section-heading');
        expect(title).toContain('font-size: 18px;');
        expect(title).toContain('margin: 0 0 0.75rem;');
        const cardHeading = rule('dialog.settings-modal .settings-card-heading');
        expect(cardHeading).toContain('font-size: 18px;');
        expect(cardHeading).toContain('margin: 1.25rem 0 0.75rem;');
        expect(rule('dialog.settings-modal .settings-card-heading:first-of-type')).toContain('margin-top: 0;');
    });

    it('makes plain notes regular weight, and keeps warnings and errors on a note bold', () => {
        expect(rule('dialog.settings-modal .settings-status')).toContain('font-weight: 400;');
        expect(rule('dialog.settings-modal .settings-stub-note')).toContain('font-weight: 400;');
        const at = modal.indexOf('dialog.settings-modal .settings-status.settings-status-error,');
        expect(at).toBeGreaterThan(-1);
        const block = modal.slice(at, modal.indexOf('}', at));
        expect(block).toContain('dialog.settings-modal .settings-status.settings-status-warning');
        expect(block).toContain('font-weight: 600;');
    });

    it('lets a label-only row span both columns', () => {
        expect(rule('dialog.settings-modal .settings-label.settings-label-wide')).toContain('grid-column: 1 / -1;');
    });

    it('collapses an empty tab status line, which is never hidden', () => {
        const empty = rule('dialog.settings-modal .settings-status.settings-tab-alert:empty');
        expect(empty).toContain('margin: 0;');
        expect(empty).toContain('min-height: 0;');
    });

    it('gives the section no divider of its own any more', () => {
        expect(rule('dialog.settings-modal .settings-section')).not.toContain('border-bottom');
    });
});

/**
 * A tab's one status line (0.5.5): where every action result on the tab is
 * reported, at the bottom, outside every card.
 */
describe('buildTabAlert', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('is the last thing in the section, outside every card, empty until it has something to say', () => {
        const { section, card } = buildSection('Users');
        card.appendChild(buildItem(buildRow('user accounts', null)));
        const alert = buildTabAlert(section);
        expect(section.lastElementChild).toBe(alert.element);
        expect(card.contains(alert.element)).toBe(false);
        expect(alert.element.textContent).toBe('');
        // Never `hidden`: a live region must already be in the accessibility
        // tree when its text arrives, or it may not be announced.
        expect(alert.element.hidden).toBe(false);
        expect(alert.element.classList.contains('settings-status')).toBe(true);
        expect(alert.element.classList.contains('settings-tab-alert')).toBe(true);
        expect(alert.element.hasAttribute('data-settings-alert')).toBe(true);
        // A polite live region: a result is announced without moving focus.
        expect(alert.element.getAttribute('role')).toBe('status');
        expect(alert.element.getAttribute('aria-live')).toBe('polite');
    });

    it('stays last on a split tab whose cards are added after it', () => {
        const { section } = buildSplitSection('Server');
        const alert = buildTabAlert(section);
        const settings = addCard(section, 'Settings');
        const ports = addCard(section, 'Ports');
        expect(section.lastElementChild).toBe(alert.element);
        const kids = [...section.children];
        expect(kids.indexOf(settings)).toBeLessThan(kids.indexOf(ports));
        expect(kids.indexOf(ports)).toBeLessThan(kids.indexOf(alert.element));
    });

    it('hides a success after 5 s, and an error after 10 s', () => {
        const { section } = buildSection('Users');
        const alert = buildTabAlert(section);
        expect(TAB_ALERT_SUCCESS_MS).toBe(5_000);
        expect(TAB_ALERT_ERROR_MS).toBe(10_000);

        alert.show('success', 'password changed');
        expect(alert.element.textContent).not.toBe('');
        expect(alert.element.textContent).toBe('password changed');
        expect(alert.element.classList.contains('settings-status-ready')).toBe(true);
        expect(alert.element.classList.contains('settings-status-error')).toBe(false);
        vi.advanceTimersByTime(TAB_ALERT_SUCCESS_MS - 1);
        expect(alert.element.textContent).not.toBe('');
        vi.advanceTimersByTime(1);
        expect(alert.element.textContent).toBe('');

        alert.show('error', 'current password incorrect');
        expect(alert.element.classList.contains('settings-status-error')).toBe(true);
        expect(alert.element.classList.contains('settings-status-ready')).toBe(false);
        vi.advanceTimersByTime(TAB_ALERT_SUCCESS_MS);
        expect(alert.element.textContent, 'an error outlasts a success').not.toBe('');
        vi.advanceTimersByTime(TAB_ALERT_ERROR_MS - TAB_ALERT_SUCCESS_MS);
        expect(alert.element.textContent).toBe('');
    });

    it('a new message replaces the old one and restarts the clock', () => {
        const { section } = buildSection('Users');
        const alert = buildTabAlert(section);
        alert.show('error', 'first');
        vi.advanceTimersByTime(TAB_ALERT_ERROR_MS - 1_000);
        alert.show('success', 'second');
        expect(alert.element.textContent).toBe('second');
        // The first message's timer would have fired here; the second's has
        // not run out.
        vi.advanceTimersByTime(1_000);
        expect(alert.element.textContent).not.toBe('');
        vi.advanceTimersByTime(TAB_ALERT_SUCCESS_MS - 1_000);
        expect(alert.element.textContent).toBe('');
    });

    it('a busy message stays until its result replaces it', () => {
        const { section } = buildSection('Server');
        const alert = buildTabAlert(section);
        alert.show('busy', 'saving…');
        expect(alert.element.classList.contains('settings-status-error')).toBe(false);
        expect(alert.element.classList.contains('settings-status-ready')).toBe(false);
        vi.advanceTimersByTime(TAB_ALERT_ERROR_MS * 10);
        expect(alert.element.textContent).not.toBe('');
        expect(alert.element.textContent).toBe('saving…');

        alert.show('success', 'password changed');
        vi.advanceTimersByTime(TAB_ALERT_SUCCESS_MS);
        expect(alert.element.textContent).toBe('');
    });

    it('a busy message after a timed one is not hidden by the old timer', () => {
        const { section } = buildSection('Server');
        const alert = buildTabAlert(section);
        alert.show('success', 'done');
        alert.show('busy', 'restarting → redirecting…');
        vi.advanceTimersByTime(TAB_ALERT_ERROR_MS);
        expect(alert.element.textContent).not.toBe('');
    });

    it('clear empties it at once, drops its tone and stops its clock', () => {
        const { section } = buildSection('Users');
        const alert = buildTabAlert(section);
        alert.show('error', 'nope');
        alert.clear();
        expect(alert.element.textContent).toBe('');
        expect(alert.element.hidden).toBe(false);
        expect(alert.element.classList.contains('settings-status-error')).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('destroy stops the clock for good: nothing shows after the dialog closes', () => {
        const { section } = buildSection('Users');
        const alert = buildTabAlert(section);
        alert.show('error', 'nope');
        expect(vi.getTimerCount()).toBe(1);
        alert.destroy();
        expect(vi.getTimerCount()).toBe(0);
        // An action that answers after the close says nothing and starts nothing.
        alert.show('success', 'late');
        expect(alert.element.textContent).toBe('nope');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('destroyTabAlerts destroys every line inside a root', () => {
        const root = document.createElement('div');
        const a = buildSection('Users');
        const b = buildSection('Server');
        root.append(a.section, b.section);
        const one = buildTabAlert(a.section);
        const two = buildTabAlert(b.section);
        one.show('error', 'x');
        two.show('success', 'y');
        expect(vi.getTimerCount()).toBe(2);
        destroyTabAlerts(root);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('tabAlertIn finds the line of a tab body, or nothing', () => {
        const { section } = buildSection('Users');
        expect(tabAlertIn(section)).toBeNull();
        const alert = buildTabAlert(section);
        const body = document.createElement('div');
        body.appendChild(section);
        expect(tabAlertIn(body)).toBe(alert);
        expect(tabAlertIn(alert.element)).toBe(alert);
    });

    it('puts an echoed value in through textContent, never as markup', () => {
        const { section } = buildSection('Local HTTPS');
        const alert = buildTabAlert(section);
        alert.show('success', 'accepts ', { echo: '<img src=x onerror=alert(1)>' }, '.');
        expect(alert.element.querySelector('img')).toBeNull();
        expect(alert.element.textContent).toBe('accepts <img src=x onerror=alert(1)>.');
    });
});
