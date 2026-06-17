// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix

// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as os from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdatesApi } from '../api/UpdatesApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import type { UpdateService, UpdateServiceState } from '../UpdateService';

// ──────────────────────────────────────────────────────────────────────────
// Helpers

function makeReqRes(url: string, method = 'GET', body?: string) {
    const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
    const req = {
        url,
        method,
        on(event: string, handler: (...args: unknown[]) => void) {
            (listeners[event] ??= []).push(handler);
            if (event === 'end') {
                queueMicrotask(() => {
                    if (body !== undefined) {
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

/**
 * Construct a fake UpdateService with controllable state + spies. Avoids
 * pulling in the velopack native addon.
 */
function fakeService(state: Partial<UpdateServiceState> = {}) {
    const fullState: UpdateServiceState = {
        isInstalled: true,
        currentVersion: '0.1.0',
        status: 'idle',
        ...state,
    };
    const checkForUpdates = vi.fn(async () => fullState);
    const applyUpdate = vi.fn(async () => ({ redirectPort: null }));
    const reconfigure = vi.fn(async (_c: 'stable' | 'beta', _o: string) => undefined);
    const restartTimer = vi.fn();
    const downloadIfNeeded = vi.fn(async () => undefined);
    const init = vi.fn();
    const svc = {
        getStatus: () => ({ ...fullState }),
        checkForUpdates,
        applyUpdate,
        reconfigure,
        restartTimer,
        downloadIfNeeded,
        init,
        // Test-only: mutate state mid-test.
        _setState(p: Partial<UpdateServiceState>) {
            Object.assign(fullState, p);
        },
    };
    return svc as unknown as UpdateService & {
        _setState(p: Partial<UpdateServiceState>): void;
        checkForUpdates: typeof checkForUpdates;
        applyUpdate: typeof applyUpdate;
        reconfigure: typeof reconfigure;
        restartTimer: typeof restartTimer;
    };
}

describe('UpdatesApi', () => {
    const tmpDirs: string[] = [];
    const savedEnv = {
        CONFIG: process.env[EnvName.CONFIG_PATH],
        DEPS: process.env['DEPS_PATH'],
    };

    beforeEach(() => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-updates-api-'));
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
        const api = new UpdatesApi(fakeService());
        const { req, res } = makeReqRes('/api/devices');
        expect(await api.handle(req, res)).toBe(false);
    });

    // ── GET /status ──────────────────────────────────────────────────────

    it('GET /status returns full envelope: service state + config mirror', async () => {
        Config.getInstance().updateAppConfig({
            autoUpdate: false,
            channel: 'beta',
            githubOwner: 'forky',
            updateCheckIntervalMinutes: 30,
        });
        const svc = fakeService({
            isInstalled: true,
            currentVersion: '0.1.0',
            status: 'ready',
            availableVersion: '0.2.0',
            progress: 100,
        });
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes('/api/updates/status');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        const body = JSON.parse((res as any).getBody());
        expect(body.isInstalled).toBe(true);
        expect(body.currentVersion).toBe('0.1.0');
        expect(body.status).toBe('ready');
        expect(body.availableVersion).toBe('0.2.0');
        expect(body.progress).toBe(100);
        expect(body.autoUpdate).toBe(false);
        expect(body.channel).toBe('beta');
        expect(body.githubOwner).toBe('forky');
        expect(body.updateCheckIntervalMinutes).toBe(30);
    });

    it('GET /status in dev mode returns isInstalled=false', async () => {
        const svc = fakeService({ isInstalled: false, currentVersion: '', status: 'idle' });
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes('/api/updates/status');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        const body = JSON.parse((res as any).getBody());
        expect(body.isInstalled).toBe(false);
        expect(body.currentVersion).toBe('');
        expect(body.status).toBe('idle');
    });

    // ── POST /check ──────────────────────────────────────────────────────

    it('POST /check returns 503 in dev mode', async () => {
        const svc = fakeService({ isInstalled: false });
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes('/api/updates/check', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(503);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/dev mode/);
        expect(svc.checkForUpdates).not.toHaveBeenCalled();
    });

    it('POST /check happy path: calls svc.checkForUpdates and returns updated status', async () => {
        const svc = fakeService({ isInstalled: true, status: 'idle' });
        svc.checkForUpdates.mockImplementation(async () => {
            svc._setState({ status: 'ready', availableVersion: '0.2.0' });
            return svc.getStatus();
        });
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes('/api/updates/check', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        expect(svc.checkForUpdates).toHaveBeenCalledTimes(1);
        const body = JSON.parse((res as any).getBody());
        expect(body.status).toBe('ready');
        expect(body.availableVersion).toBe('0.2.0');
    });

    // ── POST /apply ──────────────────────────────────────────────────────

    it('POST /apply returns 503 in dev mode', async () => {
        const svc = fakeService({ isInstalled: false });
        const schedule = vi.fn();
        const exit = vi.fn();
        const api = new UpdatesApi(svc, schedule, exit);
        const { req, res } = makeReqRes('/api/updates/apply', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(503);
        expect(svc.applyUpdate).not.toHaveBeenCalled();
        expect(schedule).not.toHaveBeenCalled();
    });

    it('POST /apply returns 409 when status !== ready', async () => {
        const svc = fakeService({ isInstalled: true, status: 'idle' });
        const schedule = vi.fn();
        const exit = vi.fn();
        const api = new UpdatesApi(svc, schedule, exit);
        const { req, res } = makeReqRes('/api/updates/apply', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(409);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/apply not allowed/);
        expect(svc.applyUpdate).not.toHaveBeenCalled();
        expect(schedule).not.toHaveBeenCalled();
    });

    it('POST /apply happy path: 200 + schedules deferred exit + calls svc.applyUpdate', async () => {
        const svc = fakeService({ isInstalled: true, status: 'ready', availableVersion: '0.2.0' });
        const schedule = vi.fn();
        const exit = vi.fn();
        const api = new UpdatesApi(svc, schedule, exit);
        const { req, res } = makeReqRes('/api/updates/apply', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(true);
        expect(svc.applyUpdate).toHaveBeenCalledTimes(1);
        expect(schedule).toHaveBeenCalledTimes(1);
        const [cb, ms] = schedule.mock.calls[0]!;
        expect(typeof cb).toBe('function');
        expect(ms).toBe(100);
        // Drive the deferred callback to verify exit hook wires up.
        cb();
        expect(exit).toHaveBeenCalledWith(0);
    });

    it('POST /apply: applyUpdate throws → 500, no scheduled exit', async () => {
        const svc = fakeService({ isInstalled: true, status: 'ready' });
        svc.applyUpdate.mockImplementation(() => {
            throw new Error('updater missing');
        });
        const schedule = vi.fn();
        const exit = vi.fn();
        const api = new UpdatesApi(svc, schedule, exit);
        const { req, res } = makeReqRes('/api/updates/apply', 'POST');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(500);
        const body = JSON.parse((res as any).getBody());
        expect(body.ok).toBe(false);
        expect(body.error).toMatch(/updater missing/);
        expect(schedule).not.toHaveBeenCalled();
    });

    it('POST /apply (linux): body carries mode:"reconnect" when redirectPort is null', async () => {
        const orig = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
        try {
            const svc = fakeService({ isInstalled: true, status: 'ready', availableVersion: '0.2.0' });
            const api = new UpdatesApi(svc, vi.fn(), vi.fn());
            const { req, res } = makeReqRes('/api/updates/apply', 'POST');
            await api.handle(req, res);
            expect((res as any).getStatus()).toBe(200);
            expect(JSON.parse((res as any).getBody())).toEqual({ ok: true, mode: 'reconnect' });
            expect(svc.applyUpdate).toHaveBeenCalledTimes(1);
        } finally {
            if (orig) Object.defineProperty(process, 'platform', orig);
        }
    });

    it('POST /apply (win32): body is { ok:true } with no mode', async () => {
        const orig = Object.getOwnPropertyDescriptor(process, 'platform');
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        try {
            const svc = fakeService({ isInstalled: true, status: 'ready', availableVersion: '0.2.0' });
            const api = new UpdatesApi(svc, vi.fn(), vi.fn());
            const { req, res } = makeReqRes('/api/updates/apply', 'POST');
            await api.handle(req, res);
            const body = JSON.parse((res as any).getBody());
            expect(body).toEqual({ ok: true });
            expect(body.mode).toBeUndefined();
        } finally {
            if (orig) Object.defineProperty(process, 'platform', orig);
        }
    });

    // ── PATCH /config: validation ────────────────────────────────────────

    it('PATCH /config: bad channel → 400', async () => {
        const svc = fakeService();
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes('/api/updates/config', 'PATCH', JSON.stringify({ channel: 'nightly' }));
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(400);
        const body = JSON.parse((res as any).getBody());
        expect(body.error).toMatch(/channel must be one of/);
        expect(svc.reconfigure).not.toHaveBeenCalled();
    });

    it('PATCH /config: interval < 5 → 400', async () => {
        const svc = fakeService();
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes(
            '/api/updates/config',
            'PATCH',
            JSON.stringify({ updateCheckIntervalMinutes: 1 }),
        );
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(400);
        expect(JSON.parse((res as any).getBody()).error).toMatch(/integer between 5 and 1440/);
    });

    it('PATCH /config: interval > 1440 → 400', async () => {
        const svc = fakeService();
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes(
            '/api/updates/config',
            'PATCH',
            JSON.stringify({ updateCheckIntervalMinutes: 99999 }),
        );
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(400);
    });

    it('PATCH /config: empty githubOwner → 400', async () => {
        const svc = fakeService();
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes('/api/updates/config', 'PATCH', JSON.stringify({ githubOwner: '' }));
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(400);
        expect(JSON.parse((res as any).getBody()).error).toMatch(/non-empty string/);
    });

    it('PATCH /config: any non-empty githubOwner accepted (decision 7)', async () => {
        const svc = fakeService({ isInstalled: true });
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes(
            '/api/updates/config',
            'PATCH',
            JSON.stringify({ githubOwner: 'definitely-not-a-real-user' }),
        );
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        expect(Config.getInstance().getAppConfig().githubOwner).toBe('definitely-not-a-real-user');
        expect(svc.reconfigure).toHaveBeenCalledWith('stable', 'definitely-not-a-real-user');
    });

    it('PATCH /config: bad autoUpdate (non-boolean) → 400', async () => {
        const svc = fakeService();
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes('/api/updates/config', 'PATCH', JSON.stringify({ autoUpdate: 'yes' }));
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(400);
        expect(JSON.parse((res as any).getBody()).error).toMatch(/autoUpdate must be a boolean/);
    });

    // ── PATCH /config: side effects ──────────────────────────────────────

    it('PATCH /config: channel change triggers svc.reconfigure', async () => {
        const svc = fakeService({ isInstalled: true });
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes('/api/updates/config', 'PATCH', JSON.stringify({ channel: 'beta' }));
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        expect(svc.reconfigure).toHaveBeenCalledTimes(1);
        // Should pass current values from after the persist.
        const args = svc.reconfigure.mock.calls[0]!;
        expect(args[0]).toBe('beta');
        expect(svc.restartTimer).not.toHaveBeenCalled();
    });

    it('PATCH /config: interval change triggers svc.restartTimer', async () => {
        const svc = fakeService({ isInstalled: true });
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes(
            '/api/updates/config',
            'PATCH',
            JSON.stringify({ updateCheckIntervalMinutes: 120 }),
        );
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        expect(svc.restartTimer).toHaveBeenCalledTimes(1);
        const args = svc.restartTimer.mock.calls[0]!;
        expect(args[0]).toBe(120);
        expect(svc.reconfigure).not.toHaveBeenCalled();
    });

    it('PATCH /config: only autoUpdate change does NOT trigger reconfigure or restartTimer', async () => {
        const svc = fakeService({ isInstalled: true });
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes('/api/updates/config', 'PATCH', JSON.stringify({ autoUpdate: false }));
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        expect(svc.reconfigure).not.toHaveBeenCalled();
        expect(svc.restartTimer).not.toHaveBeenCalled();
        expect(Config.getInstance().getAppConfig().autoUpdate).toBe(false);
    });

    it('PATCH /config: channel + interval together → reconfigure only (channel takes precedence)', async () => {
        // Per contracts: channel/owner change runs reconfigure (which fires
        // an immediate check). Interval-only change runs restartTimer. When
        // both change, reconfigure is enough — but restartTimer is also
        // appropriate. Spec implementation: channelChanged|ownerChanged wins
        // and skips restartTimer. Verify that behavior is locked.
        const svc = fakeService({ isInstalled: true });
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes(
            '/api/updates/config',
            'PATCH',
            JSON.stringify({ channel: 'beta', updateCheckIntervalMinutes: 90 }),
        );
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        expect(svc.reconfigure).toHaveBeenCalledTimes(1);
        expect(svc.restartTimer).not.toHaveBeenCalled();
    });

    it('PATCH /config: malformed JSON → empty patch, 200, no side effects', async () => {
        // readJsonBody returns {} on parse failure; that's a no-op patch.
        const svc = fakeService({ isInstalled: true });
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes('/api/updates/config', 'PATCH', 'not-json{');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        expect(svc.reconfigure).not.toHaveBeenCalled();
        expect(svc.restartTimer).not.toHaveBeenCalled();
    });

    it('PATCH /config: dev mode still persists config (no reconfigure though)', async () => {
        const svc = fakeService({ isInstalled: false });
        const api = new UpdatesApi(svc);
        const { req, res } = makeReqRes('/api/updates/config', 'PATCH', JSON.stringify({ githubOwner: 'newowner' }));
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(200);
        expect(Config.getInstance().getAppConfig().githubOwner).toBe('newowner');
        // svc.reconfigure may be called but UpdateService.reconfigure short-circuits in dev mode.
        // The API doesn't gate the call on isInstalled; that's the service's job. So we
        // verify the reconfigure was invoked, but we don't assert behavior beyond persist.
        expect(svc.reconfigure).toHaveBeenCalled();
    });

    // ── 404 fallback ─────────────────────────────────────────────────────

    it('returns 404 for unrecognized /api/updates/* paths', async () => {
        const api = new UpdatesApi(fakeService());
        const { req, res } = makeReqRes('/api/updates/bogus', 'GET');
        await api.handle(req, res);
        expect((res as any).getStatus()).toBe(404);
    });
});
