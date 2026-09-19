import type { IncomingMessage, ServerResponse } from 'http';
import { describe, expect, it, vi } from 'vitest';
import { buildRedirectTarget, createHttpRequestHandler } from '../services/HttpServer';
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

/**
 * A secure ("https") entry exists at the given port, unless `noSecureEntry`.
 *
 * Returns `findSpy`, wrapping `servers.find` -- the one call `findHttpsPort()`
 * makes in EVERY case (present, absent, or failed secure entry; every mode).
 * A test asserting `findSpy` was called proves the `if (!serverIsTls) {...}`
 * exposure block actually ran, independent of what it decided -- which is
 * what makes even a "this should just serve" test (open mode, loopback,
 * no-secure-entry) fail if that whole block were deleted. A response-status
 * assertion alone cannot do that for those cases: deleting the block also
 * serves, by falling straight through to the ordinary request gate, so
 * "served" is satisfied by "the feature doesn't exist" just as much as by
 * "the feature correctly decided to serve". See I3 in the review.
 */
function mockConfig(mode: string | undefined, opts: { securePort?: number; noSecureEntry?: boolean } = {}) {
    const servers = opts.noSecureEntry
        ? [{ secure: false, port: 8000 }]
        : [
              { secure: false, port: 8000 },
              { secure: true, port: opts.securePort ?? 8443, options: { cert: 'c', key: 'k' } },
          ];
    const findSpy = vi.fn(servers.find.bind(servers));
    (servers as unknown as { find: typeof findSpy }).find = findSpy;
    vi.mocked(Config.getInstance).mockReturnValue({
        db: { appSettings: { get: vi.fn(() => mode) } },
        servers,
    } as never);
    return findSpy;
}

// I3 (from review): every request below now carries a real `host` header that
// matches its `remoteAddress`, and a "served" outcome is asserted as an exact
// 200 from this fallback -- not merely "not 421" / "not 302". Without a valid
// Host, `evaluateHttpRequest`'s own DNS-rebinding gate 403s the request before
// this feature's code is ever reached, which is precisely how five of this
// file's eight tests previously passed with the entire exposure block
// deleted (including the headline loopback lockout-guarantee test). A bare
// negative assertion is satisfied by ANY earlier failure, including that one;
// asserting the specific positive outcome is not.
const SERVED = { status: 200, body: 'served' };
function servedFallback(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(SERVED.status);
    res.end(SERVED.body);
}

// The handler is built with serverIsTls=false, i.e. the PLAIN-HTTP listener.
function plainHandler(mode: string, opts?: { securePort?: number; noSecureEntry?: boolean }) {
    const findSpy = mockConfig(mode, opts);
    return { handler: createHttpRequestHandler([], servedFallback, false), findSpy };
}

describe('plain-HTTP listener under each exposure mode', () => {
    it('serves a LAN caller in open mode', async () => {
        const { handler, findSpy } = plainHandler('open');
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await handler(r.req, r.res);
        expect(r.getStatus()).toBe(SERVED.status);
        expect(findSpy).toHaveBeenCalled();
    });

    it('refuses a LAN caller in httpsOnly', async () => {
        const { handler, findSpy } = plainHandler('httpsOnly');
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await handler(r.req, r.res);
        expect(r.getStatus()).toBe(421);
        // M2: closes amendment D's cache-poisoning concern against a
        // non-conforming intermediary caching this response past the user
        // turning the setting back off.
        expect(r.getHeader('cache-control')).toBe('no-store');
        expect(findSpy).toHaveBeenCalled();
    });

    it('redirects a LAN caller in redirect mode', async () => {
        const { handler, findSpy } = plainHandler('redirect', { securePort: 8443 });
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await handler(r.req, r.res);
        expect(r.getStatus()).toBe(302);
        expect(r.getHeader('location')).toMatch(/^https:/);
        expect(r.getHeader('location')).toBe('https://192.168.86.50:8443/');
        expect(r.getHeader('cache-control')).toBe('no-store');
        expect(findSpy).toHaveBeenCalled();
    });

    it('SERVES LOOPBACK IN EVERY MODE — the lockout guarantee', async () => {
        for (const mode of ['open', 'httpsOnly', 'redirect']) {
            const { handler, findSpy } = plainHandler(mode);
            const r = makeReqRes('GET', '/', undefined, { host: '127.0.0.1:8000' }, { remoteAddress: '127.0.0.1' });
            await handler(r.req, r.res);
            expect(r.getStatus(), `mode ${mode}`).toBe(SERVED.status);
            // The load-bearing half of this test: a valid Host plus a 200
            // fallback means "served" alone is satisfied by the exposure
            // block being deleted entirely (it falls straight through to
            // the ordinary request gate). This proves the block RAN and
            // reached the point of consulting the configured servers for
            // every mode, not merely that the response happened to come out
            // as 200 some other way.
            expect(findSpy, `mode ${mode}`).toHaveBeenCalled();
        }
    });

    // Amendment C (load-bearing): with no secure server entry at all, there is
    // no HTTPS listener to refuse toward or redirect toward. Every mode must
    // serve, or the setting locks the user out of the only listener that
    // exists -- including the one that hosts the Settings page to undo it.
    it('serves a LAN caller in httpsOnly when there is no secure server entry', async () => {
        const { handler, findSpy } = plainHandler('httpsOnly', { noSecureEntry: true });
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await handler(r.req, r.res);
        expect(r.getStatus()).toBe(SERVED.status);
        expect(findSpy).toHaveBeenCalled();
    });

    it('serves a LAN caller in redirect when there is no secure server entry', async () => {
        const { handler, findSpy } = plainHandler('redirect', { noSecureEntry: true });
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await handler(r.req, r.res);
        expect(r.getStatus()).toBe(SERVED.status);
        expect(findSpy).toHaveBeenCalled();
    });

    // C1 (Critical, from review): the OLD charset-only check accepted any
    // plain DNS name, so `Host: evil.com` produced `Location:
    // https://evil.com:8443/` -- an open redirect. The fix reuses
    // `isHostAllowed`, the app's own Host allowlist, so a disallowed Host is
    // *also* independently rejected by the downstream request gate -- by
    // design, both consult the same policy so they can't drift apart (see
    // buildRedirectTarget's own tests below for a version of this that isn't
    // entangled with that downstream gate). What this test pins at the
    // full-handler level: no Location is ever emitted, and the final
    // response is the SPECIFIC 403 the shared Host policy produces, not some
    // other failure that happens to also not be 302.
    it('never redirects to a disallowed Host, and the request is independently refused', async () => {
        const { handler, findSpy } = plainHandler('redirect', { securePort: 8443 });
        const r = makeReqRes(
            'GET',
            '/',
            undefined,
            { host: 'evil.example.com/\r\nSet-Cookie:%20pwned=1' },
            { remoteAddress: '192.168.86.50' },
        );
        await handler(r.req, r.res);
        expect(r.getHeader('location')).toBeUndefined();
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toMatchObject({ error: 'forbidden', reason: 'host not allowed (possible DNS rebinding)' });
        expect(findSpy).toHaveBeenCalled();
    });

    it('strips a port from Host and preserves path+query in the redirect target', async () => {
        const { handler, findSpy } = plainHandler('redirect', { securePort: 9443 });
        const r = makeReqRes(
            'GET',
            '/foo?bar=1',
            undefined,
            { host: '192.168.86.50:8000' },
            { remoteAddress: '192.168.86.50' },
        );
        await handler(r.req, r.res);
        expect(r.getStatus()).toBe(302);
        expect(r.getHeader('location')).toBe('https://192.168.86.50:9443/foo?bar=1');
        expect(findSpy).toHaveBeenCalled();
    });
});

// These drive buildRedirectTarget directly -- a pure function, no Config or
// request-gate involvement -- specifically so the open-redirect defense (C1),
// the IPv6 fix (I1), the userinfo fix (M4) and the request-target fix (M1)
// each have a proof that fails ONLY when that function's own logic regresses,
// not one that's equally satisfied by an unrelated downstream gate. Every
// case below states which production line it pins.
describe('buildRedirectTarget', () => {
    it('builds a target for an allowed IP-literal Host', () => {
        expect(buildRedirectTarget('192.168.86.50:8000', '/', 8443)).toBe('https://192.168.86.50:8443/');
    });

    // C1: pins that redirectHostname's `isHostAllowed` call is load-bearing --
    // delete it (revert to a charset-only check) and this starts returning a
    // Location for a plain DNS name.
    it('refuses a plain DNS name the app would not otherwise serve (C1 — open redirect)', () => {
        expect(buildRedirectTarget('evil.com', '/', 8443)).toBeUndefined();
    });

    // I1: pins that an IPv6 literal is (a) recognised as allowed at all via
    // the shared `hostnameOf`/`isHostAllowed` parse, and (b) re-bracketed
    // when composing the authority -- delete the `.includes(':')` bracketing
    // and this starts producing an unparseable `https://2601:abc::5:8443/`.
    it('accepts and bracket-encodes an IPv6-literal Host (I1)', () => {
        expect(buildRedirectTarget('[2601:abc::5]:8000', '/', 8443)).toBe('https://[2601:abc::5]:8443/');
    });

    // M4: pins that a userinfo prefix is parsed as userinfo, not folded into
    // the hostname -- the old `split(':')[0]` extracted the nonsense
    // hostname `user`; this checks both that the disallowed case behind an
    // userinfo prefix still refuses, AND that an ALLOWED host behind one
    // still redirects to the real host, not to `user`.
    it('parses past a userinfo prefix rather than treating it as the hostname (M4)', () => {
        expect(buildRedirectTarget('user:pass@evil.com', '/', 8443)).toBeUndefined();
        expect(buildRedirectTarget('user:pass@192.168.86.50', '/', 8443)).toBe('https://192.168.86.50:8443/');
    });

    // M1: pins that a non-origin-form request-target (absolute-form, as a
    // proxy sends; asterisk-form, from `OPTIONS *`) falls back to `/` rather
    // than landing in the Location verbatim and producing a malformed
    // authority (`https://host:port*` / a scheme-doubled URL).
    it('falls back to / for a non-origin-form request-target (M1)', () => {
        expect(buildRedirectTarget('192.168.86.50:8000', 'http://evil.com/x', 8443)).toBe(
            'https://192.168.86.50:8443/',
        );
        expect(buildRedirectTarget('192.168.86.50:8000', '*', 8443)).toBe('https://192.168.86.50:8443/');
    });

    it('preserves an origin-form path and query untouched', () => {
        expect(buildRedirectTarget('192.168.86.50:8000', '/foo?bar=1', 8443)).toBe(
            'https://192.168.86.50:8443/foo?bar=1',
        );
    });
});
