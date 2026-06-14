import { describe, expect, it } from 'vitest';
import { isRequestAllowed, requiresOriginCheck } from './originGuard';

describe('originGuard.isRequestAllowed', () => {
    describe('Host allowlist (DNS-rebinding defense)', () => {
        it('allows a same-origin request to a localhost host', () => {
            expect(isRequestAllowed('http://localhost:8000', 'localhost:8000').allowed).toBe(true);
        });

        it('allows a same-origin request to an IPv4-literal LAN host', () => {
            expect(isRequestAllowed('http://192.168.1.5:8000', '192.168.1.5:8000').allowed).toBe(true);
        });

        it('allows an IPv6-literal localhost host', () => {
            expect(isRequestAllowed('http://[::1]:8000', '[::1]:8000').allowed).toBe(true);
        });

        it('rejects a request whose Host is a non-IP domain (DNS rebinding)', () => {
            const result = isRequestAllowed('http://evil.com', 'evil.com');
            expect(result.allowed).toBe(false);
            expect(result.reason).toMatch(/host/i);
        });

        it('rejects a rebinding domain even when Origin equals Host', () => {
            // The classic DNS-rebinding case: attacker.example resolves to 127.0.0.1,
            // so Origin === Host and a naive same-origin check would pass.
            expect(isRequestAllowed('http://attacker.example', 'attacker.example').allowed).toBe(false);
        });

        it('rejects when the Host header is missing', () => {
            expect(isRequestAllowed(undefined, undefined).allowed).toBe(false);
        });

        it('rejects a malformed Host header', () => {
            expect(isRequestAllowed(undefined, 'not a valid host!!').allowed).toBe(false);
        });
    });

    describe('Origin match (CSRF defense)', () => {
        it('rejects a cross-origin request (Origin does not match Host)', () => {
            const result = isRequestAllowed('http://evil.com', 'localhost:8000');
            expect(result.allowed).toBe(false);
            expect(result.reason).toMatch(/origin/i);
        });

        it('rejects an Origin with a mismatched port', () => {
            expect(isRequestAllowed('http://localhost:9999', 'localhost:8000').allowed).toBe(false);
        });

        it('allows a request with no Origin header to an allowed host (non-browser / same-origin GET)', () => {
            expect(isRequestAllowed(undefined, 'localhost:8000').allowed).toBe(true);
        });

        it('matches an https Origin to the host', () => {
            expect(isRequestAllowed('https://localhost:8443', 'localhost:8443').allowed).toBe(true);
        });

        it('matches a default-port Origin to a port-less Host', () => {
            expect(isRequestAllowed('http://localhost', 'localhost').allowed).toBe(true);
        });

        it('rejects the opaque "null" Origin (sandboxed iframe / file://)', () => {
            const result = isRequestAllowed('null', 'localhost:8000');
            expect(result.allowed).toBe(false);
            expect(result.reason).toMatch(/origin/i);
        });

        it('is case-insensitive on the host portion', () => {
            expect(isRequestAllowed('http://LOCALHOST:8000', 'localhost:8000').allowed).toBe(true);
        });
    });
});

describe('originGuard.requiresOriginCheck', () => {
    it('gates API GET requests (DNS-rebinding data exfiltration)', () => {
        expect(requiresOriginCheck('GET', '/api/devices')).toBe(true);
    });

    it('gates the /api root exactly', () => {
        expect(requiresOriginCheck('GET', '/api')).toBe(true);
    });

    it('gates state-changing methods on any path', () => {
        expect(requiresOriginCheck('POST', '/anything')).toBe(true);
        expect(requiresOriginCheck('DELETE', '/')).toBe(true);
        expect(requiresOriginCheck('PATCH', '/api/config')).toBe(true);
        expect(requiresOriginCheck('PUT', '/api/config')).toBe(true);
    });

    it('does NOT gate safe static asset GET/HEAD requests (so the page can bootstrap)', () => {
        expect(requiresOriginCheck('GET', '/')).toBe(false);
        expect(requiresOriginCheck('GET', '/index.html')).toBe(false);
        expect(requiresOriginCheck('GET', '/bundle.js')).toBe(false);
        expect(requiresOriginCheck('HEAD', '/style.css')).toBe(false);
    });

    it('treats an unknown/missing method as unsafe', () => {
        expect(requiresOriginCheck(undefined, '/')).toBe(true);
    });

    it('does not mistake a path that merely starts with "api" for the API surface', () => {
        expect(requiresOriginCheck('GET', '/apiary.html')).toBe(false);
    });
});
