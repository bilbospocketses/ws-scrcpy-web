import { describe, expect, it } from 'vitest';
import { decideHttpRequest, type HttpExposure } from './httpExposure';

const MODES: HttpExposure[] = ['open', 'httpsOnly', 'redirect'];

describe('decideHttpRequest', () => {
    it('serves everyone in open mode', () => {
        expect(decideHttpRequest('open', true)).toBe('serve');
        expect(decideHttpRequest('open', false)).toBe('serve');
    });

    it('refuses only NON-loopback callers in httpsOnly', () => {
        expect(decideHttpRequest('httpsOnly', false)).toBe('refuse');
        expect(decideHttpRequest('httpsOnly', true)).toBe('serve');
    });

    it('redirects only NON-loopback callers in redirect mode', () => {
        expect(decideHttpRequest('redirect', false)).toBe('redirect');
        expect(decideHttpRequest('redirect', true)).toBe('serve');
    });

    // THE LOCKOUT GUARANTEE. If this ever fails, a user with a broken
    // certificate cannot reach Settings to turn the mode back off, and the
    // Control Menu integration's /api/whoami loopback probe breaks with it.
    it('NEVER withholds plain HTTP from loopback, in any mode', () => {
        for (const mode of MODES) {
            expect(decideHttpRequest(mode, true)).toBe('serve');
        }
    });

    it('treats an unknown persisted mode as open rather than locking anyone out', () => {
        // The value comes out of the database; a hand-edited or
        // future-version row must not brick access.
        expect(decideHttpRequest('nonsense' as HttpExposure, false)).toBe('serve');
    });
});
