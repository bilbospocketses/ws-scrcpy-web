import { describe, expect, it, vi } from 'vitest';
import { TlsApi } from '../api/TlsApi';
import { Config } from '../Config';
import { makeReqRes } from './helpers/httpMock';

vi.mock('../auth/requireAdmin', () => ({ requireAdmin: vi.fn(() => true) }));

import { requireAdmin } from '../auth/requireAdmin';

vi.mock('../Config', () => ({ Config: { getInstance: vi.fn() } }));

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

    // --- amendment (a): rate-limit GET /api/tls/ca-root ---

    describe('ca-root rate limiting (amendment a)', () => {
        it('refuses a burst after the limit, per-process (same instance) rather than per-connection', async () => {
            const { api, svc } = makeApi();
            const results: number[] = [];
            // Each call gets its own req/res -- a fresh "connection" -- but the
            // same `api` instance, which is what "per-process" means here.
            for (let i = 0; i < 20; i++) {
                const r = makeReqRes('GET', '/api/tls/ca-root');
                await api.handle(r.req, r.res);
                results.push(r.getStatus());
            }
            expect(results.some((s) => s === 200)).toBe(true);
            expect(results.some((s) => s === 429)).toBe(true);
            // Once refused, the service must not have been asked for the PEM.
            const refusedIndex = results.indexOf(429);
            expect(refusedIndex).toBeGreaterThan(-1);
            expect(svc.caRootPem.mock.calls.length).toBeLessThan(20);
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
});
