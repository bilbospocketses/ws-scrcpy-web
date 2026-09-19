import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// C1 (Critical, whole-branch review): `/api/tls/state` described files on
// disk and never the listener, so the panel claimed HTTPS was working in
// four states where nothing was bound to the port. `getHttpsListenerStatus()`
// is the new export closing that gap -- it reads the SAME two module-private
// facts (`boundSecurePorts`, `failedSecurePorts`) `findHttpsPort()` already
// reads, in the SAME precedence order (bound port over configured, failed
// beats both), so the two can never disagree about what "listening" means.
//
// Same isolation requirement as httpServerListenErrors.test.ts, which shares
// this module's private state: HttpServer is a process-wide singleton, and
// neither Set nor Map has a reset seam, so each test resets modules and
// re-imports fresh.

interface FakeServer extends EventEmitter {
    listen(port: number, cb?: () => void): void;
    close(): void;
    closeAllConnections(): void;
    address(): { port: number } | null;
    listening: boolean;
}

function makeFakeServer(boundPort = 8443): FakeServer {
    const server = new EventEmitter() as FakeServer;
    server.listening = false;
    server.listen = (_port: number, cb?: () => void) => {
        cb?.();
    };
    server.close = () => {};
    server.closeAllConnections = () => {};
    server.address = () => ({ port: boundPort });
    return server;
}

function mockConfigModule(servers: Array<{ secure: boolean; port: number }>) {
    vi.doMock('../Config', () => ({
        Config: {
            getInstance: () => ({
                servers: servers.map((s) => (s.secure ? { ...s, options: { cert: 'c', key: 'k' } } : s)),
                db: { appSettings: { get: () => undefined } },
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

describe('getHttpsListenerStatus (C1)', () => {
    it('reports not listening, no bind failure, when Config.servers has no secure entry at all', async () => {
        vi.resetModules();
        vi.doMock('http', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        // Only the plain-HTTP entry -- the shape of C1's cases 1-3 (no
        // certificate yet applied to Config.servers, an advanced array with
        // no secure entry, or a port collision that skipped adding one).
        mockConfigModule([{ secure: false, port: 8000 }]);

        const { HttpServer, getHttpsListenerStatus } = await import('../services/HttpServer');
        vi.spyOn((await import('../Logger')).Logger.prototype, 'error').mockImplementation(() => {});
        await HttpServer.getInstance().start();

        expect(getHttpsListenerStatus()).toEqual({ listening: false, bindFailed: false });
    });

    it('reports listening true with the actually-bound port, once .listen() has succeeded', async () => {
        vi.resetModules();
        vi.doMock('http', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => makeFakeServer(8443)) }));
        mockConfigModule([
            { secure: false, port: 8000 },
            { secure: true, port: 8443 },
        ]);

        const { HttpServer, getHttpsListenerStatus } = await import('../services/HttpServer');
        await HttpServer.getInstance().start();

        expect(getHttpsListenerStatus()).toEqual({ listening: true, boundPort: 8443, bindFailed: false });
    });

    // Paired with the test above: a version that always reported the
    // CONFIGURED port (never the bound one) would pass that test AND this
    // one if they used the same number -- this uses an ephemeral `port: 0`
    // entry specifically so the two values differ, the same pairing M7's own
    // test in httpServerListenErrors.test.ts relies on.
    it('reports the actually-bound port, not the configured one, for an ephemeral secure port', async () => {
        vi.resetModules();
        vi.doMock('http', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => makeFakeServer(51234)) }));
        mockConfigModule([
            { secure: false, port: 8000 },
            { secure: true, port: 0 },
        ]);

        const { HttpServer, getHttpsListenerStatus } = await import('../services/HttpServer');
        await HttpServer.getInstance().start();

        expect(getHttpsListenerStatus()).toEqual({ listening: true, boundPort: 51234, bindFailed: false });
    });

    it('reports bindFailed true, not listening, after the configured secure port fails to bind', async () => {
        vi.resetModules();
        let httpsServer: FakeServer | undefined;
        vi.doMock('http', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => (httpsServer = makeFakeServer())) }));
        mockConfigModule([
            { secure: false, port: 8000 },
            { secure: true, port: 8443 },
        ]);

        const { HttpServer, getHttpsListenerStatus } = await import('../services/HttpServer');
        vi.spyOn((await import('../Logger')).Logger.prototype, 'error').mockImplementation(() => {});
        await HttpServer.getInstance().start();

        httpsServer?.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));

        // Distinct from the "no secure entry at all" case above: THIS is
        // "configured but broken", not "never configured". A caller (the
        // panel) needs to tell those apart -- "restart" fixes one, not the
        // other.
        expect(getHttpsListenerStatus()).toEqual({ listening: false, bindFailed: true });
    });

    it('answers the safe default, not a throw, when Config.getInstance() itself throws', async () => {
        vi.resetModules();
        vi.doMock('http', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        vi.doMock('../Config', () => ({
            Config: {
                getInstance: () => {
                    throw new Error('ENOENT: config.json');
                },
            },
        }));

        const { getHttpsListenerStatus } = await import('../services/HttpServer');
        expect(getHttpsListenerStatus()).toEqual({ listening: false, bindFailed: false });
    });
});
