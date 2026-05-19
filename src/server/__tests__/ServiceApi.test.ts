// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceApi } from '../api/ServiceApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import type {
    ServiceClient,
    ServiceClientFactoryResult,
} from '../service/ServiceClient';

function makeReqRes(url: string, method = 'GET', body?: string, headers?: Record<string, string>) {
    // Minimal IncomingMessage: only the on('data')/on('end') hooks readJsonBody
    // uses are needed. Fire data + end synchronously on the first listener
    // attach so the awaited Promise resolves on the next microtask.
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const req = {
        url,
        method,
        headers: headers ?? {},
        on(event: string, handler: (...args: unknown[]) => void) {
            (listeners[event] ??= []).push(handler);
            // Fire body+end after handlers are attached. The install handler
            // attaches data/end/error in one synchronous block; we kick the
            // pump on the 'end' attach which is the last of the three.
            if (event === 'end') {
                queueMicrotask(() => {
                    if (body) {
                        for (const h of listeners['data'] ?? []) h(Buffer.from(body, 'utf8'));
                    }
                    for (const h of listeners['end'] ?? []) h();
                });
            }
            return this;
        },
    } as unknown as IncomingMessage;
    let statusCode = 0;
    const chunks: string[] = [];
    const res = {
        writeHead(code: number) {
            statusCode = code;
            return this;
        },
        setHeader() {
            return this;
        },
        end(data?: string) {
            if (data) chunks.push(data);
        },
        getStatus: () => statusCode,
        getBody: () => chunks.join(''),
    } as unknown as ServerResponse & { getStatus(): number; getBody(): string };
    return { req, res };
}

function fakeClient(overrides: Partial<ServiceClient> = {}): ServiceClient {
    return {
        install: vi.fn(async () => undefined),
        uninstall: vi.fn(async () => undefined),
        status: vi.fn(async () => 'not-installed' as const),
        restart: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        ...overrides,
    };
}

describe('ServiceApi', () => {
    const tmpDirs: string[] = [];
    const savedEnv = {
        CONFIG: process.env[EnvName.CONFIG_PATH],
        DEPS: process.env['DEPS_PATH'],
    };

    beforeEach(() => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-svc-api-'));
        tmpDirs.push(tmpRoot);
        const configPath = path.join(tmpRoot, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({}));
        process.env[EnvName.CONFIG_PATH] = configPath;
        process.env['DEPS_PATH'] = path.join(tmpRoot, 'deps');
        Config._resetForTest();
    });

    afterEach(() => {
        Config._resetForTest();
        if (savedEnv.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
        else process.env[EnvName.CONFIG_PATH] = savedEnv.CONFIG;
        if (savedEnv.DEPS === undefined) delete process.env['DEPS_PATH'];
        else process.env['DEPS_PATH'] = savedEnv.DEPS;
        while (tmpDirs.length) {
            const d = tmpDirs.pop()!;
            try {
                fs.rmSync(d, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        }
    });

    it('returns false from handle() for non-matching URLs', async () => {
        const api = new ServiceApi();
        const { req, res } = makeReqRes('/api/devices');
        expect(await api.handle(req, res)).toBe(false);
    });

    it('GET /status returns supported=false envelope on unsupported platforms', async () => {
        const factoryResult: ServiceClientFactoryResult = {
            client: fakeClient(),
            supported: false,
            platform: 'linux',
            unsupportedReason: 'Linux service mode lands later in SP3 — for now, run from source',
        };
        const api = new ServiceApi(() => factoryResult, () => 'system');
        const { req, res } = makeReqRes('/api/service/status');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        const body = JSON.parse((res as any).getBody());
        expect(body).toEqual({
            supported: false,
            platform: 'linux',
            unsupportedReason: 'Linux service mode lands later in SP3 — for now, run from source',
        });
    });

    it('GET /status returns the running status on supported platforms', async () => {
        const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(() => factoryResult, () => 'user');
        const { req, res } = makeReqRes('/api/service/status');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        expect(JSON.parse((res as any).getBody())).toEqual({
            supported: true,
            platform: 'win32',
            status: 'running',
        });
        expect(client.status).toHaveBeenCalledWith('WsScrcpyWeb');
    });

    it('POST /install returns 501 with unsupportedReason on unsupported platforms', async () => {
        const factoryResult: ServiceClientFactoryResult = {
            client: fakeClient(),
            supported: false,
            platform: 'linux',
            unsupportedReason: 'nope',
        };
        const api = new ServiceApi(() => factoryResult, () => 'system');
        const { req, res } = makeReqRes('/api/service/install', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(501);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.error).toBe('nope');
        expect(body.reason).toBe('unsupported');
    });

    it('POST /install calls client.install with installMode=user-service for user scope', async () => {
        const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(async () => undefined);
        const client = fakeClient({
            install: installFn,
            status: vi.fn(async () => 'running' as const),
        });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        // v0.1.6 injected isAdmin + existsCheck — stub both true so the
        // Windows install path runs through to the client without short-
        // circuiting on the admin guard or the launcher-exe-missing 500.
        // v0.1.7: ServiceApi no longer takes an isAdmin injection. The
        // existsCheck stub stays so the launcher-exe presence check passes.
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
            () => true,
            // discover stub: short-circuit port discovery so tests
            // don't actually probe localhost ports for 30s.
            async () => null,
        );
        const { req, res } = makeReqRes('/api/service/install', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(true);
        expect(body.status).toBe('running');
        expect(body.installMode).toBe('user-service');
        expect(installFn).toHaveBeenCalledTimes(1);
        const opts = installFn.mock.calls[0]?.[0];
        expect(opts?.name).toBe('WsScrcpyWeb');
        // No `account` field — Windows ServyClient runs as Local System
        // unconditionally; Linux SystemdClient consumes `scope` instead.
        expect((opts as { account?: unknown })?.account).toBeUndefined();
        expect(opts?.startType).toBe('Automatic');
        expect(opts?.maxRestartAttempts).toBe(3);
        expect(opts?.envVars['DEPS_PATH']).toBeDefined();
        // v0.1.6: binPath must be the launcher exe in the install root,
        // NOT process.execPath. startupDir must equal the install root so
        // SCM hands the launched child the right CWD.
        expect(opts?.binPath).toMatch(/ws-scrcpy-web-launcher\.exe$/);
        expect(opts?.startupDir).toBe(process.cwd());
    });

    it('POST /install calls client.install with installMode=system-service for system scope', async () => {
        const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(async () => undefined);
        const client = fakeClient({
            install: installFn,
            status: vi.fn(async () => 'running' as const),
        });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'system',
            () => true,
            async () => null,
        );
        const { req, res } = makeReqRes('/api/service/install', 'POST');
        await api.handle(req, res);
        const body = JSON.parse((res as any).getBody());
        expect(body.installMode).toBe('system-service');
        expect((installFn.mock.calls[0]?.[0] as { account?: unknown }).account).toBeUndefined();
    });

    it('POST /install returns 403 when ServyClient throws ServiceInstallError with isUacDeclined=true', async () => {
        // v0.1.7: ServiceApi no longer guards on admin elevation up
        // front; instead, ServyClient.install() spawns an elevated
        // helper which prompts for UAC. If the user declines the prompt,
        // the helper throws a ServiceInstallError; ServiceApi maps that
        // specific case to 403 so the frontend can render a UAC-aware
        // retry prompt.
        const { ServiceInstallError } = await import('../service/ServyClient');
        const installFn = vi.fn(async () => {
            throw new ServiceInstallError(
                'user declined elevation. Service install requires Administrator',
                {
                    ok: false,
                    exitCode: -1,
                    stdout: '',
                    stderr: '',
                    errorMessage: 'user declined elevation. Service install requires Administrator',
                },
            );
        });
        const client = fakeClient({ install: installFn as any });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
            () => true,
            // discover stub: short-circuit port discovery so tests
            // don't actually probe localhost ports for 30s.
            async () => null,
        );
        const { req, res } = makeReqRes('/api/service/install', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(403);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/declined elevation/i);
    });

    it('POST /install returns 500 when the launcher exe is missing (dev runs)', async () => {
        const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(async () => undefined);
        const client = fakeClient({ install: installFn });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        // existsCheck returns false — service install can't proceed without
        // the packaged launcher binary. Caller gets a clear 500 with the
        // expected path mentioned, NOT a confusing Servy error message.
        const api = new ServiceApi(() => factoryResult, () => 'user', () => false);
        const { req, res } = makeReqRes('/api/service/install', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(500);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/ws-scrcpy-web-launcher\.exe/);
        expect(installFn).not.toHaveBeenCalled();
    });

    it('POST /install returns 500 with stderr-rich error when client.install throws', async () => {
        const client = fakeClient({
            install: vi.fn(async () => {
                throw new Error('servy-cli install failed: Service already exists');
            }),
        });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        // v0.1.7: ServiceApi no longer takes an isAdmin injection. The
        // existsCheck stub stays so the launcher-exe presence check passes.
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
            () => true,
            // discover stub: short-circuit port discovery so tests
            // don't actually probe localhost ports for 30s.
            async () => null,
        );
        const { req, res } = makeReqRes('/api/service/install', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(500);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/Service already exists/);
    });

    it('POST /uninstall calls uninstall and reverts installMode', async () => {
        // v0.1.7: ServiceApi no longer calls stop() separately before
        // uninstall — the elevated helper does stop+uninstall in one
        // elevated process.
        const uninstallFn = vi.fn(async () => undefined);
        const client = fakeClient({
            uninstall: uninstallFn,
            status: vi.fn(async () => 'not-installed' as const),
        });
        Config.getInstance().updateAppConfig({ installMode: 'user-service' });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(() => factoryResult, () => 'user');
        const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(true);
        expect(body.status).toBe('not-installed');
        expect(body.installMode).toBe('user');
        expect(uninstallFn).toHaveBeenCalledWith('WsScrcpyWeb');
    });

    it('POST /uninstall returns 403 when ServiceInstallError reports UAC declined', async () => {
        const { ServiceInstallError } = await import('../service/ServyClient');
        const uninstallFn = vi.fn(async () => {
            throw new ServiceInstallError(
                'user declined elevation. Service uninstall requires Administrator',
                {
                    ok: false,
                    exitCode: -1,
                    stdout: '',
                    stderr: '',
                    errorMessage: 'user declined elevation. Service uninstall requires Administrator',
                },
            );
        });
        const client = fakeClient({ uninstall: uninstallFn as any });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(() => factoryResult, () => 'user');
        const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(403);
        const body = JSON.parse((res as any).getBody());
        expect(body.error).toMatch(/declined elevation/i);
    });

    it('POST /uninstall returns 500 when uninstall itself fails', async () => {
        const client = fakeClient({
            uninstall: vi.fn(async () => {
                throw new Error('access denied');
            }),
        });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(() => factoryResult, () => 'user');
        const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(500);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.error).toEqual(expect.stringContaining('access denied'));
        expect(body.reason).toBe('servy-failure');
    });

    // ── Linux scope branch (SP3 P4b) ────────────────────────────────────────
    //
    // ServiceApi inspects result.platform === 'linux' to decide whether to
    // parse the JSON body for `scope`. The injected scope() factory is a
    // no-op on Linux — scope arrives via the request body, defaults to
    // 'user' when absent, and a system-scope request from a non-root process
    // returns 403 BEFORE the client install is invoked.
    describe('Linux scope branch', () => {
        let savedGetuid: typeof process.getuid | undefined;
        beforeEach(() => {
            savedGetuid = process.getuid;
        });
        afterEach(() => {
            if (savedGetuid) {
                Object.defineProperty(process, 'getuid', {
                    value: savedGetuid,
                    configurable: true,
                });
            }
        });

        it('POST /install on Linux with empty body defaults to user scope', async () => {
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(async () => undefined);
            const client = fakeClient({
                install: installFn,
                status: vi.fn(async () => 'running' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const api = new ServiceApi(() => factoryResult, () => 'system' /* should be ignored on Linux */);
            const { req, res } = makeReqRes('/api/service/install', 'POST', '');
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.installMode).toBe('user-service');
            const opts = installFn.mock.calls[0]?.[0];
            expect(opts?.scope).toBe('user');
            expect((opts as { account?: unknown })?.account).toBeUndefined();
        });

        it('POST /install on Linux with {scope: "user"} body installs user scope', async () => {
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(async () => undefined);
            const client = fakeClient({
                install: installFn,
                status: vi.fn(async () => 'running' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const api = new ServiceApi(() => factoryResult, () => 'system');
            const { req, res } = makeReqRes(
                '/api/service/install',
                'POST',
                JSON.stringify({ scope: 'user' }),
            );
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(200);
            const opts = installFn.mock.calls[0]?.[0];
            expect(opts?.scope).toBe('user');
        });

        it('POST /install on Linux with {scope: "system"} as root installs system scope', async () => {
            Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(async () => undefined);
            const client = fakeClient({
                install: installFn,
                status: vi.fn(async () => 'running' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const api = new ServiceApi(() => factoryResult, () => 'user');
            const { req, res } = makeReqRes(
                '/api/service/install',
                'POST',
                JSON.stringify({ scope: 'system' }),
            );
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.installMode).toBe('system-service');
            const opts = installFn.mock.calls[0]?.[0];
            expect(opts?.scope).toBe('system');
            expect((opts as { account?: unknown })?.account).toBeUndefined();
        });

        it('POST /install on Linux with {scope: "system"} as non-root returns 403', async () => {
            Object.defineProperty(process, 'getuid', {
                value: () => 1000,
                configurable: true,
            });
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(async () => undefined);
            const client = fakeClient({ install: installFn });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const api = new ServiceApi(() => factoryResult, () => 'user');
            const { req, res } = makeReqRes(
                '/api/service/install',
                'POST',
                JSON.stringify({ scope: 'system' }),
            );
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(403);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(false);
            expect(body.error).toMatch(/system scope requires root/);
            expect(installFn).not.toHaveBeenCalled();
        });

        it('POST /install on Linux with malformed JSON body falls back to user scope', async () => {
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(async () => undefined);
            const client = fakeClient({
                install: installFn,
                status: vi.fn(async () => 'running' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const api = new ServiceApi(() => factoryResult, () => 'system');
            const { req, res } = makeReqRes(
                '/api/service/install',
                'POST',
                'not-json{',
            );
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(200);
            const opts = installFn.mock.calls[0]?.[0];
            expect(opts?.scope).toBe('user');
        });
    });

    it('returns 404 for unrecognized /api/service/* paths', async () => {
        const factoryResult: ServiceClientFactoryResult = {
            client: fakeClient(),
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(() => factoryResult, () => 'user');
        const { req, res } = makeReqRes('/api/service/bogus', 'GET');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(404);
    });

    // ── reason discriminator + no-direct-uninstall guard (v0.1.25) ──────────

    it('returns 503 with reason=handoff-timeout when LocalSystem handoff fails (does NOT direct-uninstall)', async () => {
        const uninstallSpy = vi.fn(async () => undefined);
        const client = fakeClient({
            uninstall: uninstallSpy,
            status: vi.fn(async () => 'running' as const),
        });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(() => factoryResult, () => 'user');
        // Force isLikelyLocalSystem() to return true.
        vi.spyOn(
            api as unknown as { isLikelyLocalSystem: () => boolean },
            'isLikelyLocalSystem',
        ).mockReturnValue(true);
        // Force the handoff to fail (resolve false synchronously).
        vi.spyOn(
            api as unknown as { handoffUninstallToUserSession: (...args: unknown[]) => Promise<boolean> },
            'handoffUninstallToUserSession',
        ).mockResolvedValue(false);
        // Set installMode to 'system-service' so the running-as-service branch fires.
        Config.getInstance().updateAppConfig({ installMode: 'system-service' });

        const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
        await api.handle(req, res);

        expect((res as any).getStatus()).toBe(503);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('handoff-timeout');
        // Critical: the direct uninstall path must NOT have been attempted.
        expect(uninstallSpy).not.toHaveBeenCalled();
    });

    it('returns reason=unsupported when service mode is unsupported (POST /uninstall)', async () => {
        const factoryResult: ServiceClientFactoryResult = {
            client: fakeClient(),
            supported: false,
            platform: 'linux',
            unsupportedReason: 'systemd not found',
        };
        const api = new ServiceApi(() => factoryResult, () => 'user');
        const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(501);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('unsupported');
    });

    it('returns reason=uac-declined when client.uninstall throws UAC-declined error', async () => {
        const { ServiceInstallError } = await import('../service/ServyClient');
        const uninstallFn = vi.fn(async () => {
            throw new ServiceInstallError(
                'user declined elevation. Service uninstall requires Administrator',
                {
                    ok: false,
                    exitCode: -1,
                    stdout: '',
                    stderr: '',
                    errorMessage: 'user declined elevation. Service uninstall requires Administrator',
                },
            );
        });
        const client = fakeClient({ uninstall: uninstallFn as any });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(() => factoryResult, () => 'user');
        const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(403);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('uac-declined');
    });

    it('returns reason=invalid-token when resume token is invalid', async () => {
        const factoryResult: ServiceClientFactoryResult = {
            client: fakeClient(),
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(() => factoryResult, () => 'user');
        // Provide a token that will fail consumeToken validation (it won't match
        // any issued token in the temp dir, so consumeToken returns false).
        const { req, res } = makeReqRes(
            '/api/service/uninstall',
            'POST',
            undefined,
            { 'x-resume-token': 'bogus-token-value' },
        );
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(401);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('invalid-token');
    });

    it('returns reason=servy-failure when client.uninstall throws a generic Error', async () => {
        const client = fakeClient({
            uninstall: vi.fn(async () => {
                throw new Error('servy crashed');
            }),
        });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(() => factoryResult, () => 'user');
        const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(500);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('servy-failure');
    });
});
