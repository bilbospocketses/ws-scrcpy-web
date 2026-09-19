import { describe, expect, it, vi } from 'vitest';
import { buildHttpsListenerField, TlsApi } from '../api/TlsApi';
import { Config } from '../Config';
import { Logger } from '../Logger';
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

// C1 (whole-branch review): TlsApi now reads listener truth from HttpServer's
// getHttpsListenerStatus(). Defaults to "nothing bound" so every EXISTING
// /state test below, which never configures this, keeps behaving exactly as
// the real function does when nothing is listening -- only the tests that
// care about it override the return value per case.
vi.mock('../services/HttpServer', () => ({
    getHttpsListenerStatus: vi.fn(() => ({ listening: false, bindFailed: false })),
}));

import { getHttpsListenerStatus } from '../services/HttpServer';

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

    // --- I3 (Important, whole-branch review): every generate failure used to
    // collapse into one 400 blaming the user's address, with NO server log --
    // a bad subject, a missing mkcert binary, a crash, a full disk and a
    // permissions error were all indistinguishable, and mkcert's stderr
    // (which CertService puts into the thrown message) was discarded at both
    // ends. Distinguish a REJECTED SUBJECT (400, the user can act on it) from
    // an EXECUTION FAILURE (500, it is not their fault), and log the real
    // cause server-side either way -- the no-echo-to-the-client constraint is
    // unchanged (asserted above and again below). ---

    describe('generate failure classification and server-side logging (I3)', () => {
        it('a rejected-subject-shaped message is still a 400 -- the original contract, unaffected -- AND is now logged server-side', async () => {
            const generate = vi.fn().mockRejectedValue(new Error('invalid certificate subject: "-Hevil.com"'));
            const { api } = makeApi({ generate });
            const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
            const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '-Hevil.com' });
            await api.handle(r.req, r.res);

            expect(r.getStatus()).toBe(400);
            expect(JSON.stringify(r.getJson())).not.toContain('evil.com');
            // Logged (server-side only -- never sent to the client): the
            // real cause exists SOMEWHERE now, closing "an admin whose
            // generate fails has no diagnostic anywhere".
            expect(warnSpy.mock.calls.flat().join(' ')).toContain('invalid certificate subject');
            expect(errorSpy).not.toHaveBeenCalled();
        });

        // Paired with the test above: a DIFFERENT message shape -- the exact
        // kind mkcert's own non-zero exit, a missing binary, or a crash
        // produces -- must come out as 500, not 400, and log.error (not
        // log.warn). A version that always answered 400 for every generate
        // failure would pass the test above and fail this one.
        it('any other failure (mkcert exit, missing binary, crash, disk, permissions) is a 500, logged via log.error with the real cause', async () => {
            const generate = vi.fn().mockRejectedValue(new Error('mkcert failed (exit 1): permission denied'));
            const { api } = makeApi({ generate });
            const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
            const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '192.168.86.3' });
            await api.handle(r.req, r.res);

            expect(r.getStatus()).toBe(500);
            expect(errorSpy.mock.calls.flat().join(' ')).toContain('permission denied');
            expect(warnSpy).not.toHaveBeenCalled();
        });

        it('never echoes the caller-supplied value into the client response body, even for a 500', async () => {
            const generate = vi.fn().mockRejectedValue(new Error('mkcert failed (exit 1): stderr mentions -Hevil.com'));
            const { api } = makeApi({ generate });
            vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '-Hevil.com' });
            await api.handle(r.req, r.res);

            expect(r.getStatus()).toBe(500);
            expect(JSON.stringify(r.getJson())).not.toContain('evil.com');
        });

        it('an ENOENT-shaped spawn failure (missing mkcert binary) is a 500, not a 400', async () => {
            const generate = vi
                .fn()
                .mockRejectedValue(Object.assign(new Error('spawn mkcert.exe ENOENT'), { code: 'ENOENT' }));
            const { api } = makeApi({ generate });
            const errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
            const r = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '192.168.86.3' });
            await api.handle(r.req, r.res);

            expect(r.getStatus()).toBe(500);
            expect(errorSpy.mock.calls.flat().join(' ')).toContain('ENOENT');
        });
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

    // --- httpExposure on GET /api/tls/state (Critical: the panel pre-selects
    // its exposure radios from this field, and with none present it always
    // falls back to 'open' -- so a user who set httpsOnly, reopens Settings
    // for something unrelated, and clicks the exposure "ok" button silently
    // widens their own exposure back to 'open', with a SUCCESS confirmation.
    // Mirrors HttpServer.ts's readHttpExposure() narrowing and 'open' default
    // exactly, so the panel and the request-handling path can never disagree
    // about what "no setting" means. ---

    describe('httpExposure on GET /api/tls/state', () => {
        it('reports the real narrowed value when set, and falls back to "open" for anything unrecognised', async () => {
            const narrowed = makeApi();
            vi.mocked(Config.getInstance).mockReturnValue({
                db: { appSettings: { get: vi.fn(() => 'httpsOnly') } },
            } as never);
            const rNarrowed = makeReqRes('GET', '/api/tls/state');
            await narrowed.api.handle(rNarrowed.req, rNarrowed.res);
            expect((rNarrowed.getJson() as { httpExposure: string }).httpExposure).toBe('httpsOnly');

            // Same test, second half: an unrecognised stored value must NOT
            // echo through as-is (a hand-edited or newer-version row must
            // never brick the panel's read either) -- it has to collapse to
            // 'open', the identical default readHttpExposure() uses. A
            // hardcoded 'open' would pass this half and fail the one above;
            // a passthrough-with-no-narrowing would pass the one above and
            // fail this one.
            const unrecognised = makeApi();
            vi.mocked(Config.getInstance).mockReturnValue({
                db: { appSettings: { get: vi.fn(() => 'bogus-value-from-a-newer-build') } },
            } as never);
            const rUnrecognised = makeReqRes('GET', '/api/tls/state');
            await unrecognised.api.handle(rUnrecognised.req, rUnrecognised.res);
            expect((rUnrecognised.getJson() as { httpExposure: string }).httpExposure).toBe('open');
        });

        it('answers 200 with "open", not 500, when the store is unreachable', async () => {
            // "A database that will not answer must not be able to refuse
            // requests" -- HttpServer.ts's own comment on readHttpExposure,
            // and the reason this mirrors its try/catch rather than letting
            // Config.getInstance() throw straight into this route's 500.
            vi.mocked(Config.getInstance).mockImplementation(() => {
                throw new Error('ENOENT: no such file or directory');
            });
            const { api } = makeApi();
            const r = makeReqRes('GET', '/api/tls/state');
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(200);
            expect((r.getJson() as { httpExposure: string }).httpExposure).toBe('open');
        });

        it('is "open" by default in every other GET /state test in this file, without those tests configuring it', async () => {
            // Every OTHER test in this file calls makeApi() without touching
            // Config.getInstance, so the module-level mock's un-configured
            // vi.fn() returns undefined and `.db` on it would throw if this
            // route did not catch it -- this pins that every existing /state
            // test keeps working unmodified, which the fix must not break.
            const { api } = makeApi();
            const r = makeReqRes('GET', '/api/tls/state');
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(200);
            expect((r.getJson() as { httpExposure: string }).httpExposure).toBe('open');
        });
    });

    // --- C1 (Critical, whole-branch review): GET /api/tls/state must report
    // LISTENER truth, not just certificate-on-disk truth, to the EXACT
    // contract team-lead specified (sent identically to the panel's
    // implementer, so neither side can diverge):
    //
    //   httpsListener: { bound: boolean; port?: number; reason?: 'restart-required'
    //                     | 'config-override' | 'port-collision' | 'bind-failed' }
    //   httpsPort: number   // the CONFIGURED port, for the panel's prefill (I2)
    //
    // Without this, the panel claimed "streaming already works" in four
    // states where nothing was bound to the HTTPS port -- most importantly,
    // immediately after a successful generate, whose only offered remedy
    // (regenerate) destroys the CA the user may have just installed on their
    // phone. ---

    // buildHttpsListenerField is the pure priority logic behind the route --
    // tested directly here (contrast pairs across EVERY branch, since the
    // four reasons are mutually exclusive by priority and each needs its own
    // proof) and again through the real route below for wiring.
    describe('buildHttpsListenerField priority logic (C1)', () => {
        it('bound true reports the real port and no reason, regardless of what config/cert would otherwise imply', () => {
            expect(
                buildHttpsListenerField(
                    { listening: true, boundPort: 8443, bindFailed: false },
                    { advancedConfig: true, portCollision: true },
                    true,
                ),
            ).toEqual({ bound: true, port: 8443 });
        });

        // bind-failed outranks config-override and port-collision: a
        // configured-but-broken listener is a DIFFERENT actionable fact than
        // "config.json overrides this" or "the ports collide", even if both
        // happen to also be true in a contrived input.
        it('bind-failed takes priority over config-override and port-collision', () => {
            expect(
                buildHttpsListenerField(
                    { listening: false, bindFailed: true },
                    { advancedConfig: true, portCollision: true },
                    true,
                ),
            ).toEqual({ bound: false, reason: 'bind-failed' });
        });

        it('config-override takes priority over port-collision', () => {
            expect(
                buildHttpsListenerField(
                    { listening: false, bindFailed: false },
                    { advancedConfig: true, portCollision: true },
                    true,
                ),
            ).toEqual({ bound: false, reason: 'config-override' });
        });

        it('port-collision applies when neither bind-failed nor config-override do', () => {
            expect(
                buildHttpsListenerField(
                    { listening: false, bindFailed: false },
                    { advancedConfig: false, portCollision: true },
                    true,
                ),
            ).toEqual({ bound: false, reason: 'port-collision' });
        });

        // restart-required is the LOWEST-priority reason, and only applies
        // when a certificate genuinely exists -- paired against the "no
        // certificate at all" case immediately below, since a version that
        // ignored certReady entirely would pass this test and fail that one.
        it('restart-required applies only when a certificate exists and nothing else matched', () => {
            expect(
                buildHttpsListenerField(
                    { listening: false, bindFailed: false },
                    { advancedConfig: false, portCollision: false },
                    true,
                ),
            ).toEqual({ bound: false, reason: 'restart-required' });
        });

        it('reports no reason at all when nothing is bound, nothing else matched, and there is no certificate to restart into', () => {
            expect(
                buildHttpsListenerField(
                    { listening: false, bindFailed: false },
                    { advancedConfig: false, portCollision: false },
                    false,
                ),
            ).toEqual({ bound: false });
        });
    });

    describe('httpsListener + httpsPort on GET /api/tls/state (C1, exact contract)', () => {
        type StateJson = {
            httpsListener: { bound: boolean; port?: number; reason?: string };
            httpsPort: number;
        };

        async function stateJson(over: Record<string, unknown> = {}): Promise<StateJson> {
            const { api } = makeApi(over);
            const r = makeReqRes('GET', '/api/tls/state');
            await api.handle(r.req, r.res);
            expect(r.getStatus()).toBe(200);
            return r.getJson() as StateJson;
        }

        it('wires a bound listener straight through to httpsListener.port, and reports httpsPort from Config -- the core contrast', async () => {
            vi.mocked(getHttpsListenerStatus).mockReturnValueOnce({
                listening: true,
                boundPort: 8443,
                bindFailed: false,
            });
            vi.mocked(Config.getInstance).mockReturnValue({
                usesAdvancedServerConfig: false,
                httpsPort: 8443,
                servers: [{ secure: false, port: 8000 }],
            } as never);
            const bound = await stateJson();
            expect(bound.httpsListener).toEqual({ bound: true, port: 8443 });
            expect(bound.httpsPort).toBe(8443);

            // Same route, nothing bound this time -- a hardcoded
            // `{ bound: true }` would pass the case above and fail this one.
            vi.mocked(getHttpsListenerStatus).mockReturnValueOnce({ listening: false, bindFailed: false });
            const notBound = await stateJson();
            expect(notBound.httpsListener.bound).toBe(false);
            expect(notBound.httpsListener.port).toBeUndefined();
        });

        it('wires bind-failed through end to end', async () => {
            vi.mocked(getHttpsListenerStatus).mockReturnValueOnce({ listening: false, bindFailed: true });
            const json = await stateJson();
            expect(json.httpsListener).toEqual({ bound: false, reason: 'bind-failed' });
        });

        it('wires config-override through end to end, and httpsPort is STILL reported (I2 -- the panel needs it even in this mode)', async () => {
            vi.mocked(Config.getInstance).mockReturnValue({
                usesAdvancedServerConfig: true,
                httpsPort: 9443,
                servers: [{ secure: false, port: 8000 }],
            } as never);
            const json = await stateJson();
            expect(json.httpsListener).toEqual({ bound: false, reason: 'config-override' });
            expect(json.httpsPort).toBe(9443);
        });

        it('wires port-collision through end to end, computed from Config.httpsPort vs the real http port', async () => {
            vi.mocked(Config.getInstance).mockReturnValue({
                usesAdvancedServerConfig: false,
                httpsPort: 8000,
                servers: [{ secure: false, port: 8000 }],
            } as never);
            const colliding = await stateJson();
            expect(colliding.httpsListener).toEqual({ bound: false, reason: 'port-collision' });

            // Same shape, DIFFERENT httpsPort -- proves this is a genuine
            // comparison, not a check that only looked at whether httpsPort
            // was configured at all. A certificate is supplied here so the
            // "no reason" default (no cert to restart into) doesn't mask a
            // broken collision check the same way it would with makeApi()'s
            // default `status: 'none'`.
            vi.mocked(Config.getInstance).mockReturnValue({
                usesAdvancedServerConfig: false,
                httpsPort: 8443,
                servers: [{ secure: false, port: 8000 }],
            } as never);
            const getState = vi.fn(() => ({ status: 'ready', subject: '192.168.86.3', kind: 'ip' }));
            const notColliding = await stateJson({ getState });
            expect(notColliding.httpsListener).toEqual({ bound: false, reason: 'restart-required' });
        });

        it('wires restart-required through end to end, gated on the certificate genuinely being ready', async () => {
            const getState = vi.fn(() => ({ status: 'ready', subject: '192.168.86.3', kind: 'ip' }));
            const withCert = await stateJson({ getState });
            expect(withCert.httpsListener).toEqual({ bound: false, reason: 'restart-required' });

            // Same everything else, no certificate -- proves certReady is
            // actually consulted, not a constant true.
            const noCert = await stateJson();
            expect(noCert.httpsListener).toEqual({ bound: false });
        });

        it('is safe by default when Config.getInstance() itself throws -- matches every other /state test in this file', async () => {
            vi.mocked(Config.getInstance).mockImplementation(() => {
                throw new Error('ENOENT: config.json');
            });
            const json = await stateJson();
            expect(json.httpsListener.bound).toBe(false);
            expect(typeof json.httpsPort).toBe('number');
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

        // The exact check the panel performs (ServerTab.ts's
        // certSubjectMismatchNotice): `candidateIps.includes(subject)`. Both
        // outcomes come from generate calls against the same injected
        // candidate list, in the same test, so the response has to carry
        // BOTH the true subject and the true candidate list for this to
        // distinguish them -- a hardcoded or dropped candidateIps collapses
        // to one outcome and fails half of this.
        it('lets the panel distinguish a matching subject from a stale one, the way notification 4 depends on', async () => {
            const matching = makeApi({}, ['192.168.86.3']);
            const rMatch = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '192.168.86.3' });
            await matching.api.handle(rMatch.req, rMatch.res);
            const matchJson = rMatch.getJson() as { subject: string; candidateIps: string[] };
            expect(matchJson.candidateIps.includes(matchJson.subject)).toBe(true);

            const stale = makeApi(
                { generate: vi.fn(async () => ({ status: 'ready', subject: '10.0.0.9', kind: 'ip' })) },
                ['192.168.86.3'],
            );
            const rStale = makeReqRes('POST', '/api/tls/generate', { kind: 'ip', value: '10.0.0.9' });
            await stale.api.handle(rStale.req, rStale.res);
            const staleJson = rStale.getJson() as { subject: string; candidateIps: string[] };
            expect(staleJson.candidateIps.includes(staleJson.subject)).toBe(false);
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
