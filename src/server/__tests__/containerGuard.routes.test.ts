import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigApi } from '../api/ConfigApi';
import { containerRefusalMessage, hostOnlyConfigKeys } from '../api/containerGuard';
import { DependencyApi } from '../api/DependencyApi';
import { ServiceApi } from '../api/ServiceApi';
import { SettingsBatchApi } from '../api/SettingsBatchApi';
import { TlsApi } from '../api/TlsApi';
import { UpdatesApi } from '../api/UpdatesApi';
import { Config } from '../Config';
import type { DependencyManager } from '../DependencyManager';
import { EnvName } from '../EnvName';
import type { CertService } from '../tls/CertService';
import type { UpdateService } from '../UpdateService';

/**
 * The container audit (2026-09-30): every route that changes the host, the
 * install, the updater, the dependency set, HTTPS or the port answers 409 in a
 * container, with copy that names the container and the real remedy. Each case
 * carries its host control: outside a container the same call is not refused.
 */

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    DOCKER: process.env['WS_SCRCPY_DOCKER'],
};

function setup(docker: boolean): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-container-guard-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    if (docker) process.env['WS_SCRCPY_DOCKER'] = '1';
    else delete process.env['WS_SCRCPY_DOCKER'];
    Config._resetForTest();
}

afterEach(() => {
    Config._resetForTest();
    for (const [k, v] of [
        [EnvName.CONFIG_PATH, saved.CONFIG],
        ['DEPS_PATH', saved.DEPS],
        ['WS_SCRCPY_DOCKER', saved.DOCKER],
    ] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** A loopback request (so requireOperator admits it in open mode) with an optional JSON body. */
function makeReqRes(method: string, url: string, body?: unknown) {
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = {
        url,
        method,
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
        on(event: string, handler: (...args: unknown[]) => void) {
            if (event === 'data' && text) queueMicrotask(() => handler(Buffer.from(text)));
            if (event === 'end') queueMicrotask(() => queueMicrotask(() => handler()));
            return this;
        },
    } as unknown as IncomingMessage;
    let statusCode = 0;
    const chunks: string[] = [];
    const res = {
        writeHead(code: number) {
            statusCode = code;
            return res;
        },
        setHeader() {},
        end(c?: string) {
            if (c) chunks.push(c);
        },
    } as unknown as ServerResponse;
    return {
        req,
        res,
        status: () => statusCode,
        json: () => (chunks.length ? JSON.parse(chunks.join('')) : undefined),
    };
}

// Stubs that throw if a refused route reaches them: a refusal must come first.
const unreachable = () => {
    throw new Error('reached past the container refusal');
};
const updateSvc = {
    getStatus: () => ({ isInstalled: false, currentVersion: '0.0.0', status: 'idle' }),
    checkForUpdates: unreachable,
    applyUpdate: unreachable,
    reconfigure: unreachable,
} as unknown as UpdateService;
const depManager = {
    getAll: async () => [],
    checkAll: unreachable,
    update: unreachable,
    autoInstallMissing: async () => undefined,
    requestRestart: unreachable,
} as unknown as DependencyManager;
const tlsApi = () => new TlsApi(unreachable as unknown as () => CertService, () => []);
// A factory that reports "unsupported": a host control must never reach real service tooling.
const svcApi = () =>
    new ServiceApi(() => ({ supported: false, platform: 'linux', unsupportedReason: 'test stub' }) as never);

interface Case {
    name: string;
    remedy: RegExp;
    /** False when the host path would act for real (a restart that exits the worker). */
    hostSafe?: boolean;
    run: () => ReturnType<typeof makeReqRes> & { handled: Promise<boolean> };
}

function call(
    api: { handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> },
    method: string,
    url: string,
    body?: unknown,
) {
    const rr = makeReqRes(method, url, body);
    return { ...rr, handled: api.handle(rr.req, rr.res) };
}

const REFUSED: Case[] = [
    {
        name: 'POST /api/service/install',
        remedy: /docker rm/,
        run: () => call(svcApi(), 'POST', '/api/service/install', { scope: 'user' }),
    },
    {
        name: 'POST /api/service/uninstall',
        remedy: /docker rm/,
        run: () => call(svcApi(), 'POST', '/api/service/uninstall'),
    },
    {
        name: 'POST /api/service/decline-system-wide',
        remedy: /docker rm/,
        run: () => call(svcApi(), 'POST', '/api/service/decline-system-wide'),
    },
    {
        name: 'POST /api/service/install-system-wide',
        remedy: /docker rm/,
        run: () => call(svcApi(), 'POST', '/api/service/install-system-wide'),
    },
    {
        name: 'POST /api/service/uninstall-app',
        remedy: /docker rm/,
        run: () => call(svcApi(), 'POST', '/api/service/uninstall-app', { keep: false }),
    },
    {
        name: 'POST /api/updates/check',
        remedy: /pull a newer image/i,
        run: () => call(new UpdatesApi(updateSvc), 'POST', '/api/updates/check'),
    },
    {
        name: 'POST /api/updates/apply',
        remedy: /pull a newer image/i,
        run: () => call(new UpdatesApi(updateSvc), 'POST', '/api/updates/apply'),
    },
    {
        name: 'PATCH /api/updates/config',
        remedy: /pull a newer image/i,
        run: () => call(new UpdatesApi(updateSvc), 'PATCH', '/api/updates/config', { autoUpdate: true }),
    },
    {
        name: 'POST /api/dependencies/check',
        remedy: /pull a newer image/i,
        run: () => call(new DependencyApi(depManager), 'POST', '/api/dependencies/check'),
    },
    {
        name: 'POST /api/dependencies/adb/update',
        remedy: /pull a newer image/i,
        run: () => call(new DependencyApi(depManager), 'POST', '/api/dependencies/adb/update'),
    },
    {
        name: 'POST /api/tls/generate',
        remedy: /reverse proxy/,
        run: () => call(tlsApi(), 'POST', '/api/tls/generate', { kind: 'ip', value: '10.0.0.2' }),
    },
    { name: 'POST /api/tls/revoke', remedy: /reverse proxy/, run: () => call(tlsApi(), 'POST', '/api/tls/revoke') },
    {
        name: 'POST /api/tls/exposure',
        remedy: /reverse proxy/,
        run: () => call(tlsApi(), 'POST', '/api/tls/exposure', { mode: 'httpsOnly' }),
    },
    {
        name: 'POST /api/tls/https-port',
        remedy: /reverse proxy/,
        run: () => call(tlsApi(), 'POST', '/api/tls/https-port', { port: 8443 }),
    },
    // The reads too (2026-10-01): a container carries no hint of the local CA.
    { name: 'GET /api/tls/state', remedy: /reverse proxy/, run: () => call(tlsApi(), 'GET', '/api/tls/state') },
    { name: 'GET /api/tls/ca-root', remedy: /reverse proxy/, run: () => call(tlsApi(), 'GET', '/api/tls/ca-root') },
    {
        name: 'PATCH /api/config { webPort }',
        remedy: /docker run -p/,
        hostSafe: false,
        run: () => call(new ConfigApi(), 'PATCH', '/api/config', { webPort: 9000 }),
    },
    {
        name: 'PATCH /api/config { installMode }',
        remedy: /docker owns this setting/,
        run: () => call(new ConfigApi(), 'PATCH', '/api/config', { installMode: 'user-service' }),
    },
    {
        name: 'PATCH /api/config { firstRunComplete }',
        remedy: /docker owns this setting/,
        run: () => call(new ConfigApi(), 'PATCH', '/api/config', { firstRunComplete: false }),
    },
    {
        name: 'POST /api/settings/batch { webPort }',
        remedy: /docker run -p/,
        run: () =>
            call(new SettingsBatchApi({ schedule: vi.fn(), exit: vi.fn() }), 'POST', '/api/settings/batch', {
                changes: [{ id: 'webPort', from: 8000, to: 9000 }],
            }),
    },
    {
        name: 'POST /api/settings/batch { channel }',
        remedy: /docker owns this setting/,
        run: () =>
            call(new SettingsBatchApi({ schedule: vi.fn(), exit: vi.fn() }), 'POST', '/api/settings/batch', {
                changes: [{ id: 'channel', from: 'beta', to: 'stable' }],
            }),
    },
];

describe('container mode refuses every host-only route with 409', () => {
    it.each(REFUSED)('$name', async ({ run, remedy }) => {
        setup(true);
        const r = run();
        expect(await r.handled).toBe(true);
        expect(r.status()).toBe(409);
        const body = r.json();
        expect(body.ok).toBe(false);
        expect(body.reason).toBe('unsupported');
        expect(body.error).toMatch(/does not apply in a container/);
        expect(body.error).toMatch(remedy);
    });

    it.each(REFUSED.filter((c) => c.hostSafe !== false))('$name is not refused on a host', async ({ run }) => {
        setup(false);
        const r = run();
        try {
            await r.handled;
        } catch {
            // A host run may reach a stub or real tooling that throws; only the refusal matters.
        }
        expect(r.status()).not.toBe(409);
    });
});

describe('container mode still allows what a container needs', () => {
    it('retry-install stays open: the first-run banner uses it in a container', async () => {
        setup(true);
        const manager = { ...depManager, checkAll: async () => undefined } as unknown as DependencyManager;
        const r = call(new DependencyApi(manager), 'POST', '/api/dependencies/retry-install');
        await r.handled;
        expect(r.status()).toBe(200);
    });

    it('a setting that is not host-only is still writable', async () => {
        setup(true);
        const r = call(new ConfigApi(), 'PATCH', '/api/config', { allowRemoteAdmin: false });
        await r.handled;
        expect(r.status()).toBe(200);
    });

    it('GET /api/service/status answers early: unsupported, containerised, no host probe', async () => {
        setup(true);
        const factory = vi.fn();
        const api = new ServiceApi(factory as never);
        const r = call(api, 'GET', '/api/service/status');
        await r.handled;
        expect(r.status()).toBe(200);
        const body = r.json();
        expect(body).toMatchObject({ supported: false, docker: true });
        expect(body.unsupportedReason).toMatch(/container/);
        expect(factory).not.toHaveBeenCalled();
    });
});

describe('containerGuard helpers', () => {
    it('names the action, the container and the remedy', () => {
        expect(containerRefusalMessage('uninstall', 'docker-rm')).toBe(
            '"uninstall" does not apply in a container — this image\'s lifecycle belongs to docker. Use `docker rm` to remove it.',
        );
    });

    it('picks out only the host-only keys, in order', () => {
        expect(hostOnlyConfigKeys(['scanConcurrency', 'webPort', 'allowRemoteAdmin', 'channel'])).toEqual([
            'webPort',
            'channel',
        ]);
    });
});
