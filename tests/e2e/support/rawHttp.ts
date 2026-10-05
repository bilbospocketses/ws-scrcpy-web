import { randomBytes } from 'node:crypto';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';

/**
 * HTTP below Playwright: requests whose every header is the caller's, raw
 * WebSocket handshakes, a "different machine" address, and a page served from
 * a loopback origin of the spec's own.
 *
 * Playwright's request context owns Host, Origin and its cookie jar, and a
 * browser always sends its own Origin. The rows that need these are about
 * exactly those headers, so they go through node's client instead.
 */

/** The request gate's token refusal, as `HttpServer` serialises it. */
export const TOKEN_REFUSAL = { error: 'forbidden', reason: 'missing or invalid token' } as const;

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

/** The body as JSON, or as the raw text when it is not JSON (so a failed `toEqual` prints it). */
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

/** Mint the instance token on a private server the way a browser does: one document GET. */
export async function tokenCookieFor(port: number, extraHeaders: Record<string, string> = {}): Promise<string> {
    const doc = await raw({ port, path: '/', headers: { host: `localhost:${port}`, ...extraHeaders } });
    if (doc.status !== 200) throw new Error(`document GET on ${port} answered ${doc.status}`);
    const pair = cookiePair(setCookieNamed(doc, 'ws_scrcpy_token'));
    if (!pair) throw new Error(`document GET on ${port} set no token cookie: ${JSON.stringify(doc.setCookies)}`);
    return pair;
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
 * This host's first non-loopback, non-link-local IPv4 address, or undefined.
 *
 * A request from this process to that address arrives at the server from that
 * address, not from 127.0.0.1 — which is everything `isLoopback` looks at
 * (`isLoopback(req.socket.remoteAddress)`), so it is the honest stand-in for
 * "another machine" in the loopback-only rows.
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
 * Serve one HTML page at every path of `http://localhost:<port>`, on loopback
 * only: the embedding page of an origin the spec controls. Bound on 127.0.0.1
 * and, where the host has it, ::1 — Chrome tries both addresses for
 * `localhost`. Close it in a `finally`.
 */
export async function serveHtml(port: number, html: string): Promise<{ close(): Promise<void> }> {
    const servers: Server[] = [];
    const listenOn = (host: string) =>
        new Promise<void>((resolve, reject) => {
            const server = createServer((_req, res) => {
                res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
                res.end(html);
            });
            server.once('error', reject);
            server.listen(port, host, () => {
                servers.push(server);
                resolve();
            });
        });
    await listenOn('127.0.0.1');
    try {
        await listenOn('::1');
    } catch (err) {
        // A host with IPv6 disabled has no ::1; 127.0.0.1 alone still serves localhost.
        if ((err as NodeJS.ErrnoException).code !== 'EADDRNOTAVAIL') throw err;
    }
    return {
        close: async () => {
            await Promise.all(
                servers.map(
                    (s) =>
                        new Promise<void>((resolve) => {
                            s.closeAllConnections();
                            s.close(() => resolve());
                        }),
                ),
            );
        },
    };
}
