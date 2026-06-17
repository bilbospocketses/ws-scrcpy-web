import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// cwd = repo root under vitest; resolve repo-relative paths from there.
const read = (rel: string): string => fs.readFileSync(path.resolve(...rel.split('/')), 'utf8');

describe('focus accessibility (WCAG 2.4.7)', () => {
    it('does not blanket-remove focus outlines globally', () => {
        // A bare `:focus { outline: none }` strips the keyboard focus indicator
        // from every element that lacks its own. Components may still opt out via
        // a more specific selector (e.g. inputs that swap to a border highlight).
        expect(read('src/style/app.css')).not.toMatch(/(^|})\s*:focus\s*\{[^}]*outline\s*:\s*none/);
    });

    it('provides a global :focus-visible outline', () => {
        expect(read('src/style/app.css')).toMatch(/:focus-visible\s*\{[^}]*outline\s*:/);
    });
});

describe('document language (WCAG 3.1.1)', () => {
    it('embed.html declares a document language', () => {
        expect(read('public/embed.html')).toMatch(/<html[^>]*\blang=/i);
    });
});

describe('cascade hygiene (no !important war)', () => {
    it('home.css uses specificity, not !important, for the discovery buttons', () => {
        // Match the declaration form (`… !important;` / `… !important}`) so a
        // comment that merely mentions the word doesn't trip the guard.
        expect(read('src/style/home.css')).not.toMatch(/!important\s*[;}]/);
    });

    it('the .video cell is auto-sized without !important (#106)', () => {
        // Sizing is driven by grid + the canvas max-width/height caps; the device
        // resolution is exposed via --video-width/--video-height custom props.
        expect(read('src/style/ws-scrcpy.css')).not.toMatch(/(?:width|height):\s*auto\s*!important/);
    });
});

describe('reduced motion (WCAG 2.3.3)', () => {
    it('honours prefers-reduced-motion with a global reset in app.css (#103)', () => {
        expect(read('src/style/app.css')).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    });
});

describe('custom-property naming', () => {
    it('uses kebab-case for the visited-link var, not an underscore (#104)', () => {
        expect(read('src/style/app.css')).not.toMatch(/--link-color_visited/);
    });
});
