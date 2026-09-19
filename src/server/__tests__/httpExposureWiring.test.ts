import { describe, expect, it, vi } from 'vitest';
import { createHttpRequestHandler } from '../services/HttpServer';
import { makeReqRes } from './helpers/httpMock';

// Amendment A: no `__TEST_*` global. Config is mocked directly, and the
// handler reads the exposure mode exactly the way production does --
// `Config.getInstance().db.appSettings.get(HTTP_EXPOSURE_KEY)` -- so this
// test exercises the real read path instead of a side channel invisible to
// anyone reading HttpServer.ts.
vi.mock('../Config', () => ({
    Config: { getInstance: vi.fn() },
    DEFAULT_HTTPS_PORT: 8443,
}));

import { Config } from '../Config';

/** A secure ("https") entry exists at the given port, unless `noSecureEntry`. */
function mockConfig(mode: string | undefined, opts: { securePort?: number; noSecureEntry?: boolean } = {}) {
    const servers = opts.noSecureEntry
        ? [{ secure: false, port: 8000 }]
        : [
              { secure: false, port: 8000 },
              { secure: true, port: opts.securePort ?? 8443, options: { cert: 'c', key: 'k' } },
          ];
    vi.mocked(Config.getInstance).mockReturnValue({
        db: { appSettings: { get: vi.fn(() => mode) } },
        servers,
    } as never);
}

// The handler is built with serverIsTls=false, i.e. the PLAIN-HTTP listener.
function plainHandler(mode: string, opts?: { securePort?: number; noSecureEntry?: boolean }) {
    mockConfig(mode, opts);
    return createHttpRequestHandler([], () => {}, false);
}

describe('plain-HTTP listener under each exposure mode', () => {
    it('serves a LAN caller in open mode', async () => {
        const h = plainHandler('open');
        const r = makeReqRes('GET', '/', undefined, {}, { remoteAddress: '192.168.86.50' });
        await h(r.req, r.res);
        expect(r.getStatus()).not.toBe(421);
    });

    it('refuses a LAN caller in httpsOnly', async () => {
        const h = plainHandler('httpsOnly');
        const r = makeReqRes('GET', '/', undefined, {}, { remoteAddress: '192.168.86.50' });
        await h(r.req, r.res);
        expect(r.getStatus()).toBe(421);
    });

    it('redirects a LAN caller in redirect mode', async () => {
        const h = plainHandler('redirect', { securePort: 8443 });
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await h(r.req, r.res);
        expect(r.getStatus()).toBe(302);
        expect(r.getHeader('location')).toMatch(/^https:/);
        expect(r.getHeader('location')).toBe('https://192.168.86.50:8443/');
    });

    it('SERVES LOOPBACK IN EVERY MODE — the lockout guarantee', async () => {
        for (const mode of ['open', 'httpsOnly', 'redirect']) {
            const h = plainHandler(mode);
            const r = makeReqRes('GET', '/', undefined, {}, { remoteAddress: '127.0.0.1' });
            await h(r.req, r.res);
            expect(r.getStatus(), `mode ${mode}`).not.toBe(421);
            expect(r.getStatus(), `mode ${mode}`).not.toBe(302);
        }
    });

    // Amendment C (load-bearing): with no secure server entry at all, there is
    // no HTTPS listener to refuse toward or redirect toward. Every mode must
    // serve, or the setting locks the user out of the only listener that
    // exists -- including the one that hosts the Settings page to undo it.
    it('serves a LAN caller in httpsOnly when there is no secure server entry', async () => {
        const h = plainHandler('httpsOnly', { noSecureEntry: true });
        const r = makeReqRes('GET', '/', undefined, {}, { remoteAddress: '192.168.86.50' });
        await h(r.req, r.res);
        expect(r.getStatus()).not.toBe(421);
    });

    it('serves a LAN caller in redirect when there is no secure server entry', async () => {
        const h = plainHandler('redirect', { noSecureEntry: true });
        const r = makeReqRes('GET', '/', undefined, {}, { remoteAddress: '192.168.86.50' });
        await h(r.req, r.res);
        expect(r.getStatus()).not.toBe(302);
    });

    // Amendment D (load-bearing, security): the redirect target must never be
    // built from a caller-controlled Host header verbatim -- that is a
    // host-header injection into a cached 302. An invalid/hostile Host must
    // fall back to serving, not to emitting an attacker-chosen Location.
    it('serves instead of redirecting when Host is not a plain hostname', async () => {
        const h = plainHandler('redirect', { securePort: 8443 });
        const r = makeReqRes(
            'GET',
            '/',
            undefined,
            { host: 'evil.example.com/\r\nSet-Cookie:%20pwned=1' },
            { remoteAddress: '192.168.86.50' },
        );
        await h(r.req, r.res);
        expect(r.getStatus()).not.toBe(302);
        expect(r.getHeader('location')).toBeUndefined();
    });

    it('strips a port from Host and preserves path+query in the redirect target', async () => {
        const h = plainHandler('redirect', { securePort: 9443 });
        const r = makeReqRes(
            'GET',
            '/foo?bar=1',
            undefined,
            { host: '192.168.86.50:8000' },
            { remoteAddress: '192.168.86.50' },
        );
        await h(r.req, r.res);
        expect(r.getStatus()).toBe(302);
        expect(r.getHeader('location')).toBe('https://192.168.86.50:9443/foo?bar=1');
    });
});
