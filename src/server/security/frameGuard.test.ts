import { afterEach, describe, expect, it } from 'vitest';
import { securityHeaders, setFrameAncestors } from './frameGuard';

describe('frameGuard.securityHeaders', () => {
    // setFrameAncestors mutates module-level state; restore the default
    // (same-origin only) after every test so the rest of the suite — and
    // re-runs — see pristine state.
    afterEach(() => {
        setFrameAncestors([]);
    });

    it('sends nosniff and SAMEORIGIN, and no CSP, by default', () => {
        const headers = securityHeaders();

        expect(headers['X-Content-Type-Options']).toBe('nosniff');
        expect(headers['X-Frame-Options']).toBe('SAMEORIGIN');
        expect(headers['Content-Security-Policy']).toBeUndefined();
    });

    it('adds frame-ancestors for a configured origin', () => {
        setFrameAncestors(['http://localhost:5159']);

        expect(securityHeaders()['Content-Security-Policy']).toBe("frame-ancestors 'self' http://localhost:5159");
    });

    it('keeps X-Frame-Options alongside the CSP', () => {
        setFrameAncestors(['http://localhost:5159']);

        // Both are sent on purpose: a browser supporting frame-ancestors must
        // ignore X-Frame-Options when both are present (CSP Level 2), so the
        // allowlist wins where it is understood and older browsers keep the
        // stricter behaviour.
        expect(securityHeaders()['X-Frame-Options']).toBe('SAMEORIGIN');
    });

    it('space-joins multiple origins after self', () => {
        setFrameAncestors(['http://localhost:5159', 'https://tools.example.com']);

        expect(securityHeaders()['Content-Security-Policy']).toBe(
            "frame-ancestors 'self' http://localhost:5159 https://tools.example.com",
        );
    });

    it('ignores blank and whitespace-only entries', () => {
        setFrameAncestors(['  ', '', 'http://localhost:5159']);

        expect(securityHeaders()['Content-Security-Policy']).toBe("frame-ancestors 'self' http://localhost:5159");
    });

    it('restores the default same-origin-only policy when set to an empty list', () => {
        setFrameAncestors(['http://localhost:5159']);
        setFrameAncestors([]);

        expect(securityHeaders()['Content-Security-Policy']).toBeUndefined();
    });

    it('returns a fresh object each call so callers cannot mutate the policy', () => {
        const first = securityHeaders();
        first['X-Frame-Options'] = 'TAMPERED';

        expect(securityHeaders()['X-Frame-Options']).toBe('SAMEORIGIN');
    });
});
