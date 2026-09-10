import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config } from '../../Config';
import { EnvName } from '../../EnvName';
import { setAuthEnabled } from '../authState';
import { requireOperator } from '../requireOperator';

const tmpDirs: string[] = [];
const saved = { CONFIG: process.env[EnvName.CONFIG_PATH], DEPS: process.env['DEPS_PATH'] };

function setup(): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsauth-oper-'));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webPort: 8000 }));
    process.env[EnvName.CONFIG_PATH] = path.join(dir, 'config.json');
    process.env['DEPS_PATH'] = path.join(dir, 'deps');
    Config._resetForTest();
}

afterEach(() => {
    Config._resetForTest();
    if (saved.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
    else process.env[EnvName.CONFIG_PATH] = saved.CONFIG;
    if (saved.DEPS === undefined) delete process.env['DEPS_PATH'];
    else process.env['DEPS_PATH'] = saved.DEPS;
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function mkRes(): { res: ServerResponse; status: () => number; body: () => string } {
    let status = 0;
    const chunks: string[] = [];
    const res = {
        writeHead(s: number) {
            status = s;
            return res;
        },
        end(c?: string) {
            if (c) chunks.push(c);
        },
    } as unknown as ServerResponse;
    return { res, status: () => status, body: () => chunks.join('') };
}

function mkReq(remoteAddress: string | undefined, user?: { id: number }): IncomingMessage {
    const req = {} as IncomingMessage;
    if (remoteAddress !== undefined) {
        (req as { socket?: unknown }).socket = { remoteAddress };
    }
    if (user) (req as IncomingMessage & { user?: unknown }).user = user;
    return req;
}

describe('requireOperator — open mode', () => {
    it('allows a loopback caller (implicit admin)', () => {
        setup();
        const r = mkRes();
        expect(requireOperator(mkReq('127.0.0.1'), r.res)).toBe(true);
    });

    it('allows an IPv4-mapped loopback caller', () => {
        setup();
        const r = mkRes();
        expect(requireOperator(mkReq('::ffff:127.0.0.1'), r.res)).toBe(true);
    });

    it('403s an off-box caller with no opt-out', () => {
        setup();
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50'), r.res)).toBe(false);
        expect(r.status()).toBe(403);
        expect(JSON.parse(r.body())).toEqual({ error: 'admin actions are limited to this machine' });
    });

    it('403s a caller with no socket at all — fail closed', () => {
        setup();
        const r = mkRes();
        expect(requireOperator(mkReq(undefined), r.res)).toBe(false);
        expect(r.status()).toBe(403);
    });
});

describe('requireOperator — auth enabled', () => {
    it('allows a signed-in admin from off-box (loopback irrelevant)', () => {
        setup();
        const db = Config.getInstance().db;
        setAuthEnabled(db, true);
        const admin = db.users.create({ username: 'root', role: 'admin', passwordHash: 'x' });
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50', { id: admin.id }), r.res)).toBe(true);
    });

    it('403s a signed-in NON-admin from loopback — requireAdmin still runs last', () => {
        setup();
        const db = Config.getInstance().db;
        setAuthEnabled(db, true);
        const bob = db.users.create({ username: 'bob', role: 'user', passwordHash: 'x' });
        const r = mkRes();
        expect(requireOperator(mkReq('127.0.0.1', { id: bob.id }), r.res)).toBe(false);
        expect(r.status()).toBe(403);
    });

    it('403s an unauthenticated off-box caller', () => {
        setup();
        setAuthEnabled(Config.getInstance().db, true);
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50'), r.res)).toBe(false);
        expect(r.status()).toBe(403);
    });
});

describe('requireOperator — explicit opt-out', () => {
    const savedFlag = process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
    afterEach(() => {
        if (savedFlag === undefined) delete process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'];
        else process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = savedFlag;
    });

    it('allows an off-box caller when the env var is exactly "1"', () => {
        setup();
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50'), r.res)).toBe(true);
    });

    it('does NOT accept "true" — the value must be exactly "1"', () => {
        setup();
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = 'true';
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50'), r.res)).toBe(false);
        expect(r.status()).toBe(403);
    });

    it('allows an off-box caller when config.json sets allowRemoteAdmin', () => {
        setup();
        Config.getInstance().updateAppConfig({ allowRemoteAdmin: true });
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50'), r.res)).toBe(true);
    });

    it('is ignored when auth is enabled — a signed-in session is required regardless', () => {
        setup();
        setAuthEnabled(Config.getInstance().db, true);
        process.env['WS_SCRCPY_ALLOW_REMOTE_ADMIN'] = '1';
        const r = mkRes();
        expect(requireOperator(mkReq('192.168.1.50'), r.res)).toBe(false);
        expect(r.status()).toBe(403);
    });
});
