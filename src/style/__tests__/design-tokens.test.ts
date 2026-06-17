import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest runs with cwd = repo root (npm --prefix / vitest root), so resolve the
// stylesheet dir from there. These are structural guards for the design-token
// system: they fail if a hardcoded color literal is re-introduced or a token
// stops being defined in both themes.
const STYLE_DIR = path.resolve('src', 'style');
const CSS_FILES = [
    'app.css',
    'home.css',
    'modal.css',
    'listfiles.css',
    'devicelist.css',
    'dependencies.css',
    'ws-scrcpy.css',
];
// Consumers must not hardcode token literals; the canonical definitions live in
// app.css, so it is exempt from the no-literal checks.
const CONSUMER_CSS_FILES = CSS_FILES.filter((f) => f !== 'app.css');

function readStyle(name: string): string {
    return fs.readFileSync(path.join(STYLE_DIR, name), 'utf8');
}

/** The dark theme block in app.css spans from the dark selector to the light selector. */
function darkBlock(appCss: string): string {
    return appCss.slice(appCss.indexOf('[data-theme="dark"]'), appCss.indexOf('[data-theme="light"]'));
}
/** The light theme block onward (only the light block defines tokens after this point). */
function lightBlock(appCss: string): string {
    return appCss.slice(appCss.indexOf('[data-theme="light"]'));
}

describe('accent design token', () => {
    it('defines --accent-color in both dark and light themes', () => {
        const appCss = readStyle('app.css');
        expect(darkBlock(appCss)).toMatch(/--accent-color\s*:/);
        expect(lightBlock(appCss)).toMatch(/--accent-color\s*:/);
    });

    it('defines --accent-rgb in both dark and light themes', () => {
        const appCss = readStyle('app.css');
        expect(darkBlock(appCss)).toMatch(/--accent-rgb\s*:/);
        expect(lightBlock(appCss)).toMatch(/--accent-rgb\s*:/);
    });

    it('has no hardcoded #5b9aff accent literal in any stylesheet', () => {
        for (const file of CONSUMER_CSS_FILES) {
            expect(readStyle(file), `${file} should use var(--accent-color)`).not.toMatch(/#5b9aff/i);
        }
    });

    it('has no hardcoded rgba(91, 154, 255, …) accent literal', () => {
        for (const file of CONSUMER_CSS_FILES) {
            expect(readStyle(file), `${file} should use rgba(var(--accent-rgb), …)`).not.toMatch(
                /rgba\(\s*91\s*,\s*154\s*,\s*255/,
            );
        }
    });

    it('no longer references the undefined --accent alias (consolidated to --accent-color)', () => {
        for (const file of CONSUMER_CSS_FILES) {
            expect(readStyle(file), `${file} should use var(--accent-color)`).not.toMatch(/var\(\s*--accent\s*,/);
        }
    });
});
