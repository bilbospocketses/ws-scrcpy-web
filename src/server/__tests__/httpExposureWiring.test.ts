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

// I3 (from review round 1): every request below carries a real `host` header
// that matches its `remoteAddress`, and a "served" outcome is asserted as an
// exact 200 from this fallback -- not merely "not 421" / "not 302". Without a
// valid Host, `evaluateHttpRequest`'s own DNS-rebinding gate 403s the request
// before this feature's code is ever reached, which is precisely how five of
// this file's eight tests originally passed with the entire exposure block
// deleted (including the headline loopback lockout-guarantee test).
const SERVED = { status: 200, body: 'served' };
function servedFallback(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(SERVED.status);
    res.end(SERVED.body);
}

// The handler is built with serverIsTls=false, i.e. the PLAIN-HTTP listener.
function plainHandler(mode: string, opts?: { securePort?: number; noSecureEntry?: boolean }) {
    mockConfig(mode, opts);
    return createHttpRequestHandler([], servedFallback, false);
}

// I3, round 2 (re-review): round 1 fixed the tests above by asserting the
// EXACT status instead of a negative ("not 421"), plus a spy on
// `Config.servers.find` to prove the exposure block ran at all. The
// re-reviewer measured that the spy closes only the "whole block deleted"
// mutation -- a mutant that runs the block and then reaches the WRONG
// verdict (e.g. `decideHttpRequest` wrongly serving a LAN caller in
// `httpsOnly`) still calls `servers.find`, so the spy stays green. It is
// also coupled to an implementation detail: refactor `findHttpsPort` to stop
// calling `.find` (a loop, a cache, `.filter`) and all eight tests go red
// for a reason that has nothing to do with behaviour.
//
// The durable fix, per the controller: a CONTRAST PAIR. Assert the same
// request under two configurations the feature is supposed to tell apart,
// so deleting the feature (or getting the verdict wrong) collapses the pair
// and the test fails on STATUS alone -- no spy, no implementation coupling.
// Below, "serves a LAN caller in open mode" and "refuses a LAN caller in
// httpsOnly" are themselves a pair (same LAN Host, two modes, two outcomes);
// so are "redirects a LAN caller in redirect mode" and the no-secure-entry
// tests below it (same mode, with vs. without a secure entry). The spy and
// its `servers.find` monkey-patch are gone; nothing in this file is a
// substitute for a status assertion any more.
describe('plain-HTTP listener under each exposure mode', () => {
    it('serves a LAN caller in open mode', async () => {
        const h = plainHandler('open');
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await h(r.req, r.res);
        expect(r.getStatus()).toBe(SERVED.status);
    });

    // Pairs with the test above: same LAN Host, `httpsOnly` instead of
    // `open`. Delete the exposure block (or decide the mode wrong) and BOTH
    // this test and the one above collapse to the same 200 -- this is what
    // makes the pair, not either half alone, fail on that mutation.
    it('refuses a LAN caller in httpsOnly', async () => {
        const h = plainHandler('httpsOnly');
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await h(r.req, r.res);
        expect(r.getStatus()).toBe(421);
        // M2: closes amendment D's cache-poisoning concern against a
        // non-conforming intermediary caching this response past the user
        // turning the setting back off.
        expect(r.getHeader('cache-control')).toBe('no-store');
    });

    // Pairs with the same two tests: same LAN Host, `redirect` instead.
    it('redirects a LAN caller in redirect mode', async () => {
        const h = plainHandler('redirect', { securePort: 8443 });
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await h(r.req, r.res);
        expect(r.getStatus()).toBe(302);
        expect(r.getHeader('location')).toMatch(/^https:/);
        expect(r.getHeader('location')).toBe('https://192.168.86.50:8443/');
        expect(r.getHeader('cache-control')).toBe('no-store');
    });

    // The lockout guarantee, made self-contained: for each mode, the SAME
    // request from loopback vs. from a LAN address must come out different
    // whenever the mode narrows anything. Deleting the exposure block makes
    // every LAN case in this loop serve too (200), collapsing every pair
    // below and failing the `httpsOnly`/`redirect` cases on status alone --
    // no spy needed. (The `open` iteration has no narrowing to contrast
    // against by design; loopback and LAN legitimately produce the same
    // outcome there, exactly as they would with no feature at all -- the
    // `httpsOnly` and `redirect` iterations are what make this test able to
    // fail.)
    it('SERVES LOOPBACK IN EVERY MODE — the lockout guarantee', async () => {
        const lanOutcome: Record<string, { status: number; location?: string }> = {
            open: { status: SERVED.status },
            httpsOnly: { status: 421 },
            redirect: { status: 302, location: 'https://192.168.86.50:8443/' },
        };
        for (const mode of ['open', 'httpsOnly', 'redirect']) {
            const loopback = plainHandler(mode, { securePort: 8443 });
            const rLoopback = makeReqRes(
                'GET',
                '/',
                undefined,
                { host: '127.0.0.1:8000' },
                { remoteAddress: '127.0.0.1' },
            );
            await loopback(rLoopback.req, rLoopback.res);
            expect(rLoopback.getStatus(), `loopback, mode ${mode}`).toBe(SERVED.status);

            const lan = plainHandler(mode, { securePort: 8443 });
            const rLan = makeReqRes(
                'GET',
                '/',
                undefined,
                { host: '192.168.86.50:8000' },
                { remoteAddress: '192.168.86.50' },
            );
            await lan(rLan.req, rLan.res);
            const expected = lanOutcome[mode];
            expect(rLan.getStatus(), `LAN, mode ${mode}`).toBe(expected?.status);
            if (expected?.location) {
                expect(rLan.getHeader('location'), `LAN, mode ${mode}`).toBe(expected.location);
            }
        }
    });

    // Amendment C (load-bearing): with no secure server entry at all, there is
    // no HTTPS listener to refuse toward or redirect toward. Every mode must
    // serve, or the setting locks the user out of the only listener that
    // exists -- including the one that hosts the Settings page to undo it.
    //
    // Pairs with "refuses a LAN caller in httpsOnly" above (same mode, same
    // LAN Host, WITH a secure entry -> 421): deleting either the whole
    // exposure block or just the no-secure-entry fail-open collapses this
    // test to the SAME 200 either way, but pairing it against the
    // with-secure-entry case is what proves the mode itself still narrows
    // when there IS something to narrow toward.
    it('serves a LAN caller in httpsOnly when there is no secure server entry', async () => {
        const h = plainHandler('httpsOnly', { noSecureEntry: true });
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await h(r.req, r.res);
        expect(r.getStatus()).toBe(SERVED.status);
    });

    // Pairs with "redirects a LAN caller in redirect mode" above the same way.
    it('serves a LAN caller in redirect when there is no secure server entry', async () => {
        const h = plainHandler('redirect', { noSecureEntry: true });
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await h(r.req, r.res);
        expect(r.getStatus()).toBe(SERVED.status);
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
    // other failure that happens to also not be 302. It also pairs with
    // "redirects a LAN caller in redirect mode" above: same mode, a
    // disallowed Host instead of an allowed one -> no Location instead of one.
    it('never redirects to a disallowed Host, and the request is independently refused', async () => {
        const h = plainHandler('redirect', { securePort: 8443 });
        const r = makeReqRes(
            'GET',
            '/',
            undefined,
            { host: 'evil.example.com/\r\nSet-Cookie:%20pwned=1' },
            { remoteAddress: '192.168.86.50' },
        );
        await h(r.req, r.res);
        expect(r.getHeader('location')).toBeUndefined();
        expect(r.getStatus()).toBe(403);
        expect(r.getJson()).toMatchObject({ error: 'forbidden', reason: 'host not allowed (possible DNS rebinding)' });
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
