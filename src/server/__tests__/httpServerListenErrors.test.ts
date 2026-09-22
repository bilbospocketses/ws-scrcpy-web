import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// C3 (Critical, from the Task 7 review): neither the http nor the https
// Server HttpServer.start() creates had an 'error' listener. Node's
// EventEmitter re-throws an 'error' event with no listener as an uncaught
// exception, so a busy port on ONE listener (most likely 8443, since it's
// new) took the WHOLE process down -- including the plain-HTTP listener that
// bound fine. These tests drive the real `HttpServer.start()` against
// mocked 'http'/'https' + a mocked Config, so the fake servers are real
// EventEmitters: an `.emit('error', err)` with no listener attached throws
// synchronously by itself, which is exactly what proves these tests would
// fail if the production listener were removed.
//
// HttpServer is a process-wide singleton (HttpServer.getInstance()), so each
// test resets modules and re-imports fresh, the same way dependencyManager
// .test.ts isolates DependencyManager's own module-level state.

interface FakeServer extends EventEmitter {
    listen(port: number, cb?: () => void): void;
    close(): void;
    closeAllConnections(): void;
    address(): { port: number } | null;
    listening: boolean;
}

function makeFakeServer(boundPort = 8443): FakeServer {
    const server = new EventEmitter() as FakeServer;
    // Deliberately left `false` by `.listen()` itself, unlike a real
    // net.Server (which only flips this once the 'listening' event fires,
    // strictly after 'error' cannot fire for that same bind attempt). Every
    // test here calls `.listen()` (which always "succeeds" by invoking the
    // callback) and THEN manually emits 'error' to simulate a failure --
    // this fake doesn't model the two as mutually exclusive. Leaving
    // `.listening` false by default keeps the existing bind-failure tests'
    // meaning intact (attachListenErrorHandler sees "never bound"); the I2
    // test below sets it to `true` right before emitting, to specifically
    // simulate a runtime error on an ALREADY-live listener.
    server.listening = false;
    server.listen = (_port: number, cb?: () => void) => {
        cb?.();
    };
    server.close = () => {};
    server.closeAllConnections = () => {};
    // M7's `.listen()` callback reads this for the secure entry to record
    // the actually-bound port; a real net.Server always returns an object
    // once listening. Defaults to 8443 (this file's configured secure port)
    // so the recorded and configured ports agree unless a test overrides it.
    server.address = () => ({ port: boundPort });
    return server;
}

function mockConfigModule(mode: string | undefined = undefined, securePort = 8443) {
    vi.doMock('../Config', () => ({
        Config: {
            getInstance: () => ({
                servers: [
                    { secure: false, port: 8000 },
                    { secure: true, port: securePort, options: { cert: 'c', key: 'k' } },
                ],
                db: { appSettings: { get: () => mode } },
            }),
        },
    }));
}

afterEach(() => {
    vi.doUnmock('http');
    vi.doUnmock('https');
    vi.doUnmock('../Config');
    vi.resetModules();
    vi.restoreAllMocks();
});

describe('HttpServer listen-error handling', () => {
    it('an HTTPS bind failure is logged and degrades — it does not take the process down, and HTTP keeps serving', async () => {
        vi.resetModules();
        let httpServer: FakeServer | undefined;
        let httpsServer: FakeServer | undefined;
        vi.doMock('http', () => ({ createServer: vi.fn(() => (httpServer = makeFakeServer())) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => (httpsServer = makeFakeServer())) }));
        mockConfigModule();

        const { HttpServer } = await import('../services/HttpServer');
        const { Logger } = await import('../Logger');
        const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

        const service = HttpServer.getInstance();
        await service.start();

        expect(httpServer).toBeDefined();
        expect(httpsServer).toBeDefined();

        // Without attachListenErrorHandler, this emit has no listener at all,
        // and Node's EventEmitter re-throws an 'error' event with no
        // listener synchronously — so this assertion fails on its own if the
        // production listener is removed.
        expect(() => {
            httpsServer?.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));
        }).not.toThrow();

        const logged = errorSpy.mock.calls.flat().map(String).join(' ');
        expect(logged).toContain('8443');
        expect(logged).toContain('EADDRINUSE');

        // HTTP is still one of the servers the service reports — the HTTPS
        // failure didn't tear it down or otherwise touch it.
        const servers = await service.getServers();
        expect(servers.some((s) => s.port === 8000)).toBe(true);
        expect(servers.some((s) => s.port === 8443)).toBe(true);
    });

    // Item 141: the mirror case. `attachListenErrorHandler` already degraded
    // when the HTTPS listener failed to bind, but the HTTP side re-threw --
    // so a busy port 80 took down a perfectly healthy HTTPS listener with it,
    // which is the exact outcome C3 was filed to prevent, one protocol over.
    // The spec only ever guaranteed that HTTP survives an HTTPS failure, so
    // the old behaviour was defensible rather than wrong; the user's ruling
    // (2026-09-22) is degrade-never-exit in both directions.
    it('a plain-HTTP bind failure degrades and does NOT take a healthy HTTPS listener down (141)', async () => {
        vi.resetModules();
        let httpServer: FakeServer | undefined;
        let httpsServer: FakeServer | undefined;
        vi.doMock('http', () => ({ createServer: vi.fn(() => (httpServer = makeFakeServer(8000))) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => (httpsServer = makeFakeServer())) }));
        mockConfigModule();

        const { HttpServer } = await import('../services/HttpServer');
        const { Logger } = await import('../Logger');
        const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

        const service = HttpServer.getInstance();
        await service.start();

        // The HTTPS listener bound fine and is live -- this is what the old
        // `throw err` destroyed.
        if (httpsServer) httpsServer.listening = true;

        expect(() => {
            httpServer?.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));
        }).not.toThrow();

        // Pinning the logged content, not merely "it didn't throw": a handler
        // that silently swallowed the error would also pass `.not.toThrow()`.
        const logged = errorSpy.mock.calls.flat().map(String).join(' ');
        expect(logged).toContain('8000');
        expect(logged).toContain('EADDRINUSE');
        expect(logged).toContain('failed to bind');

        // And the specific thing 141 is about: HTTPS is untouched. A
        // regression that re-threw would never reach this line at all, but a
        // regression that marked the secure port failed WOULD -- so assert
        // the secure side's standing, not just survival.
        const { getHttpsListenerStatus } = await import('../services/HttpServer');
        expect(getHttpsListenerStatus().listening).toBe(true);
        expect(getHttpsListenerStatus().bindFailed).toBe(false);
    });

    // Item 141, the mirror of I2. Once the HTTP branch stops re-throwing it
    // needs the same `!server.listening` guard the secure branch has, or a
    // transient runtime error (EMFILE under load) on an ALREADY-serving HTTP
    // listener gets recorded as "failed to bind" -- a false log line about a
    // listener that is still up. Without the guard this test fails on the
    // wording assertion rather than by throwing, which is why it asserts the
    // two phrasings are distinct rather than just counting calls.
    it('a runtime error on an already-bound HTTP listener is not reported as a failed bind (141)', async () => {
        vi.resetModules();
        let httpServer: FakeServer | undefined;
        vi.doMock('http', () => ({ createServer: vi.fn(() => (httpServer = makeFakeServer(8000))) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        mockConfigModule();

        const { HttpServer } = await import('../services/HttpServer');
        const { Logger } = await import('../Logger');
        const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

        const service = HttpServer.getInstance();
        await service.start();

        if (httpServer) httpServer.listening = true;
        expect(() => {
            httpServer?.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }));
        }).not.toThrow();

        const logged = errorSpy.mock.calls.flat().map(String).join(' ');
        expect(logged).toContain('runtime error');
        expect(logged).not.toContain('failed to bind');
    });

    // Item 141's one genuine cost: with nothing re-thrown, a boot where BOTH
    // listeners fail to bind no longer exits -- it would sit there serving
    // nothing, which is worse than crashing because it looks healthy. The
    // ruling was degrade-never-exit, so the process stays up; this asserts
    // the condition is at least stated once, loudly, rather than inferred
    // from two unrelated bind-failure lines.
    it('logs a distinct line when BOTH listeners failed, so "serving nothing" is never silent (141)', async () => {
        vi.resetModules();
        let httpServer: FakeServer | undefined;
        let httpsServer: FakeServer | undefined;
        vi.doMock('http', () => ({ createServer: vi.fn(() => (httpServer = makeFakeServer(8000))) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => (httpsServer = makeFakeServer())) }));
        mockConfigModule();

        const { HttpServer } = await import('../services/HttpServer');
        const { Logger } = await import('../Logger');
        const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

        const service = HttpServer.getInstance();
        await service.start();

        // HTTPS goes down first, then HTTP -- so by the time the HTTP handler
        // runs there is genuinely nothing left serving.
        httpsServer?.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));
        expect(() => {
            httpServer?.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));
        }).not.toThrow();

        const logged = errorSpy.mock.calls.flat().map(String).join(' ');
        expect(logged).toContain('no listener is serving');
    });

    // The inverse, and the reason the line above is gated rather than
    // unconditional: an HTTP failure while HTTPS is healthy must NOT claim
    // nothing is serving. Pairs with the test above (same HTTP failure, one
    // differing fact, opposite expectation).
    it('does not claim "serving nothing" when HTTPS is still up (141)', async () => {
        vi.resetModules();
        let httpServer: FakeServer | undefined;
        let httpsServer: FakeServer | undefined;
        vi.doMock('http', () => ({ createServer: vi.fn(() => (httpServer = makeFakeServer(8000))) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => (httpsServer = makeFakeServer())) }));
        mockConfigModule();

        const { HttpServer } = await import('../services/HttpServer');
        const { Logger } = await import('../Logger');
        const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

        const service = HttpServer.getInstance();
        await service.start();

        if (httpsServer) httpsServer.listening = true;
        httpServer?.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));

        const logged = errorSpy.mock.calls.flat().map(String).join(' ');
        expect(logged).not.toContain('no listener is serving');
    });

    it('after an HTTPS bind failure, redirect mode serves rather than pointing at the dead port — reads runtime reality, not just config', async () => {
        vi.resetModules();
        let httpsServer: FakeServer | undefined;
        vi.doMock('http', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => (httpsServer = makeFakeServer())) }));
        mockConfigModule('redirect');

        const { HttpServer, createHttpRequestHandler } = await import('../services/HttpServer');
        const { Logger } = await import('../Logger');
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

        const service = HttpServer.getInstance();
        await service.start();
        httpsServer?.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));

        const { makeReqRes } = await import('./helpers/httpMock');
        // A real fallback that writes a status, not a no-op -- with a no-op
        // fallback and no API handlers, "served" and "the mock's initial
        // status 0" are indistinguishable, which is exactly the I3 shape:
        // `not.toBe(302)` would then pass whether the code served correctly
        // OR never touched the response at all.
        const handler = createHttpRequestHandler(
            [],
            (_req, res) => {
                res.writeHead(200);
                res.end('served');
            },
            false,
        );
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await handler(r.req, r.res);

        expect(r.getStatus()).toBe(200);
        expect(r.getHeader('location')).toBeUndefined();
    });

    // I2 (Important, from review): `'error'` on an http/https Server fires
    // for any runtime socket error, not only a failed bind. Without the
    // `!server.listening` guard in attachListenErrorHandler, a transient
    // error on an ALREADY-live HTTPS listener (e.g. EMFILE under load) would
    // be indistinguishable from a genuine bind failure -- wrongly recording
    // the port as failed-to-bind and silently disabling both narrowed
    // exposure modes for the rest of the process's life on a listener that
    // is still up and serving.
    it('a runtime error on an already-bound HTTPS listener does not mark it as a failed bind (I2)', async () => {
        vi.resetModules();
        let httpsServer: FakeServer | undefined;
        vi.doMock('http', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => (httpsServer = makeFakeServer())) }));
        mockConfigModule('redirect');

        const { HttpServer, createHttpRequestHandler } = await import('../services/HttpServer');
        const { Logger } = await import('../Logger');
        const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

        const service = HttpServer.getInstance();
        await service.start();

        // Simulate the bind having already succeeded before this error --
        // a real net.Server's `.listening` is true from exactly that point.
        if (httpsServer) httpsServer.listening = true;
        httpsServer?.emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }));

        const logged = errorSpy.mock.calls.flat().map(String).join(' ');
        expect(logged).toContain('runtime error');
        expect(logged).not.toContain('failed to bind');

        const { makeReqRes } = await import('./helpers/httpMock');
        const handler = createHttpRequestHandler([], () => {}, false);
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await handler(r.req, r.res);

        // Still redirects toward the (still-configured, still-bound) secure
        // port -- a buggy unconditional `failedSecurePorts.add(port)` would
        // instead serve here, the same wrong outcome as the no-guard case
        // above but for the opposite reason (a live listener wrongly marked
        // dead instead of a dead one wrongly marked live).
        expect(r.getStatus()).toBe(302);
        expect(r.getHeader('location')).toBe('https://192.168.86.50:8443/');
    });

    // M6 (Minor, from review round 1 -- NOT actually pinned; fixed here per
    // re-review). The original version of this test used the default 8000 /
    // 8443 ports, so an unconditional `failedSecurePorts.add(port)` recorded
    // 8000 -- which cannot affect `failedSecurePorts.has(8443)` at all. The
    // mutation the comment claimed to catch passed clean; only the I2 test
    // caught it, for an unrelated reason. Fixed by configuring the secure
    // entry at the SAME port as the HTTP entry (8000): purely synthetic --
    // two real listeners can't share a port -- but it makes the two Sets'
    // keys collide, so an unconditional add is directly observable through
    // `findHttpsPort()`'s behaviour rather than needing a peek at the Set
    // itself.
    it('an HTTP bind failure does not mark the (unrelated) secure port as failed (M6)', async () => {
        vi.resetModules();
        let httpServer: FakeServer | undefined;
        vi.doMock('http', () => ({ createServer: vi.fn(() => (httpServer = makeFakeServer())) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => makeFakeServer(8000)) }));
        // Both entries configured at port 8000 -- see the comment above.
        mockConfigModule('redirect', 8000);

        const { HttpServer, createHttpRequestHandler } = await import('../services/HttpServer');
        const { Logger } = await import('../Logger');
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

        const service = HttpServer.getInstance();
        await service.start();

        // The HTTP failure degrades rather than re-throwing (item 141), so
        // there is nothing to catch here any more -- but the point of the
        // test is unchanged. A buggy unconditional `failedSecurePorts
        // .add(port)` would record 8000 here, which -- because the secure
        // entry is ALSO configured at 8000 in this test -- would make
        // `findHttpsPort()` treat the secure entry as failed too. The
        // `.not.toThrow()` is kept deliberately: it is what would catch a
        // revert of 141 in the file that owns the behaviour.
        expect(() => {
            httpServer?.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));
        }).not.toThrow();

        const { makeReqRes } = await import('./helpers/httpMock');
        const handler = createHttpRequestHandler([], () => {}, false);
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await handler(r.req, r.res);

        // Still redirects -- the HTTP failure never touched the secure
        // entry's standing. A buggy unconditional add would instead serve
        // here (findHttpsPort() returning undefined because 8000 is now
        // "failed"), the same wrong outcome the no-`server.listening`-guard
        // case (I2) produces, but from the opposite direction.
        expect(r.getStatus()).toBe(302);
        expect(r.getHeader('location')).toBe('https://192.168.86.50:8000/');
    });

    // M7 (Minor, from review): with an ephemeral `port: 0` secure entry, the
    // CONFIGURED port and the port actually bound differ -- a redirect built
    // from the configured value would be `https://host:0/`, which nothing is
    // listening on.
    it('redirects to the actually-bound port, not the configured one, for an ephemeral secure port (M7)', async () => {
        vi.resetModules();
        vi.doMock('http', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        // The OS assigns 51234 for the `port: 0` entry -- server.address()
        // is where that becomes knowable, never the config.
        vi.doMock('https', () => ({ createServer: vi.fn(() => makeFakeServer(51234)) }));
        mockConfigModule('redirect', 0);

        const { HttpServer, createHttpRequestHandler } = await import('../services/HttpServer');
        const { Logger } = await import('../Logger');
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

        const service = HttpServer.getInstance();
        await service.start();

        const { makeReqRes } = await import('./helpers/httpMock');
        const handler = createHttpRequestHandler([], () => {}, false);
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await handler(r.req, r.res);

        expect(r.getStatus()).toBe(302);
        expect(r.getHeader('location')).toBe('https://192.168.86.50:51234/');
    });
});
