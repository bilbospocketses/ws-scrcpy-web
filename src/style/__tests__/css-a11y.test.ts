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
});
