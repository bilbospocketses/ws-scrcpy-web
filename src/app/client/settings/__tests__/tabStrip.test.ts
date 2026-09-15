// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { TabStrip } from '../TabStrip';

function makeTabs() {
    return [
        {
            id: 'a',
            label: 'Alpha',
            build: () => {
                const d = document.createElement('div');
                d.textContent = 'A body';
                return d;
            },
        },
        {
            id: 'b',
            label: 'Beta',
            build: () => {
                const d = document.createElement('div');
                d.textContent = 'B body';
                return d;
            },
        },
    ];
}

describe('TabStrip', () => {
    it('renders one button per tab and activates the first', () => {
        const strip = new TabStrip(makeTabs());
        const labels = [...strip.getElement().querySelectorAll('button')].map((b) => b.textContent);
        expect(labels).toEqual(['Alpha', 'Beta']);
        expect(strip.activeId()).toBe('a');
        expect(strip.getPanel().textContent).toContain('A body');
    });

    /**
     * Asserts `hidden`, NOT `textContent`.
     *
     * This test used to check that the panel's text contained 'B body', which it
     * cannot fail: every body is built eagerly in the constructor and attached to
     * the panel, so BOTH bodies' text is always present regardless of which tab is
     * active. `activate()` could be deleted outright and the old assertion stayed
     * green. `hidden` is the only thing `activate()` actually changes, so it is
     * the only thing worth asserting.
     */
    it('switching tabs shows the new body and hides the old one', () => {
        const strip = new TabStrip(makeTabs());
        const bodyOf = (text: string): HTMLElement =>
            [...strip.getPanel().children].find((el) => el.textContent === text) as HTMLElement;

        strip.activate('b');
        expect(strip.activeId()).toBe('b');
        expect(bodyOf('B body').hidden).toBe(false);
        expect(bodyOf('A body').hidden).toBe(true);

        // And back, so this cannot pass on a one-way toggle either.
        strip.activate('a');
        expect(bodyOf('A body').hidden).toBe(false);
        expect(bodyOf('B body').hidden).toBe(true);
    });

    it('builds each tab body only once, so edits survive a round trip', () => {
        let builds = 0;
        const strip = new TabStrip([
            {
                id: 'a',
                label: 'Alpha',
                build: () => {
                    builds++;
                    return document.createElement('div');
                },
            },
            { id: 'b', label: 'Beta', build: () => document.createElement('div') },
        ]);
        strip.activate('b');
        strip.activate('a');
        expect(builds).toBe(1);
    });

    it('marks the active button so CSS can style it', () => {
        const strip = new TabStrip(makeTabs());
        strip.activate('b');
        const active = [...strip.getElement().querySelectorAll('button')].filter(
            (b) => b.getAttribute('aria-selected') === 'true',
        );
        expect(active.map((b) => b.textContent)).toEqual(['Beta']);
    });
});
