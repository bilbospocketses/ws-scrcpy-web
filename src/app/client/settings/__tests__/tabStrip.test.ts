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

    it('switching tabs swaps the panel', () => {
        const strip = new TabStrip(makeTabs());
        strip.activate('b');
        expect(strip.activeId()).toBe('b');
        expect(strip.getPanel().textContent).toContain('B body');
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
