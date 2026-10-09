// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { SUBNETS_HELP_HREF, themeHelpLink, withHelpTheme } from '../helpLink';

/**
 * helpLink.ts (0.5.5): every link from the app to a help page names the app's
 * theme, so the guide opens in it. The help pages read `?theme=`
 * (certificateSubjectHelp.test.ts runs their head script).
 */

afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
});

describe('withHelpTheme', () => {
    it.each([
        ['help/subnets.html', 'light', 'help/subnets.html?theme=light'],
        ['help/subnets.html', 'dark', 'help/subnets.html?theme=dark'],
        // Before the hash, which has to stay last to land on the section.
        [
            'help/certificate-subject.html#4-installing-a-certificate-establishing-trust',
            'light',
            'help/certificate-subject.html?theme=light#4-installing-a-certificate-establishing-trust',
        ],
        // A theme already there is replaced, not doubled.
        ['help/subnets.html?theme=dark', 'light', 'help/subnets.html?theme=light'],
        // Anything else in the query is kept.
        ['help/subnets.html?x=1#top', 'dark', 'help/subnets.html?x=1&theme=dark#top'],
    ] as const)('%s, %s -> %s', (href, theme, expected) => {
        expect(withHelpTheme(href, theme)).toBe(expected);
    });

    it("reads the app's current theme off the page when none is passed", () => {
        document.documentElement.setAttribute('data-theme', 'light');
        expect(withHelpTheme('help/subnets.html')).toBe('help/subnets.html?theme=light');
        document.documentElement.setAttribute('data-theme', 'dark');
        expect(withHelpTheme('help/subnets.html')).toBe('help/subnets.html?theme=dark');
        // No attribute reads as dark, the app's default.
        document.documentElement.removeAttribute('data-theme');
        expect(withHelpTheme('help/subnets.html')).toBe('help/subnets.html?theme=dark');
    });
});

describe('themeHelpLink', () => {
    it('sets the themed href at once, and re-decides it on every way a link is followed', () => {
        document.documentElement.setAttribute('data-theme', 'light');
        const link = document.createElement('a');
        themeHelpLink(link, SUBNETS_HELP_HREF);
        expect(link.getAttribute('href')).toBe('help/subnets.html?theme=light');
        // jsdom has no navigation; cancel it so the click only runs the listeners.
        link.addEventListener('click', (e) => e.preventDefault());

        for (const [type, theme] of [
            ['click', 'dark'],
            ['auxclick', 'light'],
            ['contextmenu', 'dark'],
        ] as const) {
            // The theme changes while the link is on screen (the dialog stays open).
            document.documentElement.setAttribute('data-theme', theme);
            link.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
            expect(link.getAttribute('href'), type).toBe(`help/subnets.html?theme=${theme}`);
        }
    });

    it('names the cheat sheet relatively, so it follows the app path', () => {
        expect(SUBNETS_HELP_HREF).toBe('help/subnets.html');
    });
});
