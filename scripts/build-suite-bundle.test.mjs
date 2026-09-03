import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
    BUNDLE_MEMBERS,
    bundleName,
    checkManifest,
    collectBundleFiles,
    includeEntry,
    resolveTar,
} from './build-suite-bundle.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));

describe('includeEntry', () => {
    it('keeps suite sources and configs', () => {
        expect(includeEntry('tests/e2e/auth.spec.ts')).toBe(true);
        expect(includeEntry('tests/docker/compose.offline.yml')).toBe(true);
        expect(includeEntry('playwright.config.ts')).toBe(true);
    });

    it('drops build outputs and run artefacts wherever they sit under a member', () => {
        expect(includeEntry('tests/e2e/dist/auth.spec.js')).toBe(false);
        expect(includeEntry('tests/node_modules/x/index.js')).toBe(false);
        expect(includeEntry('tests/e2e/test-results/run.txt')).toBe(false);
        expect(includeEntry('tests/e2e/ws-scrcpy-web.log')).toBe(false);
        expect(includeEntry('tests/e2e/ws-scrcpy-web.log.1')).toBe(false);
        expect(includeEntry('tests/.DS_Store')).toBe(false);
    });
});

describe('bundleName', () => {
    it('names the archive after the package version', () => {
        expect(bundleName('0.1.30-beta.88')).toBe('wssw-suite-0.1.30-beta.88.tar.gz');
    });
});

describe('collectBundleFiles', () => {
    it('lists every member and nothing outside them, sorted', () => {
        const files = collectBundleFiles(REPO);
        expect(files).toEqual([...files].sort());
        for (const member of BUNDLE_MEMBERS) {
            expect(files.some((f) => f === member || f.startsWith(`${member}/`)), member).toBe(true);
        }
        // The runner drives a published image: no app source, no build output.
        expect(files.some((f) => f.startsWith('src/') || f.startsWith('dist/'))).toBe(false);
        expect(files).toContain('tests/e2e/tsconfig.json');
        expect(files).toContain('tsconfig.json');
    });

    it('refuses to build without a member rather than shipping a smaller bundle', () => {
        const fsApi = {
            ...fs,
            statSync: (p, opts) => (p.endsWith('qa-manifest.json') ? undefined : fs.statSync(p, opts)),
        };
        expect(() => collectBundleFiles(REPO, fsApi)).toThrow(/bundle member missing: qa-manifest.json/);
    });
});

describe('checkManifest', () => {
    const pkg = read('package.json');
    const lock = read('package-lock.json');
    const manifest = read('qa-manifest.json');
    const files = collectBundleFiles(REPO);

    it('accepts the committed manifest against the committed lockfile', () => {
        // This is the drift guard: bump @playwright/test and this test names the
        // manifest line to change, before the runner refuses the bundle.
        expect(checkManifest(manifest, { lock, pkg, files })).toEqual([]);
    });

    it('names a Playwright version skew with both versions', () => {
        const skewed = { ...manifest, runner: { ...manifest.runner, playwrightVersion: '1.0.0' } };
        const problems = checkManifest(skewed, { lock, pkg, files });
        expect(problems).toHaveLength(1);
        expect(problems[0]).toMatch(/"1\.0\.0"/);
        expect(problems[0]).toContain(lock.packages['node_modules/@playwright/test'].version);
    });

    it('rejects a suite whose command is not an npm script', () => {
        const bad = { ...manifest, suites: [{ name: 'fast', command: 'npm run no-such-script', services: [] }] };
        expect(checkManifest(bad, { lock, pkg, files })).toEqual([
            expect.stringMatching(/suite 'fast' command "npm run no-such-script" is not an npm script/),
        ]);
    });

    it('rejects a suiteMap entry that points outside the bundle or at an undeclared suite', () => {
        const bad = { ...manifest, suiteMap: { fast: 'src/server', ghost: 'tests/e2e' } };
        const problems = checkManifest(bad, { lock, pkg, files });
        expect(problems).toEqual(
            expect.arrayContaining([
                expect.stringMatching(/suiteMap\.fast -> src\/server is not in the bundle/),
                expect.stringMatching(/suiteMap\.ghost names a suite that is not declared/),
            ]),
        );
    });

    it('rejects an empty suite list and a foreign subject', () => {
        const bad = { ...manifest, subject: 'someone-else', suites: [] };
        const problems = checkManifest(bad, { lock, pkg, files });
        expect(problems).toEqual(
            expect.arrayContaining([expect.stringMatching(/subject must be/), expect.stringMatching(/suites is empty/)]),
        );
    });
});

describe('resolveTar', () => {
    it('uses the System32 bsdtar on Windows and refuses if it is absent — never a bare name', () => {
        expect(resolveTar('win32', (p) => p === 'C:\\Windows\\System32\\tar.exe')).toBe('C:\\Windows\\System32\\tar.exe');
        expect(() => resolveTar('win32', () => false)).toThrow(/System32/);
    });

    it('uses the canonical POSIX tar elsewhere', () => {
        expect(resolveTar('linux', (p) => p === '/usr/bin/tar')).toBe('/usr/bin/tar');
        expect(() => resolveTar('linux', () => false)).toThrow(/canonical system path/);
    });
});
