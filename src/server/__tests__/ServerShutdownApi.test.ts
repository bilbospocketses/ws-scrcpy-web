import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerShutdownApi } from '../api/ServerShutdownApi';
import { Config } from '../Config';
import { EnvName } from '../EnvName';

const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };
beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsshutdown-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
});
afterEach(() => {
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/**
 * `remoteAddress` matters since item 114: the handler is loopback-only, because
 * it is exempt from the per-instance token (the tray helper has no cookie).
 * Every request here therefore carries a socket, and the default is loopback —
 * the tray's own case.
 */
function makeReqRes(url: string, method = 'GET', remoteAddress = '127.0.0.1') {
    const req = { url, method, socket: { remoteAddress } } as unknown as IncomingMessage;
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

describe('ServerShutdownApi', () => {
    it('returns false for GET requests (wrong method)', async () => {
        const api = new ServerShutdownApi();
        const { req, res } = makeReqRes('/api/server/shutdown', 'GET');
        expect(await api.handle(req, res)).toBe(false);
    });

    it('returns false for POSTs to a different path', async () => {
        const api = new ServerShutdownApi();
        const { req, res } = makeReqRes('/api/devices', 'POST');
        expect(await api.handle(req, res)).toBe(false);
    });

    it('returns false for the right path with a wrong method (PUT)', async () => {
        const api = new ServerShutdownApi();
        const { req, res } = makeReqRes('/api/server/shutdown', 'PUT');
        expect(await api.handle(req, res)).toBe(false);
    });

    // Item 114. The tray helper POSTs this path with no cookie and no Origin
    // (tray/src/main.rs: ureq .post(url).send_string("")). Measured on
    // 2026-09-06 against a real server: the per-instance token gate answered
    // 403 {"reason":"missing or invalid token"} and the handler's own log line
    // never appeared — the tray's Exit had been a no-op since the token landed.
    // The gate exemption lives in security/instanceToken.ts; loopback is what
    // replaces it here.
    it('refuses a caller that is not on this machine, without saying whether auth is on', async () => {
        const schedule = vi.fn();
        const exit = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST', '192.168.1.20');

        expect(await api.handle(req, res)).toBe(true);
        expect((res as any).getStatus()).toBe(403);
        expect(JSON.parse((res as any).getBody())).toEqual({ error: 'this endpoint answers this machine only' });
        // Nothing was scheduled and nothing exited.
        expect(schedule).not.toHaveBeenCalled();
        expect(exit).not.toHaveBeenCalled();
    });

    it('refuses a request whose peer address is unknown (fail closed)', async () => {
        const schedule = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit: vi.fn() });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST', '');

        expect(await api.handle(req, res)).toBe(true);
        expect((res as any).getStatus()).toBe(403);
        expect(schedule).not.toHaveBeenCalled();
    });

    it('accepts the IPv4-mapped loopback a dual-stack listener reports', async () => {
        const schedule = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit: vi.fn() });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST', '::ffff:127.0.0.1');

        expect(await api.handle(req, res)).toBe(true);
        expect((res as any).getStatus()).toBe(200);
        expect(schedule).toHaveBeenCalledTimes(1);
    });

    it('POST /api/server/shutdown writes 200 with { ok: true } envelope', async () => {
        const schedule = vi.fn();
        const exit = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST');
        const handled = await api.handle(req, res);
        expect(handled).toBe(true);
        expect((res as any).getStatus()).toBe(200);
        expect(JSON.parse((res as any).getBody())).toEqual({ ok: true });
    });

    it('schedules process.exit(0) via setTimeout after responding', async () => {
        const schedule = vi.fn();
        const exit = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST');
        await api.handle(req, res);

        expect(schedule).toHaveBeenCalledTimes(1);
        const [cb, delay] = schedule.mock.calls[0]!;
        expect(typeof cb).toBe('function');
        expect(delay).toBe(100);

        // Exit must NOT have fired yet — only scheduled.
        expect(exit).not.toHaveBeenCalled();

        // Manually invoke the scheduled callback; verify exit(0) is then called.
        // The callback now returns a promise (awaits cleanup first), so await it.
        await (cb as () => Promise<void>)();
        expect(exit).toHaveBeenCalledWith(0);
    });

    it('awaits cleanup before exiting (cleanup runs, then exit 0)', async () => {
        const order: string[] = [];
        const cleanup = vi.fn(async () => {
            order.push('cleanup');
        });
        const schedule = vi.fn();
        const exit = vi.fn(() => {
            order.push('exit');
        });
        const api = new ServerShutdownApi({ cleanup, schedule, exit });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST');
        await api.handle(req, res);

        // Cleanup must NOT run until the scheduled tick (response flushes first).
        expect(cleanup).not.toHaveBeenCalled();
        expect(schedule).toHaveBeenCalledTimes(1);
        const [cb] = schedule.mock.calls[0]!;

        await (cb as () => Promise<void>)();

        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(0);
        // Ordering is the whole point: adb daemon + services torn down first.
        expect(order).toEqual(['cleanup', 'exit']);
    });
});
