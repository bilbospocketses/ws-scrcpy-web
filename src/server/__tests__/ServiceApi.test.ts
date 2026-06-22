import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WS_SCRCPY_SERVICE_NAME } from '../../common/ServiceEvents';
import { buildUninstallHelperArgs, defaultRunElevated, ServiceApi } from '../api/ServiceApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import type { ServiceClient, ServiceClientFactoryResult } from '../service/ServiceClient';
import {
    DECLINE_MARKER_NAME,
    STAGED_SYSTEM_APPIMAGE,
    STAGED_SYSTEM_DIR,
    SYSTEM_STATE_DIR,
} from '../service/SystemdClient';

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
        PROGRAMDATA: process.env['PROGRAMDATA'],
        XDG_DATA_HOME: process.env['XDG_DATA_HOME'],
        DATA_ROOT: process.env['DATA_ROOT'],
    };

    beforeEach(() => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-svc-api-'));
        tmpDirs.push(tmpRoot);
        const configPath = path.join(tmpRoot, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({}));
        process.env[EnvName.CONFIG_PATH] = configPath;
        process.env['DEPS_PATH'] = path.join(tmpRoot, 'deps');
        // Redirect PROGRAMDATA to tmpRoot so Config.resolveDataRoot (which reads
        // process.env['PROGRAMDATA'] directly on Windows) resolves cfg.dataRoot
        // to <tmpRoot>\WsScrcpyWeb. Without this, control-marker writes
        // (local-appimage, uninstall-pending) land in the REAL C:\ProgramData
        // on every test run. With it, all such writes land inside tmpRoot, which
        // afterEach rmSyncs recursively — fully hermetic.
        process.env['PROGRAMDATA'] = tmpRoot;
        // On Linux, resolveDataRoot ignores PROGRAMDATA. Redirect via XDG_DATA_HOME
        // instead (DATA_ROOT has higher priority and must not leak from the runner env,
        // so clear it first). This makes cfg.dataRoot resolve to <tmpRoot>/WsScrcpyWeb
        // on Linux too — mirroring the Windows PROGRAMDATA redirect — so marker writes
        // land inside tmpRoot and are cleaned up by afterEach rmSync.
        delete process.env['DATA_ROOT'];
        process.env['XDG_DATA_HOME'] = tmpRoot;
        Config._resetForTest();
    });

    afterEach(() => {
        // Capture paths that need cleanup BEFORE resetting the Config singleton.
        let uninstallMarkerPath: string | undefined;
        try {
            uninstallMarkerPath = Config.getInstance().uninstallPendingMarkerPath;
        } catch {
            /* no singleton */
        }

        Config._resetForTest();
        if (savedEnv.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
        else process.env[EnvName.CONFIG_PATH] = savedEnv.CONFIG;
        if (savedEnv.DEPS === undefined) delete process.env['DEPS_PATH'];
        else process.env['DEPS_PATH'] = savedEnv.DEPS;
        if (savedEnv.PROGRAMDATA === undefined) delete process.env['PROGRAMDATA'];
        else process.env['PROGRAMDATA'] = savedEnv.PROGRAMDATA;
        if (savedEnv.XDG_DATA_HOME === undefined) delete process.env['XDG_DATA_HOME'];
        else process.env['XDG_DATA_HOME'] = savedEnv.XDG_DATA_HOME;
        if (savedEnv.DATA_ROOT === undefined) delete process.env['DATA_ROOT'];
        else process.env['DATA_ROOT'] = savedEnv.DATA_ROOT;
        while (tmpDirs.length) {
            const d = tmpDirs.pop()!;
            try {
                fs.rmSync(d, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        }
        // Clean up the uninstall-pending marker (may live outside tmpDirs on
        // Windows when dataRoot resolves to ProgramData rather than the tmp dir).
        if (uninstallMarkerPath) {
            try {
                fs.rmSync(uninstallMarkerPath, { force: true });
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

    describe('defaultRunElevated argv[0] validation (#26)', () => {
        it('refuses a non-absolute argv[0] instead of PATH-resolving it in the elevated runner', async () => {
            const r = await defaultRunElevated(['pkexec', '/usr/bin/true']);
            expect(r.code).not.toBe(0);
            expect(r.stderr).toMatch(/absolute, existing path/i);
        });

        it('refuses an absolute but non-existent argv[0]', async () => {
            const r = await defaultRunElevated([path.join(os.tmpdir(), 'definitely-missing-elevator-binary'), 'x']);
            expect(r.code).not.toBe(0);
            expect(r.stderr).toMatch(/absolute, existing path/i);
        });
    });

    it('linux system-scope install: refuses to elevate when $APPIMAGE is not an absolute path (#26)', async () => {
        const elevatedCalls: string[][] = [];
        const savedAppImage = process.env['APPIMAGE'];
        process.env['APPIMAGE'] = 'relative/WsScrcpyWeb.AppImage'; // non-absolute → guard fires before pkexec
        try {
            const api = new ServiceApi(
                () =>
                    ({
                        supported: true,
                        platform: 'linux',
                        client: fakeClient(),
                    }) as unknown as ServiceClientFactoryResult,
                () => 'system', // scope() — linux install reads requested scope from the body, so this is unused here
                () => true, // existsCheck (the binPath guard is absolute-only; existence is not checked)
                () => {}, // spawnDetached
                () => {}, // scheduleExit
                async () => '', // runPkexecFn
                async () => true, // verifyServiceActive
                (argv) => {
                    elevatedCalls.push(argv);
                    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
                }, // runElevated
            );
            const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'system' }));
            await api.handle(req, res);
            // The absolute-path guard fires BEFORE any elevation.
            expect(elevatedCalls).toHaveLength(0);
            expect((res as any).getStatus()).toBe(500);
            expect((res as any).getBody()).toMatch(/absolute app binary/i);
        } finally {
            if (savedAppImage === undefined) delete process.env['APPIMAGE'];
            else process.env['APPIMAGE'] = savedAppImage;
        }
    });

    it('system-scope uninstall: teardown spawn sets DATA_ROOT (else the helper panics in data_root_for_linux at startup — beta.60 #9 5.1)', async () => {
        const spawned: { cmd: string; args: string[] }[] = [];
        const api = new ServiceApi(
            () => ({ supported: true, platform: 'linux', client: { getInstalledScope: async () => 'system' } }) as any,
            () => 'system',
            () => true,
            (cmd, args) => {
                spawned.push({ cmd, args });
            },
        );
        const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
        await api.handle(req, res);
        expect(spawned).toHaveLength(1);
        // a `systemd-run --system` transient unit has no HOME/XDG either, so without
        // DATA_ROOT the launcher panics before running any teardown command.
        expect(spawned[0]!.args).toContain('--setenv=DATA_ROOT=/var/lib/ws-scrcpy-web');
        expect(spawned[0]!.args).toContain('--linux-service-teardown');
    });

    it('GET /status returns supported=false envelope on unsupported platforms', async () => {
        const factoryResult: ServiceClientFactoryResult = {
            client: fakeClient(),
            supported: false,
            platform: 'linux',
            unsupportedReason: 'Linux service mode lands later in SP3 — for now, run from source',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'system',
        );
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
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
        );
        const { req, res } = makeReqRes('/api/service/status');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        const body = JSON.parse((res as any).getBody());
        expect(body.supported).toBe(true);
        expect(body.platform).toBe('win32');
        expect(body.status).toBe('running');
        // configMtime is present because config.json exists on disk (written by beforeEach)
        expect(typeof body.configMtime).toBe('number');
        expect(client.status).toHaveBeenCalledWith('WsScrcpyWeb');
    });

    it('GET /status includes diskWebPort and configMtime from disk when supported', async () => {
        const cfg = Config.getInstance();
        cfg.updateAppConfig({ webPort: 9001 });

        const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
        );
        const { req, res } = makeReqRes('/api/service/status');
        await api.handle(req, res);
        const body = JSON.parse((res as any).getBody());
        expect(body.supported).toBe(true);
        expect(body.diskWebPort).toBe(9001);
        expect(typeof body.configMtime).toBe('number');
        expect(body.configMtime).toBeGreaterThan(0);
    });

    it('GET /status surfaces installMode so the frontend can show the active scope', async () => {
        // The settings modal uses this to pre-select + disable the scope
        // radios when a Linux service is already installed. Round-trip the
        // config value through the status endpoint to confirm it lands in
        // the response body (not gated by platform).
        const cfg = Config.getInstance();
        cfg.updateAppConfig({ installMode: 'system-service' });

        const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'linux',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
        );
        const { req, res } = makeReqRes('/api/service/status');
        await api.handle(req, res);
        const body = JSON.parse((res as any).getBody());
        expect(body.installMode).toBe('system-service');
    });

    it('GET /status surfaces the filesystem scope from client.getInstalledScope', async () => {
        // Bug fix: the Linux scope radio must reflect the actual installed unit
        // (filesystem truth), not the mutable installMode. ServiceApi calls
        // getInstalledScope when the client implements it (SystemdClient only).
        const client = fakeClient({
            status: vi.fn(async () => 'stopped' as const),
            getInstalledScope: vi.fn(async () => 'user' as const),
        });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'linux',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
        );
        const { req, res } = makeReqRes('/api/service/status');
        await api.handle(req, res);
        const body = JSON.parse((res as any).getBody());
        expect(body.scope).toBe('user');
        expect(client.getInstalledScope).toHaveBeenCalledWith('WsScrcpyWeb');
    });

    it('GET /status on linux reports machineWideInstalled + systemInstallDeclined from existsCheck', async () => {
        // The frontend reads these two flags off /api/service/status to (a) gate
        // the system-scope service-install button (machineWideInstalled) and (b)
        // decide whether to show the first-run machine-wide-install modal
        // (systemInstallDeclined). Both derive from the injected existsCheck so
        // the API stays testable without touching the real filesystem.
        const cfg = Config.getInstance();
        const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
        const optAppImage = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
        const declineMarker = path.join(dataRoot, 'control', DECLINE_MARKER_NAME);
        // /opt AppImage present, decline marker absent.
        const existsCheck = vi.fn((p: string) => p === optAppImage);

        const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'linux',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
            existsCheck,
        );
        const { req, res } = makeReqRes('/api/service/status');
        await api.handle(req, res);
        const body = JSON.parse((res as any).getBody());
        expect(body.machineWideInstalled).toBe(true);
        expect(body.systemInstallDeclined).toBe(false);
        // Confirms the two paths the impl checks (so a path-shape regression fails here).
        expect(existsCheck).toHaveBeenCalledWith(optAppImage);
        expect(existsCheck).toHaveBeenCalledWith(declineMarker);
    });

    it('GET /status on linux reflects the inverse existsCheck (not machine-wide, declined)', async () => {
        const cfg = Config.getInstance();
        const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
        const declineMarker = path.join(dataRoot, 'control', DECLINE_MARKER_NAME);
        // /opt AppImage absent, decline marker present.
        const existsCheck = (p: string) => p === declineMarker;

        const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'linux',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
            existsCheck,
        );
        const { req, res } = makeReqRes('/api/service/status');
        await api.handle(req, res);
        const body = JSON.parse((res as any).getBody());
        expect(body.machineWideInstalled).toBe(false);
        expect(body.systemInstallDeclined).toBe(true);
    });

    it('GET /status on win32 omits machineWideInstalled + systemInstallDeclined (linux-only fields)', async () => {
        const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
            () => true,
        );
        const { req, res } = makeReqRes('/api/service/status');
        await api.handle(req, res);
        const body = JSON.parse((res as any).getBody());
        expect(body.machineWideInstalled).toBeUndefined();
        expect(body.systemInstallDeclined).toBeUndefined();
    });

    it('POST /install returns 501 with unsupportedReason on unsupported platforms', async () => {
        const factoryResult: ServiceClientFactoryResult = {
            client: fakeClient(),
            supported: false,
            platform: 'linux',
            unsupportedReason: 'nope',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'system',
        );
        const { req, res } = makeReqRes('/api/service/install', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(501);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.error).toBe('nope');
        expect(body.reason).toBe('unsupported');
    });

    it('POST /install calls client.install with installMode=user-service for user scope', async () => {
        const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
            async () => undefined,
        );
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
        const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
            async () => undefined,
        );
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
        );
        const { req, res } = makeReqRes('/api/service/install', 'POST');
        await api.handle(req, res);
        const body = JSON.parse((res as any).getBody());
        expect(body.installMode).toBe('system-service');
        expect((installFn.mock.calls[0]?.[0] as { account?: unknown }).account).toBeUndefined();
    });

    it('POST /install on win32 returns configMtime + diskWebPort (no redirectTo, no discover)', async () => {
        const client = fakeClient({
            status: vi.fn(async () => 'running' as const),
            install: vi.fn(async () => undefined),
        });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
            () => true,
        );
        const { req, res } = makeReqRes('/api/service/install', 'POST', '{}');
        await api.handle(req, res);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(true);
        expect(body.redirectTo).toBeUndefined();
        expect(typeof body.configMtime).toBe('number');
        expect(body.configMtime).toBeGreaterThan(0);
        expect(typeof body.diskWebPort).toBe('number');
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
            throw new ServiceInstallError('user declined elevation. Service install requires Administrator', {
                ok: false,
                exitCode: -1,
                stdout: '',
                stderr: '',
                errorMessage: 'user declined elevation. Service install requires Administrator',
            });
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
        );
        const { req, res } = makeReqRes('/api/service/install', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(403);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/declined elevation/i);
    });

    it('POST /install returns 500 when the launcher exe is missing (dev runs)', async () => {
        const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
            async () => undefined,
        );
        const client = fakeClient({ install: installFn });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        // existsCheck returns false — service install can't proceed without
        // the packaged launcher binary. Caller gets a clear 500 with the
        // expected path mentioned, NOT a confusing Servy error message.
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
            () => false,
        );
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
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
        );
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
            throw new ServiceInstallError('user declined elevation. Service uninstall requires Administrator', {
                ok: false,
                exitCode: -1,
                stdout: '',
                stderr: '',
                errorMessage: 'user declined elevation. Service uninstall requires Administrator',
            });
        });
        const client = fakeClient({ uninstall: uninstallFn as any });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
        );
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
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
        );
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
    // 'user' when absent. System-scope from a non-root process is forwarded
    // to the client; SystemdClient.install() handles elevation internally
    // via pkexec (PR #211). The API itself stays unelevated. The pre-#211
    // API-boundary 403 guard was removed because it short-circuited the
    // pkexec path and surfaced "Relaunch the AppImage with sudo" instead of
    // a password prompt.
    describe('Linux scope branch', () => {
        // The /opt-staged AppImage (bin_t) the system-scope teardown execs.
        const expectedAppImage = `${STAGED_SYSTEM_DIR}/${STAGED_SYSTEM_APPIMAGE}`;
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
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
                async () => undefined,
            );
            const client = fakeClient({
                install: installFn,
                status: vi.fn(async () => 'running' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const api = new ServiceApi(
                () => factoryResult,
                () => 'system' /* should be ignored on Linux */,
            );
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
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
                async () => undefined,
            );
            const client = fakeClient({
                install: installFn,
                status: vi.fn(async () => 'running' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const api = new ServiceApi(
                () => factoryResult,
                () => 'system',
            );
            const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'user' }));
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(200);
            const opts = installFn.mock.calls[0]?.[0];
            expect(opts?.scope).toBe('user');
        });

        it('POST /install Linux system scope hands off via pkexec (status shutting-down), no client.install, no in-handler verify', async () => {
            // Task 7: system-scope install goes through runElevated, not client.install.
            // Response is still shutting-down; no verifyServiceActive poll needed since
            // the rootful core (running as root via pkexec) handles enable+start.
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
                async () => undefined,
            );
            const statusFn = vi.fn(async () => 'running' as const);
            const client = fakeClient({ install: installFn, status: statusFn });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const runElevated = vi.fn(async (_argv: string[]) => ({ code: 0, stdout: '', stderr: '' }));
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => false,
                () => {},
                () => {},
                async () => '',
                async () => true,
                runElevated,
            );
            const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'system' }));
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(true);
            expect(body.installMode).toBe('system-service');
            expect(body.status).toBe('shutting-down');
            // runElevated called; client.install and client.status NOT called
            expect(runElevated).toHaveBeenCalledOnce();
            expect(installFn).not.toHaveBeenCalled();
            expect(statusFn).not.toHaveBeenCalled();
        });

        // ── Linux system-scope install: awaited pkexec <appimage> --install-system-service ──
        //
        // The new path: instead of calling client.install() (which ran pkexec sh -c
        // "<inline-script>" with a kill timeout), we elevate the WHOLE APP once via an
        // awaited pkexec so the root core (installSystemService) handles staging + unit.
        // The local copy exits to free the port; the unit's Restart=on-failure covers
        // the port takeover. No timeout, no kill, no EPERM class.

        it('POST /install Linux system scope: runElevated called with pkexec argv, client.install NOT called, response shutting-down', async () => {
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
                async () => undefined,
            );
            const client = fakeClient({ install: installFn, status: vi.fn(async () => 'running' as const) });
            const factoryResult: ServiceClientFactoryResult = { client, supported: true, platform: 'linux' };

            const savedAppImage = process.env['APPIMAGE'];
            process.env['APPIMAGE'] = '/home/jamie/Applications/WsScrcpyWeb.AppImage';
            try {
                const elevatedArgv: string[][] = [];
                const runElevated = vi.fn(async (argv: string[]) => {
                    elevatedArgv.push(argv);
                    return { code: 0, stdout: '', stderr: '' };
                });

                // Constructor: (factory, scope, existsCheck, spawnDetached, scheduleExit, runPkexecFn, verifyServiceActive, runElevated)
                const api = new ServiceApi(
                    () => factoryResult,
                    () => 'user',
                    () => false,
                    () => {
                        /* no spawn */
                    },
                    () => {
                        /* no-op scheduleExit — never calls process.exit */
                    },
                    async () => '',
                    async () => true,
                    runElevated,
                );
                const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'system' }));
                await api.handle(req, res);

                // (a) runElevated called once
                expect(runElevated).toHaveBeenCalledOnce();

                // (b) argv[0] matches /pkexec$/ (resolved absolute path via resolveSystemTool)
                const argv = elevatedArgv[0]!;
                expect(argv[0]).toMatch(/pkexec$/);

                // (c) argv contains the appimage binary as next element
                expect(argv[1]).toBe('/home/jamie/Applications/WsScrcpyWeb.AppImage');

                // (d) argv contains the CLI flags, and --port is immediately
                // followed by the configured webPort (forwarded verbatim).
                expect(argv).toContain('--install-system-service');
                const portFlagIdx = argv.indexOf('--port');
                expect(portFlagIdx).toBeGreaterThanOrEqual(0);
                const expectedPort = String(Config.getInstance().getAppConfig().webPort);
                expect(argv[portFlagIdx + 1]).toBe(expectedPort);

                // (e) client.install must NOT be called (system scope exits early)
                expect(installFn).not.toHaveBeenCalled();

                // (f) response: 200, ok:true, status:shutting-down
                expect((res as any).getStatus()).toBe(200);
                const body = JSON.parse((res as any).getBody());
                expect(body.ok).toBe(true);
                expect(body.status).toBe('shutting-down');
                expect(body.installMode).toBe('system-service');
            } finally {
                if (savedAppImage === undefined) delete process.env['APPIMAGE'];
                else process.env['APPIMAGE'] = savedAppImage;
            }
        });

        it('POST /install Linux system scope: runElevated returns code 126 → 403 uac-declined + installMode reverted', async () => {
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
                async () => undefined,
            );
            const client = fakeClient({ install: installFn, status: vi.fn(async () => 'not-installed' as const) });
            const factoryResult: ServiceClientFactoryResult = { client, supported: true, platform: 'linux' };

            const runElevated = vi.fn(async (_argv: string[]) => ({ code: 126, stdout: '', stderr: '' }));

            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => false,
                () => {
                    /* no spawn */
                },
                () => {
                    /* no-op scheduleExit */
                },
                async () => '',
                async () => true,
                runElevated,
            );

            // Persist a known initial installMode so we can verify revert
            Config.getInstance().updateAppConfig({ installMode: 'user' });

            const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'system' }));
            await api.handle(req, res);

            // (a) runElevated called
            expect(runElevated).toHaveBeenCalledOnce();

            // (b) 403 with uac-declined reason
            expect((res as any).getStatus()).toBe(403);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(false);
            expect(body.reason).toBe('uac-declined');

            // (c) installMode reverted back to 'user' (not 'system-service')
            expect(Config.getInstance().getAppConfig().installMode).toBe('user');

            // (d) client.install never called
            expect(installFn).not.toHaveBeenCalled();
        });

        it('POST /install Linux system scope: runElevated returns code 1 with stderr → 500 servy-failure + installMode reverted', async () => {
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
                async () => undefined,
            );
            const client = fakeClient({ install: installFn, status: vi.fn(async () => 'not-installed' as const) });
            const factoryResult: ServiceClientFactoryResult = { client, supported: true, platform: 'linux' };

            const runElevated = vi.fn(async (_argv: string[]) => ({
                code: 1,
                stdout: '',
                stderr: 'boom: unit enable failed',
            }));

            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => false,
                () => {
                    /* no spawn */
                },
                () => {
                    /* no-op scheduleExit */
                },
                async () => '',
                async () => true,
                runElevated,
            );

            Config.getInstance().updateAppConfig({ installMode: 'user' });

            const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'system' }));
            await api.handle(req, res);

            // (a) 500 with servy-failure reason
            expect((res as any).getStatus()).toBe(500);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(false);
            expect(body.reason).toBe('servy-failure');
            expect(body.error).toContain('boom');

            // (b) installMode reverted
            expect(Config.getInstance().getAppConfig().installMode).toBe('user');

            // (c) client.install never called
            expect(installFn).not.toHaveBeenCalled();
        });

        it('POST /install on Linux with $APPIMAGE set writes local-appimage marker to <dataRoot>/control/local-appimage', async () => {
            const appImagePath = '/home/jamie/Applications/WsScrcpyWeb.AppImage';
            const savedAppImage = process.env['APPIMAGE'];
            process.env['APPIMAGE'] = appImagePath;
            try {
                const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
                    async () => undefined,
                );
                const client = fakeClient({
                    install: installFn,
                    status: vi.fn(async () => 'running' as const),
                });
                const factoryResult: ServiceClientFactoryResult = {
                    client,
                    supported: true,
                    platform: 'linux',
                };
                const api = new ServiceApi(
                    () => factoryResult,
                    () => 'user',
                );
                const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'user' }));
                await api.handle(req, res);
                expect((res as any).getStatus()).toBe(200);

                // Verify the marker landed on disk with the correct content.
                // PROGRAMDATA is redirected to tmpRoot in beforeEach, so
                // cfg.dataRoot resolves inside tmpRoot (cleaned by afterEach).
                const cfg = Config.getInstance();
                const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
                const markerPath = path.join(dataRoot, 'control', 'local-appimage');
                expect(fs.existsSync(markerPath)).toBe(true);
                expect(fs.readFileSync(markerPath, 'utf8')).toBe(appImagePath);
            } finally {
                if (savedAppImage === undefined) delete process.env['APPIMAGE'];
                else process.env['APPIMAGE'] = savedAppImage;
            }
        });

        it('POST /install on Linux without $APPIMAGE does NOT write local-appimage marker', async () => {
            const savedAppImage = process.env['APPIMAGE'];
            delete process.env['APPIMAGE'];
            try {
                const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
                    async () => undefined,
                );
                const client = fakeClient({
                    install: installFn,
                    status: vi.fn(async () => 'running' as const),
                });
                const factoryResult: ServiceClientFactoryResult = {
                    client,
                    supported: true,
                    platform: 'linux',
                };
                const api = new ServiceApi(
                    () => factoryResult,
                    () => 'user',
                );
                const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'user' }));
                await api.handle(req, res);
                expect((res as any).getStatus()).toBe(200);

                // Marker must NOT exist when APPIMAGE is unset. tmpRoot is fresh
                // per-test (beforeEach), so no stale marker can leak in.
                const cfg = Config.getInstance();
                const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
                const markerPath = path.join(dataRoot, 'control', 'local-appimage');
                expect(fs.existsSync(markerPath)).toBe(false);
            } finally {
                if (savedAppImage === undefined) delete process.env['APPIMAGE'];
                else process.env['APPIMAGE'] = savedAppImage;
            }
        });

        it('POST /install on Linux with malformed JSON body falls back to user scope', async () => {
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
                async () => undefined,
            );
            const client = fakeClient({
                install: installFn,
                status: vi.fn(async () => 'running' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const api = new ServiceApi(
                () => factoryResult,
                () => 'system',
            );
            const { req, res } = makeReqRes('/api/service/install', 'POST', 'not-json{');
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(200);
            const opts = installFn.mock.calls[0]?.[0];
            expect(opts?.scope).toBe('user');
        });

        it('POST /install on Linux uses $APPIMAGE as binPath (stable systemd ExecStart)', async () => {
            // The server runs as a Node child of the launcher, so
            // process.execPath is the Node binary — using it as ExecStart would
            // start Node with no script (REPL/immediate-exit under systemd) and
            // the service would never bind a port. ExecStart must be the stable
            // .AppImage entry exposed via $APPIMAGE.
            const savedAppImage = process.env['APPIMAGE'];
            process.env['APPIMAGE'] = '/home/jamie/Applications/WsScrcpyWeb.AppImage';
            try {
                const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
                    async () => undefined,
                );
                const client = fakeClient({
                    install: installFn,
                    status: vi.fn(async () => 'running' as const),
                });
                const factoryResult: ServiceClientFactoryResult = {
                    client,
                    supported: true,
                    platform: 'linux',
                };
                const api = new ServiceApi(
                    () => factoryResult,
                    () => 'user',
                );
                const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'user' }));
                await api.handle(req, res);
                expect((res as any).getStatus()).toBe(200);
                const opts = installFn.mock.calls[0]?.[0];
                expect(opts?.binPath).toBe('/home/jamie/Applications/WsScrcpyWeb.AppImage');
                expect(opts?.startupDir).toBe('/home/jamie/Applications');
            } finally {
                if (savedAppImage === undefined) delete process.env['APPIMAGE'];
                else process.env['APPIMAGE'] = savedAppImage;
            }
        });

        // ── Linux system-scope install: pkexec path (linuxHelperSource removed, Task 7) ───
        //
        // Task 7: system-scope install now uses runElevated([pkexec, binPath,
        // '--install-system-service', '--port', N]) and never calls client.install().
        // linuxHelperSource is no longer resolved or passed; the root core
        // (installSystemService) stages /opt directly.

        it('POST /install on Linux system scope uses runElevated, client.install NOT called (helper candidate irrelevant)', async () => {
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
                async () => undefined,
            );
            const client = fakeClient({
                install: installFn,
                status: vi.fn(async () => 'running' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };

            // Even if the helper candidate exists, system scope goes via runElevated now.
            const cfg = Config.getInstance();
            const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
            const helperDir = path.join(dataRoot, 'control', 'operation-server');
            fs.mkdirSync(helperDir, { recursive: true });
            fs.writeFileSync(path.join(helperDir, 'ws-scrcpy-web-launcher.exe'), '', 'utf8');

            const runElevated = vi.fn(async (_argv: string[]) => ({ code: 0, stdout: '', stderr: '' }));
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                () => {},
                () => {},
                async () => '',
                async () => true,
                runElevated,
            );
            const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'system' }));
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(200);

            expect(runElevated).toHaveBeenCalledOnce();
            expect(installFn).not.toHaveBeenCalled();
            const body = JSON.parse((res as any).getBody());
            expect(body.status).toBe('shutting-down');
        });

        it('POST /install on Linux system scope uses runElevated regardless of helper absence', async () => {
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
                async () => undefined,
            );
            const client = fakeClient({
                install: installFn,
                status: vi.fn(async () => 'running' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };

            // No helper candidate — existsCheck returns false. Still uses runElevated.
            const runElevated = vi.fn(async (_argv: string[]) => ({ code: 0, stdout: '', stderr: '' }));
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => false,
                () => {},
                () => {},
                async () => '',
                async () => true,
                runElevated,
            );
            const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'system' }));
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(200);

            expect(runElevated).toHaveBeenCalledOnce();
            expect(installFn).not.toHaveBeenCalled();
        });

        it('POST /install on Linux user scope does NOT use runElevated (user scope calls client.install)', async () => {
            // User scope is unchanged — still calls client.install() directly.
            const installFn = vi.fn<(opts: Parameters<ServiceClient['install']>[0]) => Promise<void>>(
                async () => undefined,
            );
            const client = fakeClient({
                install: installFn,
                status: vi.fn(async () => 'running' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };

            const runElevated = vi.fn(async (_argv: string[]) => ({ code: 0, stdout: '', stderr: '' }));
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => false,
                () => {},
                () => {},
                async () => '',
                async () => true,
                runElevated,
            );
            const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'user' }));
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(200);

            const opts = installFn.mock.calls[0]?.[0];
            expect(opts?.scope).toBe('user');
            // runElevated must NOT be called for user scope
            expect(runElevated).not.toHaveBeenCalled();
        });

        // ── Linux uninstall — systemd-run teardown handoff (item 32) ───────────
        //
        // On Linux, uninstall MUST NOT call client.uninstall() because this Node
        // process runs inside the service unit's own cgroup — stopping the unit
        // from within it would kill us mid-call (no clean teardown, no relaunch).
        // Instead, ServiceApi hands off to an out-of-cgroup helper via systemd-run,
        // which runs in a transient unit, survives stopping our unit, then tears
        // down + (user scope) relaunches local. Mirrors the Windows operation-server
        // handoff on the service-context (LocalSystem) uninstall path.

        it('POST /uninstall on Linux does NOT call client.uninstall(), reverts installMode to user, spawns systemd-run teardown helper', async () => {
            const uninstallSpy = vi.fn(async () => undefined);
            const client = fakeClient({
                uninstall: uninstallSpy,
                status: vi.fn(async () => 'running' as const),
                getInstalledScope: vi.fn(async () => 'user' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };

            let spawnedCmd = '';
            let spawnedArgs: string[] = [];
            const spawnDetached = vi.fn((cmd: string, args: string[]) => {
                spawnedCmd = cmd;
                spawnedArgs = args;
            });

            Config.getInstance().updateAppConfig({ installMode: 'user-service' });

            // Pass spawnDetached as 4th constructor arg (injectable for tests).
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                spawnDetached,
            );
            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            // (a) Must NOT call client.uninstall()
            expect(uninstallSpy).not.toHaveBeenCalled();

            // (b) installMode must be reverted to 'user' (local mode, user scope)
            expect(Config.getInstance().getAppConfig().installMode).toBe('user');

            // (c) spawnDetached must have been invoked with systemd-run + correct args
            expect(spawnDetached).toHaveBeenCalledTimes(1);
            // systemd-run resolved via resolveSystemTool — on a non-Linux host it
            // falls back to the bare name 'systemd-run' (no /usr/bin/systemd-run on Windows).
            expect(spawnedCmd).toMatch(/systemd-run/);
            // user scope → --user flag present
            expect(spawnedArgs).toContain('--user');
            expect(spawnedArgs).toContain('--collect');
            // teardown args forwarded to the helper
            expect(spawnedArgs).toContain('--linux-service-teardown');
            expect(spawnedArgs).toContain('--scope');
            expect(spawnedArgs).toContain('user');
            expect(spawnedArgs).toContain('--unit');
            expect(spawnedArgs).toContain('WsScrcpyWeb');
            // helper path uses the operation-server staged name (same .exe suffix as UpdateService)
            const helperArg = spawnedArgs.find((a) => a.endsWith('ws-scrcpy-web-launcher.exe'));
            expect(helperArg).toBeDefined();
            expect(helperArg).toContain('operation-server');

            // (d) Response: { ok: true, status: 'shutting-down' }
            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(true);
            expect(body.status).toBe('shutting-down');
            expect(body.installMode).toBe('user');
        });

        it('POST /uninstall on Linux with scope=null (not-installed) returns not-installed, no spawn', async () => {
            const client = fakeClient({
                uninstall: vi.fn(async () => undefined),
                status: vi.fn(async () => 'not-installed' as const),
                getInstalledScope: vi.fn(async () => null),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };

            const spawnDetached = vi.fn();
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                spawnDetached,
            );
            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            // Not installed — no spawn, no uninstall call
            expect(spawnDetached).not.toHaveBeenCalled();
            expect(client.uninstall).not.toHaveBeenCalled();

            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(true);
            expect(body.status).toBe('not-installed');
        });

        // ── Linux system-scope uninstall: /opt bin_t helper + pkexec (#2 uninstall) ──
        //
        // System-scope uninstall must exec the /opt-staged launcher copy (labelled
        // bin_t by the install-side fcontext rule) rather than the home-copy
        // (data_home_t) — init_t may NOT exec data_home_t → SELinux AVC → teardown
        // never runs → service persists after uninstall. Uses systemd-run --system
        // (not --user) so it escapes the service cgroup. Wraps in pkexec when the
        // serving process is NOT already root (system service itself runs as root).

        it('system-scope uninstall execs the /opt staged AppImage (bin_t) via systemd-run --system, root → no pkexec', async () => {
            Object.defineProperty(process, 'getuid', { value: () => 0, configurable: true });
            const client = fakeClient({
                uninstall: vi.fn(async () => undefined),
                status: vi.fn(async () => 'running' as const),
                getInstalledScope: vi.fn(async () => 'system' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };

            let spawnedCmd = '';
            let spawnedArgs: string[] = [];
            const spawnDetached = vi.fn((cmd: string, args: string[]) => {
                spawnedCmd = cmd;
                spawnedArgs = args;
            });

            Config.getInstance().updateAppConfig({ installMode: 'system-service' });

            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                spawnDetached,
            );
            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            // Root → cmd is systemd-run directly (no pkexec wrapper)
            expect(spawnedCmd).toMatch(/systemd-run$/);
            expect(spawnedArgs).toContain('--system');
            expect(spawnedArgs).not.toContain('--user');
            // --collect: reap the transient teardown unit (else it leaks persistently)
            expect(spawnedArgs).toContain('--collect');
            // DATA_ROOT MANDATORY: its omission caused the beta.60 #9 5.1 core-dump that
            // silently no-op'd uninstall — a regression dropping it must fail here.
            expect(spawnedArgs).toContain(`--setenv=DATA_ROOT=${SYSTEM_STATE_DIR}`);
            // Execs the /opt-staged AppImage (bin_t), NOT the un-staged launcher helper (.exe)
            expect(spawnedArgs).toContain(expectedAppImage);
            expect(spawnedArgs.some((a) => a.endsWith('.exe'))).toBe(false);
            // teardown args forwarded to the AppImage
            expect(spawnedArgs).toContain('--linux-service-teardown');
            expect(spawnedArgs).toContain('--scope');
            expect(spawnedArgs).toContain('system');
            expect(spawnedArgs).toContain(WS_SCRCPY_SERVICE_NAME);

            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(true);
            expect(body.status).toBe('shutting-down');
        });

        it('system-scope uninstall wraps in pkexec when the serving process is NOT root', async () => {
            Object.defineProperty(process, 'getuid', { value: () => 1000, configurable: true });
            const client = fakeClient({
                uninstall: vi.fn(async () => undefined),
                status: vi.fn(async () => 'running' as const),
                getInstalledScope: vi.fn(async () => 'system' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };

            let spawnedCmd = '';
            let spawnedArgs: string[] = [];
            const spawnDetached = vi.fn((cmd: string, args: string[]) => {
                spawnedCmd = cmd;
                spawnedArgs = args;
            });

            Config.getInstance().updateAppConfig({ installMode: 'system-service' });

            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                spawnDetached,
            );
            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            // Non-root → cmd is pkexec; systemd-run is the first arg
            expect(spawnedCmd).toMatch(/pkexec$/);
            expect(spawnedArgs[0]).toMatch(/systemd-run$/);
            expect(spawnedArgs).toContain('--system');
            expect(spawnedArgs).not.toContain('--user');
            // --collect: reap the transient teardown unit (else it leaks persistently)
            expect(spawnedArgs).toContain('--collect');
            // DATA_ROOT MANDATORY: its omission caused the beta.60 #9 5.1 core-dump that
            // silently no-op'd uninstall — a regression dropping it must fail here.
            expect(spawnedArgs).toContain(`--setenv=DATA_ROOT=${SYSTEM_STATE_DIR}`);
            // Execs the /opt-staged AppImage (bin_t), NOT the un-staged launcher helper (.exe)
            expect(spawnedArgs).toContain(expectedAppImage);
            expect(spawnedArgs.some((a) => a.endsWith('.exe'))).toBe(false);
            // teardown args forwarded to the AppImage (same as the root branch)
            expect(spawnedArgs).toContain('--linux-service-teardown');
            expect(spawnedArgs).toContain('--scope');
            expect(spawnedArgs).toContain('system');
            expect(spawnedArgs).toContain(WS_SCRCPY_SERVICE_NAME);

            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(true);
            expect(body.status).toBe('shutting-down');
        });

        it('schedules a prompt local-instance exit on Linux user-scope install (handoff frees the lock)', async () => {
            const scheduled: number[] = [];
            const scheduleExit = vi.fn((_fn: () => void, ms: number) => {
                scheduled.push(ms);
            });
            const client = fakeClient({
                install: vi.fn(async () => undefined),
                status: vi.fn(async () => 'running' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            // Constructor: factory, scope, existsCheck, spawnDetached, scheduleExit
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                vi.fn(), // spawnDetached (unused by install path)
                scheduleExit,
            );
            const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'user' }));
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(200);
            expect(scheduleExit).toHaveBeenCalledTimes(1);
            // F4: Linux user-scope now exits promptly so the handoff helper can
            // start the service once the per-user lock is free (was 15s blind).
            expect(scheduled[0]).toBe(1_500);
        });

        it('F3 (win32): rolls back when the service never becomes active — uninstall + revert installMode + ok:false, no exit', async () => {
            // Windows (and Linux system scope) keep the in-handler verify/rollback —
            // they don't share the user's single-instance lock. install() doesn't
            // surface a failed start, so verifyServiceActive=false must roll back
            // instead of blindly exiting the local instance.
            const uninstallFn = vi.fn(async () => undefined);
            const scheduleExit = vi.fn();
            const client = fakeClient({
                install: vi.fn(async () => undefined),
                uninstall: uninstallFn,
                status: vi.fn(async () => 'stopped' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            // Pre-existing local mode → rollback must restore it.
            Config.getInstance().updateAppConfig({ installMode: 'user' });
            // Constructor: factory, scope, existsCheck, spawnDetached, scheduleExit, runPkexecFn, verifyServiceActive
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true, // existsCheck → packaged launcher present
                vi.fn(), // spawnDetached
                scheduleExit,
                undefined, // runPkexecFn → default
                async () => false, // verifyServiceActive → service never came up
            );
            const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'user' }));
            await api.handle(req, res);

            // Dead unit removed; installMode reverted to the pre-install local mode.
            expect(uninstallFn).toHaveBeenCalledWith('WsScrcpyWeb');
            expect(Config.getInstance().getAppConfig().installMode).toBe('user');
            // Local instance is NOT sacrificed — the app stays alive.
            expect(scheduleExit).not.toHaveBeenCalled();
            // Caller gets a clear, categorized failure.
            expect((res as any).getStatus()).toBe(500);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(false);
            expect(body.reason).toBe('service-start-failed');
        });

        it('F3 (win32): keeps the install when the service becomes active (no rollback)', async () => {
            const uninstallFn = vi.fn(async () => undefined);
            const scheduleExit = vi.fn();
            const client = fakeClient({
                install: vi.fn(async () => undefined),
                uninstall: uninstallFn,
                status: vi.fn(async () => 'running' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                vi.fn(),
                scheduleExit,
                undefined,
                async () => true, // verifyServiceActive → up
            );
            const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'user' }));
            await api.handle(req, res);
            expect(uninstallFn).not.toHaveBeenCalled();
            expect(scheduleExit).toHaveBeenCalledTimes(1);
            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(true);
        });

        it('F4: Linux user-scope install hands off to the detached helper (no in-handler verify)', async () => {
            // The service can't start while THIS local instance holds the per-user
            // lock, so handleInstall enables the unit, spawns the out-of-cgroup
            // install-handoff helper via systemd-run, and exits promptly to free the
            // lock. The helper (not this handler) verifies + rolls back — so
            // verifyServiceActive must NOT be called on this path.
            const verifySpy = vi.fn(async () => true);
            const scheduleExit = vi.fn();
            let spawnedCmd = '';
            let spawnedArgs: string[] = [];
            const spawnDetached = vi.fn((cmd: string, args: string[]) => {
                spawnedCmd = cmd;
                spawnedArgs = args;
            });
            const client = fakeClient({
                install: vi.fn(async () => undefined),
                status: vi.fn(async () => 'running' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                spawnDetached,
                scheduleExit,
                undefined,
                verifySpy,
            );
            const { req, res } = makeReqRes('/api/service/install', 'POST', JSON.stringify({ scope: 'user' }));
            await api.handle(req, res);

            // Handoff helper spawned via systemd-run --user --collect.
            expect(spawnDetached).toHaveBeenCalledTimes(1);
            expect(spawnedCmd).toMatch(/systemd-run/);
            expect(spawnedArgs).toContain('--user');
            expect(spawnedArgs).toContain('--collect');
            expect(spawnedArgs).toContain('--linux-service-install-handoff');
            expect(spawnedArgs).toContain('--scope');
            expect(spawnedArgs).toContain('user');
            expect(spawnedArgs).toContain('--unit');
            expect(spawnedArgs).toContain('WsScrcpyWeb');
            const helperArg = spawnedArgs.find((a) => a.endsWith('ws-scrcpy-web-launcher.exe'));
            expect(helperArg).toBeDefined();
            expect(helperArg).toContain('operation-server');
            // local exits promptly to free the lock
            expect(scheduleExit).toHaveBeenCalledTimes(1);
            // the in-handler verify/rollback is NOT used on the Linux user path
            expect(verifySpy).not.toHaveBeenCalled();
            // responds shutting-down so the frontend reconnects through the gap
            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(true);
            expect(body.status).toBe('shutting-down');
        });

        it('user-scope uninstall is UNCHANGED (home helper, systemd-run --user, no pkexec)', async () => {
            // The existing user-scope test is the canonical; this twin makes the
            // regression explicit alongside the new system-scope tests.
            const uninstallSpy = vi.fn(async () => undefined);
            const client = fakeClient({
                uninstall: uninstallSpy,
                status: vi.fn(async () => 'running' as const),
                getInstalledScope: vi.fn(async () => 'user' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };

            let spawnedCmd = '';
            let spawnedArgs: string[] = [];
            const spawnDetached = vi.fn((cmd: string, args: string[]) => {
                spawnedCmd = cmd;
                spawnedArgs = args;
            });

            Config.getInstance().updateAppConfig({ installMode: 'user-service' });

            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                spawnDetached,
            );
            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            // client.uninstall must NOT be called (cgroup-escape handoff)
            expect(uninstallSpy).not.toHaveBeenCalled();
            // User scope → systemd-run --user, no pkexec
            expect(spawnedCmd).toMatch(/systemd-run$/);
            expect(spawnedArgs).toContain('--user');
            expect(spawnedArgs).not.toContain('--system');
            // Helper is the home copy (operation-server), NOT the /opt copy.
            // Use the same two-check pattern as the canonical user-scope test above
            // so the assertion works with both / and \ separators (test host is Windows).
            const userHelperArg = spawnedArgs.find((a) => a.endsWith('ws-scrcpy-web-launcher.exe'));
            expect(userHelperArg).toBeDefined();
            expect(userHelperArg).toContain('operation-server');

            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(true);
            expect(body.status).toBe('shutting-down');
        });
    });

    // ── machine-wide install + decline endpoints (B3) ────────────────────────
    describe('install-system-wide + decline-system-wide', () => {
        let savedPlatform: NodeJS.Platform;
        beforeEach(() => {
            savedPlatform = process.platform;
            // Force linux so the platform guard passes on any test-host OS.
            Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        });
        afterEach(() => {
            Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true });
        });

        it('POST /api/service/install-system-wide with $APPIMAGE set invokes pkexec runner once with cp + bin_t script, returns 200', async () => {
            const appImagePath = '/home/jamie/Applications/WsScrcpyWeb.AppImage';
            const savedAppImage = process.env['APPIMAGE'];
            process.env['APPIMAGE'] = appImagePath;
            try {
                const fakePkexec = vi.fn(async (_cmd: string, _label: string) => '');
                const api = new ServiceApi(undefined, undefined, undefined, undefined, undefined, fakePkexec);
                const { req, res } = makeReqRes('/api/service/install-system-wide', 'POST');
                await api.handle(req, res);

                expect((res as any).getStatus()).toBe(200);
                const body = JSON.parse((res as any).getBody());
                expect(body.ok).toBe(true);

                expect(fakePkexec).toHaveBeenCalledTimes(1);
                const [script, label] = fakePkexec.mock.calls[0]!;
                expect(script).toContain(`cp '${appImagePath}' "/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"`);
                expect(script).toContain('bin_t');
                expect(label).toBe('install-system-wide');
            } finally {
                if (savedAppImage === undefined) delete process.env['APPIMAGE'];
                else process.env['APPIMAGE'] = savedAppImage;
            }
        });

        it('POST /api/service/install-system-wide relaunches from /opt + exits (F5: no lingering home-mount process)', async () => {
            const savedAppImage = process.env['APPIMAGE'];
            process.env['APPIMAGE'] = '/home/jamie/Downloads/WsScrcpyWeb-linux-beta.AppImage';
            try {
                const fakePkexec = vi.fn(async (_cmd: string, _label: string) => '');
                const scheduleExit = vi.fn();
                let spawnedArgs: string[] = [];
                const spawnDetached = vi.fn((_cmd: string, args: string[]) => {
                    spawnedArgs = args;
                });
                // existsCheck → true for the relaunch helper (F5 hands off + exits) but FALSE for
                // kbuildsycoca, so refreshDesktopCaches no-ops (treated as non-KDE) and spawnDetached
                // stays at exactly 1 (the relaunch helper) for the assertion below.
                const api = new ServiceApi(
                    undefined,
                    undefined,
                    (p: string) => !p.includes('kbuildsycoca'),
                    spawnDetached,
                    scheduleExit,
                    fakePkexec,
                );
                const { req, res } = makeReqRes('/api/service/install-system-wide', 'POST');
                await api.handle(req, res);

                expect((res as any).getStatus()).toBe(200);
                const body = JSON.parse((res as any).getBody());
                expect(body.ok).toBe(true);
                expect(body.status).toBe('shutting-down');
                // relaunch-only helper targeting /opt, waiting on the launcher (flock holder).
                expect(spawnDetached).toHaveBeenCalledTimes(1);
                expect(spawnedArgs).toContain('--linux-apply');
                expect(spawnedArgs).toContain('--target');
                expect(spawnedArgs.some((a) => a.endsWith('/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage'))).toBe(true);
                expect(spawnedArgs).toContain('--wait-pid');
                expect(scheduleExit).toHaveBeenCalledTimes(1);
            } finally {
                if (savedAppImage === undefined) delete process.env['APPIMAGE'];
                else process.env['APPIMAGE'] = savedAppImage;
            }
        });

        it('POST /api/service/install-system-wide with $APPIMAGE unset returns 400, pkexec NOT called', async () => {
            const savedAppImage = process.env['APPIMAGE'];
            delete process.env['APPIMAGE'];
            try {
                const fakePkexec = vi.fn(async (_cmd: string, _label: string) => '');
                const api = new ServiceApi(undefined, undefined, undefined, undefined, undefined, fakePkexec);
                const { req, res } = makeReqRes('/api/service/install-system-wide', 'POST');
                await api.handle(req, res);

                expect((res as any).getStatus()).toBe(400);
                const body = JSON.parse((res as any).getBody());
                expect(body.ok).toBe(false);
                expect(fakePkexec).not.toHaveBeenCalled();
            } finally {
                if (savedAppImage === undefined) delete process.env['APPIMAGE'];
                else process.env['APPIMAGE'] = savedAppImage;
            }
        });

        it('POST /api/service/decline-system-wide writes decline marker under <dataRoot>/control and returns 200', async () => {
            const fakePkexec = vi.fn(async (_cmd: string, _label: string) => '');
            const api = new ServiceApi(undefined, undefined, undefined, undefined, undefined, fakePkexec);
            const { req, res } = makeReqRes('/api/service/decline-system-wide', 'POST');
            await api.handle(req, res);

            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(true);

            // Marker file must exist at <dataRoot>/control/system-install-declined
            const cfg = Config.getInstance();
            const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
            const markerPath = path.join(dataRoot, 'control', 'system-install-declined');
            expect(fs.existsSync(markerPath)).toBe(true);
        });
    });

    // ── app-uninstall (POST /api/service/uninstall-app) — beta.49 ─────────────
    //
    // Linux-only endpoint that spawns the detached Rust uninstall helper via
    // systemd-run. The arg vector is built by the pure buildUninstallHelperArgs
    // (unit-tested below without any process/systemd mocking); the handler wires
    // it to the live spawn + schedules the local-instance exit. On keep=true the
    // handler also resets installMode to null so the preserved config.json comes
    // back up in local mode (not phantom service mode) on next launch.

    describe('buildUninstallHelperArgs (pure)', () => {
        const base = {
            unit: '--unit=wsscrcpy-uninstall-123',
            helper: '/home/jamie/.local/share/WsScrcpyWeb/control/operation-server/ws-scrcpy-web-launcher.exe',
            dataRoot: '/home/jamie/.local/share/WsScrcpyWeb',
            relaunch: '/home/jamie/Applications/WsScrcpyWeb.AppImage',
        };

        it('non-root: --user --collect prefix, --wipe when keep=false, machine-wide 0, scope none', () => {
            const args = buildUninstallHelperArgs({
                isRoot: false,
                scope: 'none',
                machineWide: false,
                keep: false,
                ...base,
            });
            // Non-root → user manager: leading --user --collect, then unit, helper, mode flag.
            expect(args.slice(0, 5)).toEqual(['--user', '--collect', base.unit, base.helper, '--linux-app-uninstall']);
            expect(args).toContain('--wipe');
            expect(args).not.toContain('--keep');
            // Each value-flag is immediately followed by its value.
            expect(args[args.indexOf('--machine-wide') + 1]).toBe('0');
            expect(args[args.indexOf('--scope') + 1]).toBe('none');
            expect(args[args.indexOf('--data-root') + 1]).toBe(base.dataRoot);
            expect(args[args.indexOf('--relaunch') + 1]).toBe(base.relaunch);
        });

        it('non-root: --keep when keep=true, machine-wide 1, scope user', () => {
            const args = buildUninstallHelperArgs({
                isRoot: false,
                scope: 'user',
                machineWide: true,
                keep: true,
                ...base,
            });
            expect(args).toContain('--keep');
            expect(args).not.toContain('--wipe');
            expect(args[args.indexOf('--machine-wide') + 1]).toBe('1');
            expect(args[args.indexOf('--scope') + 1]).toBe('user');
        });

        it('root: --collect prefix with NO --user, scope system', () => {
            const args = buildUninstallHelperArgs({
                isRoot: true,
                scope: 'system',
                machineWide: true,
                keep: false,
                ...base,
            });
            // Root → system manager: leading --collect (no --user).
            expect(args.slice(0, 4)).toEqual(['--collect', base.unit, base.helper, '--linux-app-uninstall']);
            expect(args).not.toContain('--user');
            expect(args[args.indexOf('--scope') + 1]).toBe('system');
        });
    });

    describe('app-uninstall handler (POST /api/service/uninstall-app)', () => {
        it('POST /uninstall-app {keep:true} on linux → 200 uninstalling, spawns systemd-run helper with --keep + --scope user', async () => {
            const client = fakeClient({
                getInstalledScope: vi.fn(async () => 'user' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            let spawnedCmd = '';
            let spawnedArgs: string[] = [];
            const spawnMock = vi.fn((cmd: string, args: string[]) => {
                spawnedCmd = cmd;
                spawnedArgs = args;
            });
            // existsCheck → helper present; scheduleExit → no-op (don't sacrifice the worker).
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                spawnMock,
                () => {},
            );
            const { req, res } = makeReqRes('/api/service/uninstall-app', 'POST', JSON.stringify({ keep: true }));
            await api.handle(req, res);

            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body).toEqual({ ok: true, status: 'uninstalling' });

            expect(spawnMock).toHaveBeenCalledTimes(1);
            // systemd-run resolved via resolveSystemTool — falls back to the bare name on a non-Linux host.
            expect(spawnedCmd).toMatch(/systemd-run/);
            expect(spawnedArgs).toContain('--linux-app-uninstall');
            expect(spawnedArgs).toContain('--keep');
            expect(spawnedArgs).toContain('--scope');
            expect(spawnedArgs).toContain('user');
            // Helper path is the operation-server staged launcher (same .exe suffix even on Linux).
            const helperArg = spawnedArgs.find((a) => a.endsWith('ws-scrcpy-web-launcher.exe'));
            expect(helperArg).toBeDefined();
            expect(helperArg).toContain('operation-server');
            expect(client.getInstalledScope).toHaveBeenCalledWith('WsScrcpyWeb');
        });

        it('POST /uninstall-app {keep:true} resets installMode to null (preserved config returns in local mode)', async () => {
            const client = fakeClient({
                getInstalledScope: vi.fn(async () => 'user' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            Config.getInstance().updateAppConfig({ installMode: 'user-service' });
            const spawnMock = vi.fn();
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                spawnMock,
                () => {},
            );
            const { req, res } = makeReqRes('/api/service/uninstall-app', 'POST', JSON.stringify({ keep: true }));
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(200);
            // keep=true must reset installMode to null so the preserved config.json
            // boots in local mode, not a phantom service mode with no service.
            expect(Config.getInstance().getAppConfig().installMode).toBeNull();
        });

        it('POST /uninstall-app returns 500 when the helper is missing, does NOT spawn', async () => {
            const client = fakeClient({
                getInstalledScope: vi.fn(async () => 'user' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const spawnMock = vi.fn();
            // existsCheck → false: the staged helper is absent (dev/from-source run).
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => false,
                spawnMock,
                () => {},
            );
            const { req, res } = makeReqRes('/api/service/uninstall-app', 'POST', JSON.stringify({ keep: false }));
            await api.handle(req, res);

            expect((res as any).getStatus()).toBe(500);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(false);
            expect(body.error).toMatch(/ws-scrcpy-web-launcher\.exe/);
            expect(spawnMock).not.toHaveBeenCalled();
        });

        // ── win32 branch (mirrors the linux structure: spawn the detached Rust
        //    helper, 200 uninstalling, scheduleExit). The staged launcher carries
        //    raw `--windows-app-uninstall` argv; elevation is delegated to
        //    Update.exe (PerMachine UAC manifest) at runtime, the same
        //    "elevation lives in the launcher" model as the §30 --request-uac
        //    path and the linux helper's pkexec self-elevation.

        it('POST /uninstall-app {keep:false} on win32 → 200 uninstalling, spawns the staged launcher with --windows-app-uninstall --wipe + Update.exe', async () => {
            const client = fakeClient();
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            let spawnedCmd = '';
            let spawnedArgs: string[] = [];
            const spawnMock = vi.fn((cmd: string, args: string[]) => {
                spawnedCmd = cmd;
                spawnedArgs = args;
            });
            const scheduleExit = vi.fn();
            // existsCheck → staged helper present.
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                spawnMock,
                scheduleExit,
            );
            const { req, res } = makeReqRes('/api/service/uninstall-app', 'POST', JSON.stringify({ keep: false }));
            await api.handle(req, res);

            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body).toEqual({ ok: true, status: 'uninstalling' });

            // Local instance sacrifices itself to the detached teardown.
            expect(scheduleExit).toHaveBeenCalledTimes(1);

            expect(spawnMock).toHaveBeenCalledTimes(1);
            // Spawns the operation-server staged launcher copy (survives Program
            // Files removal) — same path the win32 service-uninstall handoff uses.
            expect(spawnedCmd).toMatch(/ws-scrcpy-web-launcher\.exe$/);
            expect(spawnedCmd).toContain('operation-server');
            // Raw argv carries the windows-app-uninstall flags.
            expect(spawnedArgs).toContain('--windows-app-uninstall');
            expect(spawnedArgs).toContain('--wipe');
            expect(spawnedArgs).not.toContain('--keep');
            // --data-root <dataRoot> (same accessor the rest of ServiceApi uses).
            const cfg = Config.getInstance();
            const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
            expect(spawnedArgs[spawnedArgs.indexOf('--data-root') + 1]).toBe(dataRoot);
            // --update-exe <installRoot>\Update.exe (Velopack root = parent of current/).
            const updateExe = spawnedArgs[spawnedArgs.indexOf('--update-exe') + 1];
            expect(updateExe).toMatch(/Update\.exe$/);
        });

        it('POST /uninstall-app {keep:true} on win32 → spawns with --keep (preserves config + logs)', async () => {
            const client = fakeClient();
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            let spawnedArgs: string[] = [];
            const spawnMock = vi.fn((_cmd: string, args: string[]) => {
                spawnedArgs = args;
            });
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                spawnMock,
                () => {},
            );
            const { req, res } = makeReqRes('/api/service/uninstall-app', 'POST', JSON.stringify({ keep: true }));
            await api.handle(req, res);

            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body).toEqual({ ok: true, status: 'uninstalling' });
            expect(spawnedArgs).toContain('--keep');
            expect(spawnedArgs).not.toContain('--wipe');
        });

        it('POST /uninstall-app on win32 returns 500 when the staged launcher is missing, does NOT spawn', async () => {
            const client = fakeClient();
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            const spawnMock = vi.fn();
            // existsCheck → false: the staged helper is absent (dev/from-source run).
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => false,
                spawnMock,
                () => {},
            );
            const { req, res } = makeReqRes('/api/service/uninstall-app', 'POST', JSON.stringify({ keep: false }));
            await api.handle(req, res);

            expect((res as any).getStatus()).toBe(500);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(false);
            expect(body.error).toMatch(/ws-scrcpy-web-launcher\.exe/);
            expect(spawnMock).not.toHaveBeenCalled();
        });

        it('POST /uninstall-app on an unsupported platform (darwin) → 200 unsupported, does NOT spawn', async () => {
            const client = fakeClient();
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: false,
                platform: 'darwin',
                unsupportedReason: 'macOS service mode unsupported',
            };
            const spawnMock = vi.fn();
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => true,
                spawnMock,
                () => {},
            );
            const { req, res } = makeReqRes('/api/service/uninstall-app', 'POST', JSON.stringify({ keep: true }));
            await api.handle(req, res);

            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(false);
            expect(body.reason).toBe('unsupported');
            expect(spawnMock).not.toHaveBeenCalled();
        });
    });

    it('returns 404 for unrecognized /api/service/* paths', async () => {
        const factoryResult: ServiceClientFactoryResult = {
            client: fakeClient(),
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
        );
        const { req, res } = makeReqRes('/api/service/bogus', 'GET');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(404);
    });

    // ── optUpdateAvailable — launcher env flag (P3c-2) ────────────────────────

    it('GET /status on linux sets optUpdateAvailable=true when WS_SCRCPY_OPT_UPDATE_AVAILABLE=1', async () => {
        const savedEnvVar = process.env['WS_SCRCPY_OPT_UPDATE_AVAILABLE'];
        process.env['WS_SCRCPY_OPT_UPDATE_AVAILABLE'] = '1';
        try {
            const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => false,
            );
            const { req, res } = makeReqRes('/api/service/status');
            await api.handle(req, res);
            const body = JSON.parse((res as any).getBody());
            expect(body.optUpdateAvailable).toBe(true);
        } finally {
            if (savedEnvVar === undefined) delete process.env['WS_SCRCPY_OPT_UPDATE_AVAILABLE'];
            else process.env['WS_SCRCPY_OPT_UPDATE_AVAILABLE'] = savedEnvVar;
        }
    });

    it('GET /status on linux sets optUpdateAvailable=false when WS_SCRCPY_OPT_UPDATE_AVAILABLE is unset', async () => {
        const savedEnvVar = process.env['WS_SCRCPY_OPT_UPDATE_AVAILABLE'];
        delete process.env['WS_SCRCPY_OPT_UPDATE_AVAILABLE'];
        try {
            const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => false,
            );
            const { req, res } = makeReqRes('/api/service/status');
            await api.handle(req, res);
            const body = JSON.parse((res as any).getBody());
            expect(body.optUpdateAvailable).toBe(false);
        } finally {
            if (savedEnvVar === undefined) delete process.env['WS_SCRCPY_OPT_UPDATE_AVAILABLE'];
            else process.env['WS_SCRCPY_OPT_UPDATE_AVAILABLE'] = savedEnvVar;
        }
    });

    it('GET /status on linux sets optUpdateAvailable=false when WS_SCRCPY_OPT_UPDATE_AVAILABLE=0', async () => {
        const savedEnvVar = process.env['WS_SCRCPY_OPT_UPDATE_AVAILABLE'];
        process.env['WS_SCRCPY_OPT_UPDATE_AVAILABLE'] = '0';
        try {
            const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'linux',
            };
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
                () => false,
            );
            const { req, res } = makeReqRes('/api/service/status');
            await api.handle(req, res);
            const body = JSON.parse((res as any).getBody());
            expect(body.optUpdateAvailable).toBe(false);
        } finally {
            if (savedEnvVar === undefined) delete process.env['WS_SCRCPY_OPT_UPDATE_AVAILABLE'];
            else process.env['WS_SCRCPY_OPT_UPDATE_AVAILABLE'] = savedEnvVar;
        }
    });

    it('GET /status on win32 omits optUpdateAvailable (linux-only field)', async () => {
        const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
            () => true,
        );
        const { req, res } = makeReqRes('/api/service/status');
        await api.handle(req, res);
        const body = JSON.parse((res as any).getBody());
        expect(body.optUpdateAvailable).toBeUndefined();
    });

    // ── reason discriminator + no-direct-uninstall guard (v0.1.25) ──────────

    it('service+LocalSystem uninstall writes marker and returns shutting-down (Phase 4 replaces handoff)', async () => {
        // Use fake timers to prevent the hardcoded setTimeout(process.exit, 5000) in
        // the LocalSystem uninstall path from leaking a real pending timer that fires
        // during later tests (specifically the "schedules process.exit(0) after 5s"
        // test that uses a global process.exit spy).
        vi.useFakeTimers();
        using _restoreTimers = {
            [Symbol.dispose]() {
                vi.useRealTimers();
            },
        };

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
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
        );
        vi.spyOn(api as unknown as { isLikelyLocalSystem: () => boolean }, 'isLikelyLocalSystem').mockReturnValue(true);
        Config.getInstance().updateAppConfig({ installMode: 'system-service' });

        const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
        await api.handle(req, res);

        expect((res as any).getStatus()).toBe(200);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(true);
        expect(body.status).toBe('shutting-down');
        expect(uninstallSpy).not.toHaveBeenCalled();
    });

    it('returns reason=unsupported when service mode is unsupported (POST /uninstall)', async () => {
        const factoryResult: ServiceClientFactoryResult = {
            client: fakeClient(),
            supported: false,
            platform: 'linux',
            unsupportedReason: 'systemd not found',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
        );
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
            throw new ServiceInstallError('user declined elevation. Service uninstall requires Administrator', {
                ok: false,
                exitCode: -1,
                stdout: '',
                stderr: '',
                errorMessage: 'user declined elevation. Service uninstall requires Administrator',
            });
        });
        const client = fakeClient({ uninstall: uninstallFn as any });
        const factoryResult: ServiceClientFactoryResult = {
            client,
            supported: true,
            platform: 'win32',
        };
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
        );
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
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
        );
        // Provide a token that will fail consumeToken validation (it won't match
        // any issued token in the temp dir, so consumeToken returns false).
        const { req, res } = makeReqRes('/api/service/uninstall', 'POST', undefined, {
            'x-resume-token': 'bogus-token-value',
        });
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
        const api = new ServiceApi(
            () => factoryResult,
            () => 'user',
        );
        const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(500);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('servy-failure');
    });

    describe('handleUninstall — operation-server flow (Phase 4)', () => {
        it('writes uninstall-pending marker when service+LocalSystem on Windows', async () => {
            // Use fake timers to prevent the hardcoded setTimeout(process.exit, 5000) in
            // the LocalSystem uninstall path from leaking a real pending timer that fires
            // during the "schedules process.exit(0) after 5s" test's global spy window.
            vi.useFakeTimers();
            using _restoreTimers = {
                [Symbol.dispose]() {
                    vi.useRealTimers();
                },
            };

            const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
            );
            vi.spyOn(api as unknown as { isLikelyLocalSystem: () => boolean }, 'isLikelyLocalSystem').mockReturnValue(
                true,
            );
            Config.getInstance().updateAppConfig({ installMode: 'user-service' });

            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            const cfg = Config.getInstance();
            expect(fs.existsSync(cfg.uninstallPendingMarkerPath)).toBe(true);
        });

        it('returns 200 with status=shutting-down and no redirectTo', async () => {
            // Use fake timers to prevent the hardcoded setTimeout(process.exit, 5000) in
            // the LocalSystem uninstall path from leaking a real pending timer that fires
            // during the "schedules process.exit(0) after 5s" test's global spy window.
            vi.useFakeTimers();
            using _restoreTimers = {
                [Symbol.dispose]() {
                    vi.useRealTimers();
                },
            };

            const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
            );
            vi.spyOn(api as unknown as { isLikelyLocalSystem: () => boolean }, 'isLikelyLocalSystem').mockReturnValue(
                true,
            );
            Config.getInstance().updateAppConfig({ installMode: 'system-service' });

            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            expect((res as any).getStatus()).toBe(200);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(true);
            expect(body.status).toBe('shutting-down');
            expect(body.installMode).toBe('system');
            expect(body.redirectTo).toBeUndefined();
        });

        it('schedules process.exit(0) after 5s', async () => {
            vi.useFakeTimers();
            const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
            using _restore = {
                [Symbol.dispose]() {
                    exitSpy.mockRestore();
                    vi.useRealTimers();
                },
            };

            const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
            );
            vi.spyOn(api as unknown as { isLikelyLocalSystem: () => boolean }, 'isLikelyLocalSystem').mockReturnValue(
                true,
            );
            Config.getInstance().updateAppConfig({ installMode: 'user-service' });

            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            expect(exitSpy).not.toHaveBeenCalled();
            vi.advanceTimersByTime(5000);
            expect(exitSpy).toHaveBeenCalledWith(0);
        });

        it('does NOT write marker in local mode', async () => {
            const client = fakeClient({
                uninstall: vi.fn(async () => undefined),
                status: vi.fn(async () => 'not-installed' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
            );
            vi.spyOn(api as unknown as { isLikelyLocalSystem: () => boolean }, 'isLikelyLocalSystem').mockReturnValue(
                false,
            );
            Config.getInstance().updateAppConfig({ installMode: 'user' });

            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            const cfg = Config.getInstance();
            expect(fs.existsSync(cfg.uninstallPendingMarkerPath)).toBe(false);
        });

        it('does NOT write marker when isLikelyLocalSystem is false in service mode', async () => {
            const client = fakeClient({
                uninstall: vi.fn(async () => undefined),
                status: vi.fn(async () => 'not-installed' as const),
            });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };
            const api = new ServiceApi(
                () => factoryResult,
                () => 'user',
            );
            vi.spyOn(api as unknown as { isLikelyLocalSystem: () => boolean }, 'isLikelyLocalSystem').mockReturnValue(
                false,
            );
            Config.getInstance().updateAppConfig({ installMode: 'user-service' });

            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);

            const cfg = Config.getInstance();
            expect(fs.existsSync(cfg.uninstallPendingMarkerPath)).toBe(false);
        });

        it('POST /uninstall (service context, LocalSystem) includes configMtime in shutting-down response', async () => {
            const cfg = Config.getInstance();
            cfg.updateAppConfig({ installMode: 'system-service', webPort: 8003 });

            const client = fakeClient({ status: vi.fn(async () => 'running' as const) });
            const factoryResult: ServiceClientFactoryResult = {
                client,
                supported: true,
                platform: 'win32',
            };

            const api = new ServiceApi(
                () => factoryResult,
                () => 'system',
                () => true,
            );
            vi.spyOn(api as unknown as { isLikelyLocalSystem: () => boolean }, 'isLikelyLocalSystem').mockReturnValue(
                true,
            );

            const { req, res } = makeReqRes('/api/service/uninstall', 'POST');
            await api.handle(req, res);
            const body = JSON.parse((res as any).getBody());
            expect(body.ok).toBe(true);
            expect(body.status).toBe('shutting-down');
            expect(typeof body.configMtime).toBe('number');
            expect(body.configMtime).toBeGreaterThan(0);

            vi.restoreAllMocks();
        });
    });
});
