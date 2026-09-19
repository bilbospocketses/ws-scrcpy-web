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
}

function makeFakeServer(): FakeServer {
    const server = new EventEmitter() as FakeServer;
    server.listen = (_port: number, cb?: () => void) => {
        cb?.();
    };
    server.close = () => {};
    server.closeAllConnections = () => {};
    return server;
}

function mockConfigModule(mode: string | undefined = undefined) {
    vi.doMock('../Config', () => ({
        Config: {
            getInstance: () => ({
                servers: [
                    { secure: false, port: 8000 },
                    { secure: true, port: 8443, options: { cert: 'c', key: 'k' } },
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
        const handler = createHttpRequestHandler([], () => {}, false);
        const r = makeReqRes('GET', '/', undefined, { host: '192.168.86.50:8000' }, { remoteAddress: '192.168.86.50' });
        await handler(r.req, r.res);

        expect(r.getStatus()).not.toBe(302);
        expect(r.getHeader('location')).toBeUndefined();
    });
});
