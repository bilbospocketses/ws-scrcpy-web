import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readVelopackVersion, vpkDir, vpkExePath, vpkVersion } from '../vpk-path.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('readVelopackVersion', () => {
    it('reads the resolved velopack version from a lock', () => {
        const lock = JSON.stringify({
            packages: { 'node_modules/velopack': { version: '1.2.0' } },
        });
        expect(readVelopackVersion(lock)).toBe('1.2.0');
    });

    it('takes the exact resolved version, not the caret range from the manifest', () => {
        // packages[""] carries the DECLARED range (^1.2.0); the vpk CLI needs an
        // exact version, so the resolver must read the node_modules entry.
        const lock = JSON.stringify({
            packages: {
                '': { dependencies: { velopack: '^1.2.0' } },
                'node_modules/velopack': { version: '1.2.3' },
            },
        });
        expect(readVelopackVersion(lock)).toBe('1.2.3');
    });

    it('throws rather than falling back to a hardcoded version', () => {
        expect(() => readVelopackVersion(JSON.stringify({ packages: {} }))).toThrow(/velopack/);
    });
});

describe('vpk paths', () => {
    it('scopes the tool directory by version so a bump cannot reuse a stale install', () => {
        expect(vpkDir('9.9.9').replace(/\\/g, '/')).toMatch(/\/dependencies\/vpk\/v9\.9\.9$/);
    });

    it('resolves to an absolute path inside the repo, never a bare command name', () => {
        const p = vpkExePath('9.9.9').replace(/\\/g, '/');
        expect(p.startsWith(REPO_ROOT.replace(/\\/g, '/'))).toBe(true);
        expect(p).toMatch(/\/dependencies\/vpk\/v9\.9\.9\/vpk(\.exe)?$/);
    });

    it('uses the platform-correct executable name', () => {
        const expected = process.platform === 'win32' ? 'vpk.exe' : 'vpk';
        expect(vpkExePath('9.9.9').split(/[\\/]/).pop()).toBe(expected);
    });

    it('tracks the real package-lock.json velopack version', () => {
        const lock = readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8');
        expect(vpkVersion()).toBe(readVelopackVersion(lock));
    });
});
