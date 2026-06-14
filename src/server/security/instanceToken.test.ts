import { describe, expect, it } from 'vitest';
import {
    buildTokenCookie,
    getInstanceToken,
    isValidToken,
    parseTokenFromCookie,
    requiresToken,
    shouldSetTokenCookie,
} from './instanceToken';

describe('instanceToken', () => {
    describe('getInstanceToken', () => {
        it('returns a stable 256-bit hex token within the process', () => {
            const a = getInstanceToken();
            expect(a).toMatch(/^[a-f0-9]{64}$/);
            expect(getInstanceToken()).toBe(a);
        });
    });

    describe('isValidToken', () => {
        it('accepts the instance token', () => {
            expect(isValidToken(getInstanceToken())).toBe(true);
        });

        it('rejects a wrong value of the same length', () => {
            expect(isValidToken('a'.repeat(64))).toBe(false);
        });

        it('rejects empty / null / undefined', () => {
            expect(isValidToken('')).toBe(false);
            expect(isValidToken(null)).toBe(false);
            expect(isValidToken(undefined)).toBe(false);
        });

        it('rejects a value of the wrong length', () => {
            expect(isValidToken('abc')).toBe(false);
        });
    });

    describe('parseTokenFromCookie', () => {
        it('extracts the token from a single-cookie header', () => {
            expect(parseTokenFromCookie('ws_scrcpy_token=abc123')).toBe('abc123');
        });

        it('extracts the token among multiple cookies with whitespace', () => {
            expect(parseTokenFromCookie('foo=1; ws_scrcpy_token=abc123; bar=2')).toBe('abc123');
        });

        it('returns null when the cookie is absent', () => {
            expect(parseTokenFromCookie('foo=1; bar=2')).toBeNull();
            expect(parseTokenFromCookie(undefined)).toBeNull();
        });
    });

    describe('buildTokenCookie', () => {
        it('builds a hardened SameSite=Strict, HttpOnly cookie', () => {
            const cookie = buildTokenCookie(false);
            expect(cookie).toContain(`ws_scrcpy_token=${getInstanceToken()}`);
            expect(cookie).toContain('Path=/');
            expect(cookie).toContain('SameSite=Strict');
            expect(cookie).toContain('HttpOnly');
            expect(cookie).not.toContain('Secure');
        });

        it('adds the Secure attribute on secure connections', () => {
            expect(buildTokenCookie(true)).toContain('Secure');
        });
    });

    describe('requiresToken', () => {
        it('requires a token on sensitive API endpoints', () => {
            expect(requiresToken('POST', '/api/service/install')).toBe(true);
            expect(requiresToken('GET', '/api/devices')).toBe(true);
            expect(requiresToken('PATCH', '/api/config')).toBe(true);
            expect(requiresToken('POST', '/api/server/shutdown')).toBe(true);
        });

        it('exempts the launcher GET /api/config upgrade probe', () => {
            expect(requiresToken('GET', '/api/config')).toBe(false);
            expect(requiresToken('HEAD', '/api/config')).toBe(false);
        });

        it('does not require a token for static (non-API) requests', () => {
            expect(requiresToken('GET', '/')).toBe(false);
            expect(requiresToken('GET', '/bundle.js')).toBe(false);
        });
    });

    describe('shouldSetTokenCookie', () => {
        it('sets the cookie on document responses so the SPA can bootstrap', () => {
            expect(shouldSetTokenCookie('GET', '/')).toBe(true);
            expect(shouldSetTokenCookie('GET', '/index.html')).toBe(true);
            expect(shouldSetTokenCookie('GET', '/devices/abc')).toBe(true);
        });

        it('does not set the cookie on static assets or API responses', () => {
            expect(shouldSetTokenCookie('GET', '/bundle.js')).toBe(false);
            expect(shouldSetTokenCookie('GET', '/style.css')).toBe(false);
            expect(shouldSetTokenCookie('GET', '/api/config')).toBe(false);
        });

        it('does not set the cookie on non-GET requests', () => {
            expect(shouldSetTokenCookie('POST', '/')).toBe(false);
        });
    });
});
