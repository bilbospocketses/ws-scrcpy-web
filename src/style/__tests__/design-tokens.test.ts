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

describe('status color tokens (danger / success)', () => {
    it('defines --danger-rgb and --success-rgb in both themes', () => {
        const appCss = readStyle('app.css');
        expect(darkBlock(appCss)).toMatch(/--danger-rgb\s*:/);
        expect(lightBlock(appCss)).toMatch(/--danger-rgb\s*:/);
        expect(darkBlock(appCss)).toMatch(/--success-rgb\s*:/);
        expect(lightBlock(appCss)).toMatch(/--success-rgb\s*:/);
    });

    it('has no hardcoded danger-red literals in consumer stylesheets', () => {
        for (const file of CONSUMER_CSS_FILES) {
            const css = readStyle(file);
            expect(css, `${file}: #f06c75`).not.toMatch(/#f06c75/i);
            expect(css, `${file}: #ff6b6b`).not.toMatch(/#ff6b6b/i);
            expect(css, `${file}: #f87171`).not.toMatch(/#f87171/i);
            expect(css, `${file}: rgba(240,108,117,…)`).not.toMatch(/rgba\(\s*240\s*,\s*108\s*,\s*117/);
        }
    });

    it('has no hardcoded success-green literals in consumer stylesheets', () => {
        for (const file of CONSUMER_CSS_FILES) {
            const css = readStyle(file);
            expect(css, `${file}: #4ade80`).not.toMatch(/#4ade80/i);
            expect(css, `${file}: #4caf50`).not.toMatch(/#4caf50/i);
            expect(css, `${file}: rgba(76,175,80,…)`).not.toMatch(/rgba\(\s*76\s*,\s*175\s*,\s*80/);
            expect(css, `${file}: rgba(74,222,128,…)`).not.toMatch(/rgba\(\s*74\s*,\s*222\s*,\s*128/);
        }
    });

    it('no longer references the undefined --error-color alias (consolidated to --danger-color)', () => {
        for (const file of CONSUMER_CSS_FILES) {
            expect(readStyle(file), `${file}: var(--error-color, …)`).not.toMatch(/var\(\s*--error-color\s*,/);
        }
    });
});
