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

// NF-1 (Critical, re-review): two real, DISTINCT leaf certs -- needed to
// prove getHttpsListenerStatus() captures a genuine fingerprint of whatever
// cert content was actually handed to https.createServer, not a hardcoded or
// memoized-wrong value. Same fixtures CertService.test.ts uses (real
// self-signed EC certs, CN plus a matching subjectAltName); copied rather
// than imported since fingerprinting needs only PARSEABLE cert content, no
// matching key, and each test file conventionally owns its own fixtures.
const FIXTURE_LEAF_A_PEM = `-----BEGIN CERTIFICATE-----
MIIBlDCCATqgAwIBAgIUWRyRFrRP38lFQsYUWl0VEB9kOFowCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMMTkyLjE2OC44Ni4zMB4XDTI2MDkxOTA5MDgwM1oXDTM2MDkx
NjA5MDgwM1owFzEVMBMGA1UEAwwMMTkyLjE2OC44Ni4zMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEZzLReChxB1VkXdyFqWceOKv0X0CVCE3TfldHl23TaRzAvX8W
OZ2YWf8TlZz19drOeLg1JEMAogNMkc2Hr+Ghc6NkMGIwHQYDVR0OBBYEFISi43dH
QjLuf0Ggt6+vu5zEJzSWMB8GA1UdIwQYMBaAFISi43dHQjLuf0Ggt6+vu5zEJzSW
MA8GA1UdEwEB/wQFMAMBAf8wDwYDVR0RBAgwBocEwKhWAzAKBggqhkjOPQQDAgNI
ADBFAiBtorg9KaDh2fIaga0F4THSFIwFCyZeGgOZJRj9JU6Y0gIhAPNhpzV8fHWQ
mUpCOJ+/e5QDCmF8xK2hDkgMkq0Bfx6C
-----END CERTIFICATE-----
`;
const FIXTURE_LEAF_B_PEM = `-----BEGIN CERTIFICATE-----
MIIBmTCCAT+gAwIBAgIUYR161+lq+9CIxZUfmG2DSFhkXHUwCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLZGV2aWNlcy5sYW4wHhcNMjYwOTE5MDkwODAzWhcNMzYwOTE2
MDkwODAzWjAWMRQwEgYDVQQDDAtkZXZpY2VzLmxhbjBZMBMGByqGSM49AgEGCCqG
SM49AwEHA0IABCtsnmxV3S0lEcPlxMDpcel8Rsz4htyqNckzbNYxUotomMmTQ671
VsX9OuAaJCqz4YJjeaAEXKBi9lUwfdWhpX2jazBpMB0GA1UdDgQWBBQ++j/I3XDn
XF6R3A9VfT7WyLo8AjAfBgNVHSMEGDAWgBQ++j/I3XDnXF6R3A9VfT7WyLo8AjAP
BgNVHRMBAf8EBTADAQH/MBYGA1UdEQQPMA2CC2RldmljZXMubGFuMAoGCCqGSM49
BAMCA0gAMEUCIQD/TKnjXc8X3oArqm2ECn1gxR5h3kwmltfm1IoDFD4bBgIgC71q
AWEbfuHbWLd/3KtdjuZOh4+CQq/oD+3jp2wnQ3o=
-----END CERTIFICATE-----
`;

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

// `cert` defaults to 'c' (unparseable) -- existing tests that don't care
// about leafFingerprint are unaffected: a capture failure is caught and
// leaves the field absent, same as `boundPort` being conditionally included.
function mockConfigModule(servers: Array<{ secure: boolean; port: number; cert?: string }>) {
    vi.doMock('../Config', () => ({
        Config: {
            getInstance: () => ({
                servers: servers.map((s) => (s.secure ? { ...s, options: { cert: s.cert ?? 'c', key: 'k' } } : s)),
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

    // --- NF-1 (Critical, re-review): leafFingerprint, captured at bind time ---

    it('captures the fingerprint of the ACTUAL cert content handed to https.createServer', async () => {
        vi.resetModules();
        vi.doMock('http', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => makeFakeServer(8443)) }));
        mockConfigModule([
            { secure: false, port: 8000 },
            { secure: true, port: 8443, cert: FIXTURE_LEAF_A_PEM },
        ]);

        const { HttpServer, getHttpsListenerStatus } = await import('../services/HttpServer');
        await HttpServer.getInstance().start();

        const status = getHttpsListenerStatus();
        expect(status.listening).toBe(true);
        expect(typeof status.leafFingerprint).toBe('string');
        expect(status.leafFingerprint!.length).toBeGreaterThan(0);
    });

    // Paired with the test above: a DIFFERENT cert at boot must capture a
    // DIFFERENT fingerprint -- a hardcoded or memoized-wrong value would
    // pass the "is a string" case above and fail this contrast.
    it('a different cert at boot captures a DIFFERENT fingerprint', async () => {
        vi.resetModules();
        vi.doMock('http', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => makeFakeServer(8443)) }));
        mockConfigModule([
            { secure: false, port: 8000 },
            { secure: true, port: 8443, cert: FIXTURE_LEAF_A_PEM },
        ]);
        const { HttpServer: HttpServerA, getHttpsListenerStatus: statusA } = await import('../services/HttpServer');
        await HttpServerA.getInstance().start();
        const fingerprintA = statusA().leafFingerprint;

        vi.resetModules();
        vi.doMock('http', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => makeFakeServer(8443)) }));
        mockConfigModule([
            { secure: false, port: 8000 },
            { secure: true, port: 8443, cert: FIXTURE_LEAF_B_PEM },
        ]);
        const { HttpServer: HttpServerB, getHttpsListenerStatus: statusB } = await import('../services/HttpServer');
        await HttpServerB.getInstance().start();
        const fingerprintB = statusB().leafFingerprint;

        expect(fingerprintA).toBeDefined();
        expect(fingerprintB).toBeDefined();
        expect(fingerprintA).not.toBe(fingerprintB);
    });

    it('leafFingerprint is absent (not a crash) when the cert content is not parseable', async () => {
        vi.resetModules();
        vi.doMock('http', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => makeFakeServer(8443)) }));
        // Default 'c' -- not valid PEM.
        mockConfigModule([
            { secure: false, port: 8000 },
            { secure: true, port: 8443 },
        ]);

        const { HttpServer, getHttpsListenerStatus } = await import('../services/HttpServer');
        await HttpServer.getInstance().start();

        const status = getHttpsListenerStatus();
        expect(status.listening).toBe(true);
        expect(status.leafFingerprint).toBeUndefined();
    });

    it('leafFingerprint is absent when nothing is bound (bind-failed case)', async () => {
        vi.resetModules();
        let httpsServer: FakeServer | undefined;
        vi.doMock('http', () => ({ createServer: vi.fn(() => makeFakeServer()) }));
        vi.doMock('https', () => ({ createServer: vi.fn(() => (httpsServer = makeFakeServer())) }));
        mockConfigModule([
            { secure: false, port: 8000 },
            { secure: true, port: 8443, cert: FIXTURE_LEAF_A_PEM },
        ]);

        const { HttpServer, getHttpsListenerStatus } = await import('../services/HttpServer');
        vi.spyOn((await import('../Logger')).Logger.prototype, 'error').mockImplementation(() => {});
        await HttpServer.getInstance().start();
        httpsServer?.emit('error', Object.assign(new Error('address in use'), { code: 'EADDRINUSE' }));

        const status = getHttpsListenerStatus();
        expect(status.listening).toBe(false);
        expect(status.leafFingerprint).toBeUndefined();
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
