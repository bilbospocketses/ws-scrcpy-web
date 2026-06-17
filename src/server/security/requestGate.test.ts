import { describe, expect, it } from 'vitest';
import { getInstanceToken } from './instanceToken';
import { evaluateHttpRequest, evaluateWsConnection } from './requestGate';

const COOKIE = `ws_scrcpy_token=${getInstanceToken()}`;

describe('requestGate.evaluateHttpRequest', () => {
    it('rejects a cross-origin API request with 403', () => {
        const d = evaluateHttpRequest(
            'POST',
            '/api/service/install',
            'http://evil.com',
            'localhost:8000',
            COOKIE,
            false,
        );
        expect(d.allowed).toBe(false);
        expect(d).toMatchObject({ status: 403 });
    });

    it('rejects a same-origin API request that carries no token', () => {
        const d = evaluateHttpRequest(
            'GET',
            '/api/devices',
            'http://localhost:8000',
            'localhost:8000',
            undefined,
            false,
        );
        expect(d.allowed).toBe(false);
    });

    it('allows a same-origin API request carrying the valid token', () => {
        const d = evaluateHttpRequest('GET', '/api/devices', 'http://localhost:8000', 'localhost:8000', COOKIE, false);
        expect(d.allowed).toBe(true);
    });

    it('allows the launcher GET /api/config probe with no Origin and no token', () => {
        const d = evaluateHttpRequest('GET', '/api/config', undefined, 'localhost', undefined, false);
        expect(d.allowed).toBe(true);
    });

    it('rejects a DNS-rebinding Host even on a document request', () => {
        const d = evaluateHttpRequest('GET', '/', 'http://evil.com', 'evil.com', undefined, false);
        expect(d.allowed).toBe(false);
    });

    it('serves a document request and attaches the token cookie', () => {
        const d = evaluateHttpRequest('GET', '/', undefined, 'localhost:8000', undefined, false);
        expect(d.allowed).toBe(true);
        if (d.allowed) {
            expect(d.setCookie).toContain('ws_scrcpy_token=');
            expect(d.setCookie).toContain('SameSite=Strict');
        }
    });

    it('does not attach a cookie to static asset responses', () => {
        const d = evaluateHttpRequest('GET', '/bundle.js', undefined, 'localhost:8000', COOKIE, false);
        expect(d.allowed).toBe(true);
        if (d.allowed) {
            expect(d.setCookie).toBeUndefined();
        }
    });

    it('marks the cookie Secure on secure connections', () => {
        const d = evaluateHttpRequest('GET', '/', undefined, 'localhost:8443', undefined, true);
        if (d.allowed) {
            expect(d.setCookie).toContain('Secure');
        }
    });
});

describe('requestGate.evaluateWsConnection', () => {
    it('rejects a cross-origin WS handshake', () => {
        expect(evaluateWsConnection('http://evil.com', 'localhost:8000', COOKIE).allowed).toBe(false);
    });

    it('rejects a same-origin WS handshake with no token', () => {
        expect(evaluateWsConnection('http://localhost:8000', 'localhost:8000', undefined).allowed).toBe(false);
    });

    it('allows a same-origin WS handshake carrying the valid token', () => {
        expect(evaluateWsConnection('http://localhost:8000', 'localhost:8000', COOKIE).allowed).toBe(true);
    });
});
