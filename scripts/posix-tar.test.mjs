import { describe, expect, it } from 'vitest';
import { POSIX_TAR_CANDIDATES, resolvePosixTar } from './posix-tar.mjs';

// `existsSync` is injected so these run on any host (incl. Windows CI) without
// touching the real filesystem or the real tar.
describe('resolvePosixTar', () => {
    it('returns /usr/bin/tar when it exists (preferred candidate)', () => {
        expect(resolvePosixTar((p) => p === '/usr/bin/tar')).toBe('/usr/bin/tar');
    });

    it('falls back to /bin/tar when /usr/bin/tar is absent', () => {
        expect(resolvePosixTar((p) => p === '/bin/tar')).toBe('/bin/tar');
    });

    it('prefers /usr/bin/tar over /bin/tar when both exist', () => {
        expect(resolvePosixTar(() => true)).toBe('/usr/bin/tar');
    });

    it('throws (no $PATH fallback) when tar is at no canonical path', () => {
        expect(() => resolvePosixTar(() => false)).toThrow(/canonical system path/);
    });

    it('lists only absolute canonical paths — never a bare name resolved via $PATH', () => {
        expect(POSIX_TAR_CANDIDATES.length).toBeGreaterThan(0);
        for (const candidate of POSIX_TAR_CANDIDATES) {
            expect(candidate.startsWith('/')).toBe(true);
        }
    });
});
