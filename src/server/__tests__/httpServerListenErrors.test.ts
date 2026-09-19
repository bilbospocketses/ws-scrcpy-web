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

    it('a plain-HTTP bind failure stays fatal — it is logged, then re-thrown, not swallowed', async () => {
        vi.resetModules();
        let httpServer: FakeServer | undefined;
        vi.doMock('http', () => ({ createServer: vi.fn(() => (httpServer = makeFakeServer())) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        mockConfigModule();

        const { HttpServer } = await import('../services/HttpServer');
        const { Logger } = await import('../Logger');
        const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

        const service = HttpServer.getInstance();
        await service.start();

        expect(() => {
            httpServer?.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));
        }).toThrow('address in use');

        // A silent catch (log-and-continue, the way HTTPS behaves) would
        // pass a bare `.toThrow()` vacuously if the emit itself still threw
        // for unrelated reasons -- pinning the logged content is what proves
        // this specific handler ran, not just that *something* threw.
        const logged = errorSpy.mock.calls.flat().map(String).join(' ');
        expect(logged).toContain('8000');
        expect(logged).toContain('EADDRINUSE');
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

    // M6 (Minor, from review): attachListenErrorHandler branches on `secure`
    // before touching failedSecurePorts at all -- an unconditional
    // `failedSecurePorts.add(port)` (dropping that branch) would pass every
    // other test in this file, since none of them drives an HTTP failure
    // and then checks HTTPS-mode behaviour afterward. This one does.
    it('an HTTP bind failure does not mark the (unrelated) secure port as failed (M6)', async () => {
        vi.resetModules();
        let httpServer: FakeServer | undefined;
        vi.doMock('http', () => ({ createServer: vi.fn(() => (httpServer = makeFakeServer())) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        mockConfigModule('redirect');

        const { HttpServer, createHttpRequestHandler } = await import('../services/HttpServer');
        const { Logger } = await import('../Logger');
        vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});

        const service = HttpServer.getInstance();
        await service.start();

        // The HTTP failure is fatal and re-throws -- caught here so the test
        // can go on to check the (should-be-unrelated) HTTPS/redirect state.
        expect(() => {
            httpServer?.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));
        }).toThrow();

        const { makeReqRes } = await import('./helpers/httpMock');
        const handler = createHttpRequestHandler([], () => {}, false);
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await handler(r.req, r.res);

        expect(r.getStatus()).toBe(302);
        expect(r.getHeader('location')).toBe('https://192.168.86.50:8443/');
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
