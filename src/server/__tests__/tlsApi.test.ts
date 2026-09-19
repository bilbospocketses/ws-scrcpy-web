import { describe, expect, it, vi } from 'vitest';
import { TlsApi } from '../api/TlsApi';
import { Config } from '../Config';
import { HTTP_EXPOSURE_KEY } from '../tls/httpExposure';
import { makeReqRes } from './helpers/httpMock';

vi.mock('../auth/requireAdmin', () => ({ requireAdmin: vi.fn(() => true) }));

import { requireAdmin } from '../auth/requireAdmin';

vi.mock('../Config', async (importOriginal) => {
    // Only Config.getInstance() is mocked (per-test, via vi.mocked(...).mockReturnValue).
    // validateHttpsPortInput (task 11) is a pure function TlsApi imports from the
    // same module -- it must stay the REAL implementation, or every https-port
    // test below would be exercising a mock instead of the actual validator.
    const actual = await importOriginal<typeof import('../Config')>();
    return { ...actual, Config: { getInstance: vi.fn() } };
});

function makeApi(over: Record<string, unknown> = {}, candidateIps: string[] = ['192.168.86.3']) {
    const svc = {
        getState: vi.fn(() => ({ status: 'none' })),
        generate: vi.fn(async () => ({ status: 'ready', subject: '192.168.86.3', kind: 'ip' })),
        caRootPem: vi.fn(() => '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n'),
        revoke: vi.fn(),
        ...over,
    };
    return {
        api: new TlsApi(
            () => svc as never,
            () => candidateIps,
        ),
        svc,
    };
}

describe('TlsApi', () => {
    it('does not claim urls outside /api/tls', async () => {
        const { api } = makeApi();
        const r = makeReqRes('GET', '/api/devices');
        expect(await api.handle(r.req, r.res)).toBe(false);
    });

    it('is admin-gated — handing out a root CA must not be anonymous', async () => {
        vi.mocked(requireAdmin).mockReturnValueOnce(false);
        const { api, svc } = makeApi();
        const r = makeReqRes('GET', '/api/tls/ca-root');
        expect(await api.handle(r.req, r.res)).toBe(true);
        expect(svc.caRootPem).not.toHaveBeenCalled();
    });

    // --- N4: the admin gate is asserted for ca-root above; pin it for every
    // other route too, since "placed BEFORE the route table so a route added
    // later cannot land ungated" is exactly the invariant a test should check,
    // not just inspection. `denyAdmin` mirrors requireAdmin's own real
    // behaviour (writes 403, returns false) so the status assertion is honest.

    describe('the admin gate covers every route, not just ca-root (N4)', () => {
        function denyAdmin() {
            vi.mocked(requireAdmin).mockImplementationOnce((_req, res) => {
                res.writeHead(403, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'forbidden' }));
                return false;
            });
        }

        it('GET /api/tls/state is gated', async () => {
            denyAdmin();
            const { api, svc } = makeApi();
            const r = makeReqRes('GET', '/api/tls/state');
            expect(await api.handle(r.req, r.res)).toBe(true);
            expect(r.getStatus()).toBe(403);
            expect(svc.getState).not.toHaveBeenCalled();
        });

        it('POST /api/tls/generate is gated', async () => {
            denyAdmin();
            const { api, svc } = makeApi();
            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '192.168.86.3' });
            expect(await api.handle(r.req, r.res)).toBe(true);
            expect(r.getStatus()).toBe(403);
            expect(svc.generate).not.toHaveBeenCalled();
        });

        it('POST /api/tls/revoke is gated', async () => {
            denyAdmin();
            const { api, svc } = makeApi();
            const r = makeReqRes('POST', '/api/tls/revoke', {});
            expect(await api.handle(r.req, r.res)).toBe(true);
            expect(r.getStatus()).toBe(403);
            expect(svc.revoke).not.toHaveBeenCalled();
        });

        it('an unmatched /api/tls/* path is gated BEFORE the unknown-route 404', async () => {
            denyAdmin();
            const { api } = makeApi();
            const r = makeReqRes('GET', '/api/tls/nonexistent-route');
            expect(await api.handle(r.req, r.res)).toBe(true);
            // Not 404 -- the gate runs before the route table sees this path at all.
            expect(r.getStatus()).toBe(403);
        });
    });

    it('serves the CA as a download, not inline', async () => {
        const { api } = makeApi();
        const r = makeReqRes('GET', '/api/tls/ca-root');
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect(r.getHeader('content-disposition')).toContain('attachment');
    });

    it('rejects a generate with a missing subject, without calling the service', async () => {
        const { api, svc } = makeApi();
        const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip' });
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(400);
        expect(svc.generate).not.toHaveBeenCalled();
    });

    it('does not echo a rejected subject back to the caller', async () => {
        const generate = vi.fn().mockRejectedValue(new Error('invalid certificate subject: "-Hevil.com"'));
        const { api } = makeApi({ generate });
        const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '-Hevil.com' });
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(400);
        expect(JSON.stringify(r.getJson())).not.toContain('evil.com');
    });

    it('returns the new state on a successful generate', async () => {
        const { api } = makeApi();
        const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '192.168.86.3' });
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
        expect((r.getJson() as { status: string }).status).toBe('ready');
    });

    // --- amendment (b): GET /api/tls/state also returns candidateIps ---

    describe('candidateIps on GET /api/tls/state (amendment b)', () => {
        it('includes every candidate the injected LAN-IP source reports', async () => {
            const { api } = makeApi({}, ['192.168.86.3', '172.29.144.1']);
            const r = makeReqRes('GET', '/api/tls/state');
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(200);
            expect((r.getJson() as { candidateIps: string[] }).candidateIps).toEqual(['192.168.86.3', '172.29.144.1']);
        });

        it('is an empty array, not a missing field, when nothing is a candidate', async () => {
            const { api } = makeApi({}, []);
            const r = makeReqRes('GET', '/api/tls/state');
            await api.handle(r.req, r.res);
            expect((r.getJson() as { candidateIps: string[] }).candidateIps).toEqual([]);
        });

        it('does not lose the service state fields alongside candidateIps', async () => {
            const getState = vi.fn(() => ({ status: 'ready', subject: '192.168.86.3', kind: 'ip' }));
            const { api } = makeApi({ getState });
            const r = makeReqRes('GET', '/api/tls/state');
            await api.handle(r.req, r.res);
            const json = r.getJson() as Record<string, unknown>;
            expect(json['status']).toBe('ready');
            expect(json['subject']).toBe('192.168.86.3');
            expect(json['candidateIps']).toEqual(['192.168.86.3']);
        });
    });

    // --- C3 (Task 8 review, task 11 addendum): POST /api/tls/generate must
    // also return candidateIps, from the SAME source GET /api/tls/state uses.
    // Without it, the panel defaults to [] and its notification-4 mismatch
    // check fires immediately after a SUCCESSFUL generate for the user's own
    // LAN IP, urging them to regenerate -- which deletes the CA every device
    // on the network already trusts. A false alarm whose suggested fix is
    // destructive.

    describe('candidateIps on POST /api/tls/generate (C3)', () => {
        it('includes every candidate the injected LAN-IP source reports, same as GET /api/tls/state', async () => {
            const { api } = makeApi({}, ['192.168.86.3', '172.29.144.1']);
            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '192.168.86.3' });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(200);
            expect((r.getJson() as { candidateIps: string[] }).candidateIps).toEqual(['192.168.86.3', '172.29.144.1']);
        });

        // Paired with the test above: a version hardcoding
        // `candidateIps: ['192.168.86.3', '172.29.144.1']` would pass that one
        // but fail this one, and a version hardcoding `candidateIps: []` would
        // pass this one but fail that one. Only a genuine pass-through of the
        // injected source satisfies both.
        it('is an empty array, not a missing field, when nothing is a candidate', async () => {
            const { api } = makeApi({}, []);
            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '192.168.86.3' });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(200);
            expect((r.getJson() as { candidateIps: string[] }).candidateIps).toEqual([]);
        });

        it('does not lose allowedHostAdded or the cert state fields alongside candidateIps', async () => {
            const generate = vi.fn(async () => ({
                status: 'ready',
                subject: 'devices.lan',
                kind: 'hostname',
                notAfter: '2030-01-01T00:00:00.000Z',
                caPresent: true,
            }));
            vi.mocked(Config.getInstance).mockReturnValue({ addAllowedHost: vi.fn(() => true) } as never);
            const { api } = makeApi({ generate }, ['192.168.86.3']);
            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'hostname', value: 'devices.lan' });
            await api.handle(r.req, r.res);
            const json = r.getJson() as Record<string, unknown>;
            expect(json['status']).toBe('ready');
            expect(json['subject']).toBe('devices.lan');
            expect(json['kind']).toBe('hostname');
            expect(json['notAfter']).toBe('2030-01-01T00:00:00.000Z');
            expect(json['caPresent']).toBe(true);
            expect(json['allowedHostAdded']).toBe(true);
            expect(json['candidateIps']).toEqual(['192.168.86.3']);
        });
    });

    // --- amendment (a): rate-limit GET /api/tls/ca-root ---

    describe('ca-root rate limiting (amendment a)', () => {
        it('refuses a burst after the limit, per-instance (same api object) rather than per-connection (N7)', async () => {
            const { api } = makeApi();
            const results: number[] = [];
            // Each call gets its own req/res -- a fresh "connection" -- but the
            // same `api` instance, which is what "per-instance" means here (in
            // production exactly one TlsApi is registered, so this coincides
            // with "per process" — see the class-level doc comment).
            for (let i = 0; i < 20; i++) {
                const r = makeReqRes('GET', '/api/tls/ca-root');
                await api.handle(r.req, r.res);
                results.push(r.getStatus());
            }
            expect(results.some((s) => s === 200)).toBe(true);
            expect(results.some((s) => s === 429)).toBe(true);
            const refusedIndex = results.indexOf(429);
            expect(refusedIndex).toBeGreaterThan(-1);
            // NOTE (post-N8): svc.caRootPem() is now called on every request,
            // blocked or not -- the handler must read it before it can even
            // know there is material to rate-limit at all (see the 404-before-
            // rate-limit test above). The old assertion here ("the service must
            // not be asked for the PEM once refused") no longer holds and would
            // be false under the corrected behaviour; it is intentionally not
            // repeated.
        });

        it('a fresh TlsApi instance starts with its own unspent limit', async () => {
            const first = makeApi();
            for (let i = 0; i < 50; i++) {
                const r = makeReqRes('GET', '/api/tls/ca-root');
                await first.api.handle(r.req, r.res);
            }
            const second = makeApi();
            const r = makeReqRes('GET', '/api/tls/ca-root');
            await second.api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(200);
        });
    });

    // --- amendment (B): missing CA is a 404, not a 500 ---

    it('answers 404, not 500, when no certificate has ever been generated', async () => {
        const caRootPem = vi.fn(() => undefined);
        const { api } = makeApi({ caRootPem });
        const r = makeReqRes('GET', '/api/tls/ca-root');
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(404);
    });

    it('a 404 (no cert generated yet) does not consume a rate-limit slot (N8)', async () => {
        const caRootPem = vi.fn((): string | undefined => undefined);
        const { api } = makeApi({ caRootPem });

        // Far more than the limit -- every one of these must 404, never 429,
        // because nothing has ever left the process yet.
        for (let i = 0; i < 50; i++) {
            const r = makeReqRes('GET', '/api/tls/ca-root');
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(404);
        }

        // Now that a certificate exists, the budget must be untouched by the
        // 50 prior 404s -- the very first real download still succeeds.
        caRootPem.mockReturnValue('-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n');
        const r = makeReqRes('GET', '/api/tls/ca-root');
        await api.handle(r.req, r.res);
        expect(r.getStatus()).toBe(200);
    });

    // --- amendment (C): kind must be a literal, never defaulted ---

    describe('kind validation (amendment C)', () => {
        it('rejects a missing kind with 400 naming the field, rather than defaulting to ip', async () => {
            const { api, svc } = makeApi();
            const r = makeReqRes('POST', '/api/tls/generate', { value: 'devices.lan' });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(400);
            expect(JSON.stringify(r.getJson())).toMatch(/kind/);
            expect(svc.generate).not.toHaveBeenCalled();
        });

        it('rejects a misspelled kind rather than guessing', async () => {
            const { api, svc } = makeApi();
            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'IP', value: '192.168.86.3' });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(400);
            expect(svc.generate).not.toHaveBeenCalled();
        });

        it('accepts the literal "hostname"', async () => {
            const generate = vi.fn(async () => ({ status: 'ready', subject: 'devices.lan', kind: 'hostname' }));
            vi.mocked(Config.getInstance).mockReturnValue({ addAllowedHost: vi.fn() } as never);
            const { api, svc } = makeApi({ generate });
            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'hostname', value: 'devices.lan' });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(200);
            expect(svc.generate).toHaveBeenCalledWith('hostname', 'devices.lan');
        });
    });

    // --- amendment (c): allowedHosts write, hostname-only ---

    describe('allowedHosts write on successful generate (amendment c)', () => {
        it('adds a HOSTNAME subject to allowedHosts and says so in the response', async () => {
            const addAllowedHost = vi.fn(() => true);
            vi.mocked(Config.getInstance).mockReturnValue({ addAllowedHost } as never);
            const generate = vi.fn(async () => ({ status: 'ready', subject: 'devices.lan', kind: 'hostname' }));
            const { api } = makeApi({ generate });

            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'hostname', value: 'devices.lan' });
            await api.handle(r.req, r.res);

            expect(addAllowedHost).toHaveBeenCalledWith('devices.lan');
            expect((r.getJson() as { allowedHostAdded: boolean }).allowedHostAdded).toBe(true);
        });

        it('writes NOTHING to allowedHosts for an IP subject', async () => {
            const addAllowedHost = vi.fn(() => true);
            vi.mocked(Config.getInstance).mockReturnValue({ addAllowedHost } as never);
            const generate = vi.fn(async () => ({ status: 'ready', subject: '192.168.86.3', kind: 'ip' }));
            const { api } = makeApi({ generate });

            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '192.168.86.3' });
            await api.handle(r.req, r.res);

            expect(addAllowedHost).not.toHaveBeenCalled();
            expect((r.getJson() as { allowedHostAdded: boolean }).allowedHostAdded).toBe(false);
        });
    });

    // --- N1: a config.json write failure must not be reported as "address rejected" ---

    describe('allowedHosts write failure after a successful generate (N1)', () => {
        it('still reports 200 with the real state when Config.getInstance() itself throws', async () => {
            vi.mocked(Config.getInstance).mockImplementation(() => {
                throw new Error('ENOSPC: no space left on device');
            });
            const generate = vi.fn(async () => ({ status: 'ready', subject: 'devices.lan', kind: 'hostname' }));
            const { api } = makeApi({ generate });

            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'hostname', value: 'devices.lan' });
            await api.handle(r.req, r.res);

            // The certificate WAS issued -- svc.generate resolved. Reporting
            // "that address could not be used for a certificate" here would be a
            // lie: mkcert ran, the CA was replaced, and the leaf is on disk.
            expect(r.getStatus()).toBe(200);
            const json = r.getJson() as Record<string, unknown>;
            expect(json['status']).toBe('ready');
            expect(json['subject']).toBe('devices.lan');
            expect(json['allowedHostAdded']).toBe(false);
        });

        it('still reports 200 with the real state when addAllowedHost() itself throws', async () => {
            const addAllowedHost = vi.fn(() => {
                throw new Error('EACCES: config.json');
            });
            vi.mocked(Config.getInstance).mockReturnValue({ addAllowedHost } as never);
            const generate = vi.fn(async () => ({ status: 'ready', subject: 'devices.lan', kind: 'hostname' }));
            const { api } = makeApi({ generate });

            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'hostname', value: 'devices.lan' });
            await api.handle(r.req, r.res);

            expect(r.getStatus()).toBe(200);
            const json = r.getJson() as Record<string, unknown>;
            expect(json['status']).toBe('ready');
            expect(json['allowedHostAdded']).toBe(false);
        });

        it('a genuine svc.generate() failure is still reported as 400 (the original contract, unaffected)', async () => {
            const generate = vi.fn().mockRejectedValue(new Error('invalid certificate subject'));
            const { api, svc } = makeApi({ generate });
            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'hostname', value: 'not-a-real-host' });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(400);
            expect(svc.generate).toHaveBeenCalled();
        });
    });

    // --- task 11: POST /api/tls/exposure -- persists HTTP_EXPOSURE_KEY ---

    describe('POST /api/tls/exposure (task 11)', () => {
        it('rejects an unrecognised mode with 400 naming the field, without touching app_settings', async () => {
            const set = vi.fn();
            vi.mocked(Config.getInstance).mockReturnValue({ db: { appSettings: { set } } } as never);
            const { api } = makeApi();
            const r = makeReqRes('POST', '/api/tls/exposure', { mode: 'bogus' });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(400);
            expect(JSON.stringify(r.getJson())).toMatch(/mode/);
            expect(set).not.toHaveBeenCalled();
        });

        it('rejects a missing mode, rather than defaulting to "open"', async () => {
            const set = vi.fn();
            vi.mocked(Config.getInstance).mockReturnValue({ db: { appSettings: { set } } } as never);
            const { api } = makeApi();
            const r = makeReqRes('POST', '/api/tls/exposure', {});
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(400);
            expect(set).not.toHaveBeenCalled();
        });

        it('persists a narrowed mode to app_settings under HTTP_EXPOSURE_KEY', async () => {
            const set = vi.fn();
            vi.mocked(Config.getInstance).mockReturnValue({ db: { appSettings: { set } } } as never);
            const { api } = makeApi();
            const r = makeReqRes('POST', '/api/tls/exposure', { mode: 'redirect' });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(200);
            expect(set).toHaveBeenCalledWith(HTTP_EXPOSURE_KEY, 'redirect');
        });

        it('accepts "open" too, not just the two narrowed modes', async () => {
            const set = vi.fn();
            vi.mocked(Config.getInstance).mockReturnValue({ db: { appSettings: { set } } } as never);
            const { api } = makeApi();
            const r = makeReqRes('POST', '/api/tls/exposure', { mode: 'open' });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(200);
            expect(set).toHaveBeenCalledWith(HTTP_EXPOSURE_KEY, 'open');
        });

        it('answers 500, not a thrown exception, when the database write fails', async () => {
            const set = vi.fn(() => {
                throw new Error('EACCES: app.db');
            });
            vi.mocked(Config.getInstance).mockReturnValue({ db: { appSettings: { set } } } as never);
            const { api } = makeApi();
            const r = makeReqRes('POST', '/api/tls/exposure', { mode: 'httpsOnly' });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(500);
        });

        it('is gated by requireAdmin like every other tls route', async () => {
            vi.mocked(requireAdmin).mockImplementationOnce((_req, res) => {
                res.writeHead(403, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'forbidden' }));
                return false;
            });
            const set = vi.fn();
            vi.mocked(Config.getInstance).mockReturnValue({ db: { appSettings: { set } } } as never);
            const { api } = makeApi();
            const r = makeReqRes('POST', '/api/tls/exposure', { mode: 'httpsOnly' });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(403);
            expect(set).not.toHaveBeenCalled();
        });
    });

    // --- task 11: POST /api/tls/https-port -- persists httpsPort + restarts ---

    describe('POST /api/tls/https-port (task 11)', () => {
        function makeSeamsApi() {
            const schedule = vi.fn();
            const exit = vi.fn();
            const svc = {
                getState: vi.fn(() => ({ status: 'none' })),
                generate: vi.fn(),
                caRootPem: vi.fn(),
                revoke: vi.fn(),
            };
            const api = new TlsApi(
                () => svc as never,
                () => [],
                { schedule, exit },
            );
            return { api, schedule, exit };
        }

        it('rejects an out-of-range port with 400 naming the field, persisting nothing and scheduling nothing', async () => {
            const setHttpsPort = vi.fn();
            vi.mocked(Config.getInstance).mockReturnValue({
                setHttpsPort,
                restartMarkerPath: '/tmp/.restart',
            } as never);
            const { api, schedule } = makeSeamsApi();
            const r = makeReqRes('POST', '/api/tls/https-port', { port: 70000 });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(400);
            expect(JSON.stringify(r.getJson())).toMatch(/port/i);
            expect(setHttpsPort).not.toHaveBeenCalled();
            expect(schedule).not.toHaveBeenCalled();
        });

        it('rejects a non-integer port, without persisting', async () => {
            const setHttpsPort = vi.fn();
            vi.mocked(Config.getInstance).mockReturnValue({
                setHttpsPort,
                restartMarkerPath: '/tmp/.restart',
            } as never);
            const { api } = makeSeamsApi();
            const r = makeReqRes('POST', '/api/tls/https-port', { port: '9443' });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(400);
            expect(setHttpsPort).not.toHaveBeenCalled();
        });

        it("accepts 80 -- httpsPort is not held to webPort's 1024 floor (independence, mirrors Task 7)", async () => {
            const setHttpsPort = vi.fn();
            vi.mocked(Config.getInstance).mockReturnValue({
                setHttpsPort,
                restartMarkerPath: '/tmp/.restart',
            } as never);
            const { api } = makeSeamsApi();
            const r = makeReqRes('POST', '/api/tls/https-port', { port: 80 });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(200);
            expect(setHttpsPort).toHaveBeenCalledWith(80);
        });

        it('persists a valid port and schedules a restart without firing it yet', async () => {
            const setHttpsPort = vi.fn();
            vi.mocked(Config.getInstance).mockReturnValue({
                setHttpsPort,
                restartMarkerPath: '/tmp/.restart',
            } as never);
            const { api, schedule, exit } = makeSeamsApi();
            const r = makeReqRes('POST', '/api/tls/https-port', { port: 9443 });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(200);
            expect(setHttpsPort).toHaveBeenCalledWith(9443);
            expect(schedule).toHaveBeenCalledTimes(1);
            expect(exit).not.toHaveBeenCalled();
            const body = r.getJson() as { restartRequired: boolean };
            expect(body.restartRequired).toBe(true);
        });

        it('firing the scheduled callback calls exit(75) -- the supervisor restart signal', async () => {
            const setHttpsPort = vi.fn();
            vi.mocked(Config.getInstance).mockReturnValue({
                setHttpsPort,
                restartMarkerPath: '/tmp/.restart',
            } as never);
            const { api, schedule, exit } = makeSeamsApi();
            const r = makeReqRes('POST', '/api/tls/https-port', { port: 9443 });
            await api.handle(r.req, r.res);
            const [cb] = schedule.mock.calls[0]!;
            (cb as () => void)();
            expect(exit).toHaveBeenCalledWith(75);
        });

        it('answers 500, not a thrown exception, when persisting to config.json fails', async () => {
            const setHttpsPort = vi.fn(() => {
                throw new Error('ENOSPC: no space left on device');
            });
            vi.mocked(Config.getInstance).mockReturnValue({
                setHttpsPort,
                restartMarkerPath: '/tmp/.restart',
            } as never);
            const { api, schedule } = makeSeamsApi();
            const r = makeReqRes('POST', '/api/tls/https-port', { port: 9443 });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(500);
            expect(schedule).not.toHaveBeenCalled();
        });

        it('is gated by requireAdmin like every other tls route', async () => {
            vi.mocked(requireAdmin).mockImplementationOnce((_req, res) => {
                res.writeHead(403, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'forbidden' }));
                return false;
            });
            const setHttpsPort = vi.fn();
            vi.mocked(Config.getInstance).mockReturnValue({
                setHttpsPort,
                restartMarkerPath: '/tmp/.restart',
            } as never);
            const { api, schedule } = makeSeamsApi();
            const r = makeReqRes('POST', '/api/tls/https-port', { port: 9443 });
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(403);
            expect(setHttpsPort).not.toHaveBeenCalled();
            expect(schedule).not.toHaveBeenCalled();
        });
    });
});
