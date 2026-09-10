import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerShutdownApi } from '../api/ServerShutdownApi';
import { setAuthEnabled } from '../auth/authState';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { getInstanceToken } from '../security/instanceToken';

const tmpDirs: string[] = [];
const saved = {
    CONFIG: process.env[EnvName.CONFIG_PATH],
    DEPS: process.env['DEPS_PATH'],
    ALLOW_REMOTE: process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'],
};
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
    // The opt-out is process-global. A test that sets it must not leave it set
    // for the next one, or a refusal case passes for the wrong reason.
    if (saved.ALLOW_REMOTE === undefined) delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
    else process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = saved.ALLOW_REMOTE;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/**
 * `remoteAddress` matters since item 114: the handler is loopback-only, because
 * it is exempt from the per-instance token (the tray helper has no cookie).
 * Every request here therefore carries a socket, and the default is loopback —
 * the tray's own case.
 */
function makeReqRes(url: string, method = 'GET', remoteAddress = '127.0.0.1', headers: Record<string, string> = {}) {
    const req = { url, method, socket: { remoteAddress }, headers } as unknown as IncomingMessage;
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
    it('refuses a cookieless caller that is not on this machine', async () => {
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

    it('refuses a cookieless request whose peer address is unknown (fail closed)', async () => {
        const schedule = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit: vi.fn() });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST', '');

        expect(await api.handle(req, res)).toBe(true);
        expect((res as any).getStatus()).toBe(403);
        expect(schedule).not.toHaveBeenCalled();
    });

    // The regression CI caught on the first cut of this fix: requiring loopback
    // outright killed the Settings "stop server & exit" button inside a
    // container, where the browser arrives through the Docker gateway and is
    // never on loopback (row 20.6).
    //
    // Item 81 narrowed this. The token alone is no longer enough in open mode —
    // it proves a browser loaded the page, not that the caller is the operator —
    // so the container path now also needs the explicit opt-out. This test is the
    // in-repo proof of the qa-harness coupling: row 20.6 keeps passing precisely
    // because the harness sets WS_SCRCPY_ALLOW_REMOTE_ADMIN=1 on its subject.
    it('allows an off-box caller that carries the instance token (the container / LAN browser)', async () => {
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        const schedule = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit: vi.fn() });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST', '172.17.0.1', {
            cookie: `ws_scrcpy_token=${getInstanceToken()}`,
        });

        expect(await api.handle(req, res)).toBe(true);
        expect((res as any).getStatus()).toBe(200);
        expect(schedule).toHaveBeenCalledTimes(1);
    });

    it('refuses an off-box caller whose token is wrong', async () => {
        const schedule = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit: vi.fn() });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST', '172.17.0.1', {
            cookie: `ws_scrcpy_token=${'a'.repeat(64)}`,
        });

        expect(await api.handle(req, res)).toBe(true);
        expect((res as any).getStatus()).toBe(403);
        expect(schedule).not.toHaveBeenCalled();
    });

    it('refuses an off-box token-holder that is not signed in when auth is on', async () => {
        setAuthEnabled(Config.getInstance().db, true);
        const schedule = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit: vi.fn() });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST', '192.168.1.20', {
            cookie: `ws_scrcpy_token=${getInstanceToken()}`,
        });

        expect(await api.handle(req, res)).toBe(true);
        expect((res as any).getStatus()).toBe(401);
        expect(schedule).not.toHaveBeenCalled();
    });

    // The user's decision, 2026-09-06: on the machine itself, stopping the app
    // is the operator's call — so the tray's cookieless, session-less POST works
    // in locked mode too, which is where its Exit is the only stop affordance.
    it('allows the tray on loopback even when auth is on (no cookie, no session)', async () => {
        setAuthEnabled(Config.getInstance().db, true);
        const schedule = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit: vi.fn() });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST');

        expect(await api.handle(req, res)).toBe(true);
        expect((res as any).getStatus()).toBe(200);
        expect(schedule).toHaveBeenCalledTimes(1);
    });

    it('refuses a signed-in non-admin, even on loopback', async () => {
        const db = Config.getInstance().db;
        setAuthEnabled(db, true);
        const viewer = db.users.create({ username: 'viewer', role: 'user', passwordHash: null });
        const schedule = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit: vi.fn() });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST');
        (req as IncomingMessage & { user?: unknown }).user = viewer;

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

// ──────────────────────────────────────────────────────────────────────────
// Item 81. Off-box, in OPEN mode, the instance token stopped being sufficient:
// it proves a browser loaded our page, not that the caller is the operator.
// The env var / config opt-out is what restores it. Locked mode is unchanged —
// there a session is the proof and the opt-out is never consulted.

describe('ServerShutdownApi off-box opt-out', () => {
    it('403s an off-box caller in open mode without the opt-out, even with a valid token', async () => {
        const schedule = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit: vi.fn() });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST', '192.168.1.50', {
            cookie: `ws_scrcpy_token=${getInstanceToken()}`,
        });

        expect(await api.handle(req, res)).toBe(true);
        expect((res as any).getStatus()).toBe(403);
        expect(schedule).not.toHaveBeenCalled();
    });

    it('allows the same caller once WS_SCRCPY_ALLOW_REMOTE_ADMIN=1', async () => {
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        const schedule = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit: vi.fn() });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST', '192.168.1.50', {
            cookie: `ws_scrcpy_token=${getInstanceToken()}`,
        });

        expect(await api.handle(req, res)).toBe(true);
        expect((res as any).getStatus()).toBe(200);
        expect(schedule).toHaveBeenCalledTimes(1);
    });

    it('allows the same caller when config.json sets allowRemoteAdmin', async () => {
        Config.getInstance().updateAppConfig({ allowRemoteAdmin: true });
        const schedule = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit: vi.fn() });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST', '192.168.1.50', {
            cookie: `ws_scrcpy_token=${getInstanceToken()}`,
        });

        expect(await api.handle(req, res)).toBe(true);
        expect((res as any).getStatus()).toBe(200);
    });

    it('still allows a loopback caller with no cookie — the tray helper', async () => {
        const schedule = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit: vi.fn() });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST');

        expect(await api.handle(req, res)).toBe(true);
        expect((res as any).getStatus()).toBe(200);
        expect(schedule).toHaveBeenCalledTimes(1);
    });

    // The opt-out must stay inert once sign-in is on: a flag left set from an
    // earlier container run cannot open a route around the login.
    it('is ignored in locked mode — an unauthenticated off-box caller still gets 401', async () => {
        setAuthEnabled(Config.getInstance().db, true);
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        const schedule = vi.fn();
        const api = new ServerShutdownApi({ schedule, exit: vi.fn() });
        const { req, res } = makeReqRes('/api/server/shutdown', 'POST', '192.168.1.50', {
            cookie: `ws_scrcpy_token=${getInstanceToken()}`,
        });

        expect(await api.handle(req, res)).toBe(true);
        expect((res as any).getStatus()).toBe(401);
        expect(schedule).not.toHaveBeenCalled();
    });
});
