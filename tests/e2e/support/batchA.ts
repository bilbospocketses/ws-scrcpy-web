import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { test } from '@playwright/test';
import type { PrivateServerPaths, ServerHandle } from './privateServer';
import { stopServer } from './privateServer';
import { selfSignedCert } from './selfSignedCert';

/**
 * Helpers for the server / API / config-override rows of item 164 batch A
 * (`server-api.spec.ts`, `config-overrides.spec.ts`).
 *
 * Kept apart from `privateServer.ts` rather than added to it because these rows
 * need a spawn whose environment they control key by key: 1.12 must start with
 * NO `WS_SCRCPY_WEB_PORT` (the override is exact and never walks forward, so it
 * would turn the row into 12.6), 12.9 sets and clears `PORT`, `SCAN_CONCURRENCY`,
 * `DEPS_PATH` and `WS_SCRCPY_CONFIG` case by case, and every private server here
 * gets a private `LOCALAPPDATA` so the Windows TLS home (`WsScrcpyWeb-tls`, which
 * certPaths.ts resolves from LOCALAPPDATA, not from the data root) is never the
 * developer's real one.
 */

export const LOG_REL = path.join('logs', 'ws-scrcpy-web.log');

/** The line `exitIfNothingCanServe()` writes just before `process.exit(1)` (HttpServer.ts). */
export const NOTHING_SERVES = 'no listener is serving: every configured listener failed to bind';

/** The request gate's token refusal, as `HttpServer` serialises it. */
export const TOKEN_REFUSAL = { error: 'forbidden', reason: 'missing or invalid token' } as const;

export function logPath(paths: PrivateServerPaths): string {
    return path.join(paths.dataRoot, LOG_REL);
}

export function readLog(paths: PrivateServerPaths): string {
    const p = logPath(paths);
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

/** Length of the log right now, so a later boot's lines can be read on their own. */
export function logOffset(paths: PrivateServerPaths): number {
    const p = logPath(paths);
    return existsSync(p) ? statSync(p).size : 0;
}

/** Everything the log gained after `offset` (a byte length from `logOffset`). */
export function logSince(paths: PrivateServerPaths, offset: number): string {
    const p = logPath(paths);
    if (!existsSync(p)) return '';
    return readFileSync(p).subarray(offset).toString('utf8');
}

export function countOccurrences(haystack: string, needle: string): number {
    let n = 0;
    for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
    return n;
}

/** A per-server LOCALAPPDATA, under the private root so the seed's wipe removes it. */
export function privateLocalAppData(paths: PrivateServerPaths): string {
    return path.join(paths.programData, 'localappdata');
}

/**
 * Where the flat config looks for the Local HTTPS certificate. Mirrors
 * `resolveCertPaths` in `src/server/tls/certPaths.ts` (copied, not imported, to
 * keep server modules out of the test process): Windows keeps it in
 * `<LOCALAPPDATA>\WsScrcpyWeb-tls`, everything else in `<dataRoot>/tls`.
 */
export function certFilesFor(paths: PrivateServerPaths): { certFile: string; keyFile: string } {
    const dir =
        process.platform === 'win32'
            ? path.join(privateLocalAppData(paths), 'WsScrcpyWeb-tls')
            : path.join(paths.dataRoot, 'tls');
    return { certFile: path.join(dir, 'cert.pem'), keyFile: path.join(dir, 'key.pem') };
}

/**
 * Put a usable certificate where the flat config finds one, so the boot builds
 * a Local HTTPS listener exactly as it would after 21.1's "generate". Self-signed
 * (support/selfSignedCert.ts): `readCertMaterial` only needs a cert and key that
 * load and match, not a trusted chain, and the fast tier must not fetch mkcert.
 */
export function placeCertificate(paths: PrivateServerPaths): { cert: string; key: string } {
    const pair = selfSignedCert();
    const { certFile, keyFile } = certFilesFor(paths);
    mkdirSync(path.dirname(certFile), { recursive: true });
    writeFileSync(certFile, pair.cert, 'utf8');
    writeFileSync(keyFile, pair.key, 'utf8');
    return pair;
}

/**
 * Environment keys a developer's shell (or a CI step) could carry that would
 * silently change what a row measures. Cleared from the inherited environment
 * unless a case sets them on purpose.
 */
const INHERITED_OVERRIDES = [
    'PORT',
    'SCAN_CONCURRENCY',
    'SCAN_TCP_TIMEOUT_MS',
    'SCAN_ADB_CONNECT_TIMEOUT_MS',
    'SCAN_PROGRESS_INTERVAL',
    'WS_SCRCPY_SERVICE',
    'WS_SCRCPY_DOCKER',
    'WS_SCRCPY_LAUNCHER',
    'WS_SCRCPY_OPEN_BROWSER',
    'WS_SCRCPY_NO_BROWSER',
    'WS_SCRCPY_ALLOW_REMOTE_ADMIN',
    'VELOPACK_FEED_URL',
];

/**
 * `spawnServer` (privateServer.ts) with the environment under the caller's
 * control. The base is that function's block — PROGRAMDATA, DATA_ROOT,
 * DEPS_PATH, WS_SCRCPY_CONFIG and WS_SCRCPY_WEB_PORT pointed at the private root —
 * plus a private LOCALAPPDATA. `env` is applied last; a key set to `undefined`
 * is REMOVED, which is how a case starts with no port override or no DEPS_PATH.
 */
export function spawnServerWith(paths: PrivateServerPaths, env: Record<string, string | undefined> = {}): ServerHandle {
    const configFile = test.info().config.configFile;
    const repoRoot = configFile ? path.dirname(configFile) : process.cwd();
    const distIndex = path.resolve(repoRoot, 'dist', 'index.js');
    const childEnv: Record<string, string | undefined> = { ...process.env };
    for (const key of INHERITED_OVERRIDES) delete childEnv[key];
    Object.assign(childEnv, {
        PROGRAMDATA: paths.programData,
        DATA_ROOT: paths.dataRoot,
        DEPS_PATH: path.join(paths.dataRoot, 'dependencies'),
        WS_SCRCPY_CONFIG: paths.configPath,
        WS_SCRCPY_WEB_PORT: String(paths.port),
        LOCALAPPDATA: privateLocalAppData(paths),
    });
    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete childEnv[key];
        else childEnv[key] = value;
    }
    mkdirSync(privateLocalAppData(paths), { recursive: true });
    const child = spawn(process.execPath, [distIndex], {
        env: childEnv as NodeJS.ProcessEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: string[] = [];
    child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    return { child, exited, output: () => chunks.join('') };
}

/** `stopServer` that never throws out of a `finally`. */
export async function stopQuietly(handle: ServerHandle | undefined, label: string): Promise<void> {
    if (!handle) return;
    try {
        await stopServer(handle);
    } catch (err) {
        console.warn(`${label} cleanup: ${String(err)}`);
    }
}

export interface RawResponse {
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
    /** Every Set-Cookie header, whole (attributes included). */
    setCookies: string[];
}

/**
 * One HTTP request with every header under the caller's control. Playwright's
 * request context owns Host and its cookie jar, and a jar is exactly what must
 * not decide which `Secure` cookie gets sent over plain http; node's does not.
 */
export function raw(opts: {
    port: number;
    path: string;
    method?: string;
    host?: string;
    headers?: Record<string, string>;
    body?: unknown;
}): Promise<RawResponse> {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (payload !== undefined) {
        headers['content-type'] = 'application/json';
        headers['content-length'] = String(Buffer.byteLength(payload));
    }
    return new Promise((resolve, reject) => {
        const req = httpRequest(
            {
                host: opts.host ?? '127.0.0.1',
                port: opts.port,
                path: opts.path,
                method: opts.method ?? 'GET',
                headers,
                timeout: 60_000,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () => {
                    const sc = res.headers['set-cookie'];
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString(),
                        setCookies: Array.isArray(sc) ? sc : sc ? [sc] : [],
                    });
                });
            },
        );
        req.on('timeout', () => req.destroy(new Error(`timeout on ${opts.method ?? 'GET'} ${opts.path}`)));
        req.on('error', reject);
        if (payload !== undefined) req.write(payload);
        req.end();
    });
}

export function json(res: RawResponse): unknown {
    try {
        return JSON.parse(res.body);
    } catch {
        return res.body;
    }
}

/** The whole Set-Cookie header for one cookie name, or undefined. */
export function setCookieNamed(res: RawResponse, name: string): string | undefined {
    return res.setCookies.find((c) => c.startsWith(`${name}=`));
}

/** `name=value` for a request Cookie header, from a Set-Cookie header. */
export function cookiePair(setCookie: string | undefined): string {
    return (setCookie ?? '').split(';')[0] ?? '';
}

/**
 * A WebSocket opening handshake, raw, so the Origin is ours to set (a browser
 * always sends its own). Resolves with the HTTP status the server answered:
 * 101 when it upgraded (the socket is then closed at once), else the refusal.
 */
export function wsHandshake(opts: { port: number; path: string; headers: Record<string, string> }): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = httpRequest({
            host: '127.0.0.1',
            port: opts.port,
            path: opts.path,
            method: 'GET',
            timeout: 15_000,
            headers: {
                connection: 'Upgrade',
                upgrade: 'websocket',
                'sec-websocket-version': '13',
                'sec-websocket-key': randomBytes(16).toString('base64'),
                ...opts.headers,
            },
        });
        req.on('upgrade', (res, socket) => {
            socket.destroy();
            resolve(res.statusCode ?? 0);
        });
        req.on('response', (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on('timeout', () => req.destroy(new Error('websocket handshake timed out')));
        req.on('error', reject);
        req.end();
    });
}

/**
 * This machine's first non-loopback, non-link-local IPv4 address, or undefined.
 * A request from this process to that address arrives at the server from that
 * address, not from 127.0.0.1 — which is what the "another machine" halves of
 * the loopback-only rows key on (`isLoopback(req.socket.remoteAddress)`).
 */
export function lanAddress(): string | undefined {
    for (const list of Object.values(networkInterfaces())) {
        for (const a of list ?? []) {
            if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
        }
    }
    return undefined;
}

/**
 * Hold a port the way another program would: a wildcard bind, like the app's
 * own `server.listen(port)` (the same blocker lifecycle.spec.ts uses for 12.6).
 */
export async function holdPort(port: number): Promise<net.Server> {
    const blocker = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(port, () => resolve());
    });
    return blocker;
}

export function release(blocker: net.Server | undefined): Promise<void> {
    return new Promise((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
}

/** Does anything accept a TCP connection on localhost:`port` right now? */
export function isListening(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect({ port, host });
        const done = (v: boolean) => {
            socket.destroy();
            resolve(v);
        };
        socket.setTimeout(2_000, () => done(false));
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

/** Mint the instance token on a private server the way a browser does: one document GET. */
export async function tokenCookieFor(port: number, extraHeaders: Record<string, string> = {}): Promise<string> {
    const doc = await raw({ port, path: '/', headers: { host: `localhost:${port}`, ...extraHeaders } });
    if (doc.status !== 200) throw new Error(`document GET on ${port} answered ${doc.status}`);
    const pair = cookiePair(setCookieNamed(doc, 'ws_scrcpy_token'));
    if (!pair) throw new Error(`document GET on ${port} set no token cookie: ${JSON.stringify(doc.setCookies)}`);
    return pair;
}
