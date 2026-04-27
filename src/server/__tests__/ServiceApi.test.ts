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

function makeReqRes(url: string, method = 'GET', body?: string) {
    // Minimal IncomingMessage: only the on('data')/on('end') hooks readJsonBody
    // uses are needed. Fire data + end synchronously on the first listener
    // attach so the awaited Promise resolves on the next microtask.
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const req = {
        url,
        method,
        on(event: string, handler: (...args: unknown[]) => void) {
            (listeners[event] ??= []).push(handler);
            // Fire body+end after handlers are attached. The install handler
            // attaches data/end/error in one synchronous block; we kick the
            // pump on the 'end' attach which is the last of the three.
            if (event === 'end') {
                queueMicrotask(() => {
                    if (body) {
                        for (const h of listeners.data ?? []) h(Buffer.from(body, 'utf8'));
                    }
                    for (const h of listeners.end ?? []) h();
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
        expect(JSON.parse((res as any).getBody())).toEqual({ ok: false, error: 'nope' });
    });

    it('POST /install calls client.install with currentUser account for user scope', async () => {
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
        const api = new ServiceApi(() => factoryResult, () => 'user');
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
        expect(opts?.account).toBe('currentUser');
        expect(opts?.startType).toBe('Automatic');
        expect(opts?.maxRestartAttempts).toBe(3);
        expect(opts?.envVars.DEPS_PATH).toBeDefined();
    });

    it('POST /install calls client.install with LocalSystem for system scope', async () => {
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
        const api = new ServiceApi(() => factoryResult, () => 'system');
        const { req, res } = makeReqRes('/api/service/install', 'POST');
        await api.handle(req, res);
        const body = JSON.parse((res as any).getBody());
        expect(body.installMode).toBe('system-service');
        expect(installFn.mock.calls[0]?.[0].account).toBe('LocalSystem');
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
        const api = new ServiceApi(() => factoryResult, () => 'user');
        const { req, res } = makeReqRes('/api/service/install', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(500);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/Service already exists/);
    });

    it('POST /uninstall calls stop then uninstall and reverts installMode', async () => {
        const stopFn = vi.fn(async () => undefined);
        const uninstallFn = vi.fn(async () => undefined);
        const client = fakeClient({
            stop: stopFn,
            uninstall: uninstallFn,
            status: vi.fn(async () => 'not-installed' as const),
        });
        // Seed installMode='user-service' before uninstall.
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
        expect(stopFn).toHaveBeenCalledWith('WsScrcpyWeb');
        expect(uninstallFn).toHaveBeenCalledWith('WsScrcpyWeb');
    });

    it('POST /uninstall ignores stop() failures and proceeds to uninstall', async () => {
        const stopFn = vi.fn(async () => {
            throw new Error('not running');
        });
        const uninstallFn = vi.fn(async () => undefined);
        const client = fakeClient({
            stop: stopFn,
            uninstall: uninstallFn,
            status: vi.fn(async () => 'not-installed' as const),
        });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(() => factoryResult, () => 'user');
        const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        expect(uninstallFn).toHaveBeenCalled();
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
        expect(JSON.parse((res as any).getBody())).toEqual({
            ok: false,
            error: expect.stringContaining('access denied'),
        });
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
            expect(opts?.account).toBe('currentUser');
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
            expect(opts?.account).toBe('LocalSystem');
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
});
