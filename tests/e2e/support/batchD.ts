import { execFileSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { type APIRequestContext, expect, type Page, request } from '@playwright/test';
import { type Credentials, lockdown, me, mintToken } from './auth';
import {
    type PrivateServerPaths,
    privateServerPaths,
    type ServerHandle,
    seedPrivateDataRoot,
    spawnServer,
    stopServer,
    waitForServer,
} from './privateServer';

/**
 * Helpers shared by `devices-ui.spec.ts` and `embed-trust.spec.ts` (item 164,
 * batch D: smoke rows 7.10, 7.11, 7.13, 7.14, 10.15, 10.16, 10.20).
 *
 * Kept apart from auth.ts and privateServer.ts so nothing here can change the
 * behaviour of the specs that already import those.
 */

/** The two accounts a locked private server is given. Never the shared server's. */
export const PRIVATE_ADMIN: Credentials = { username: 'e2e-164d-admin', password: 'e2e-164d-admin-pw' };
export const PRIVATE_USER: Credentials = { username: 'e2e-164d-user', password: 'e2e-164d-user-pw' };

export interface LockedPrivateServer {
    paths: PrivateServerPaths;
    handle: ServerHandle;
    /** The port of this server's own adb daemon, when it was given one. */
    isolatedAdbPort: number | undefined;
    /** Stop the child and remove its data root. Never throws: cleanup must not mask the test's own failure. */
    stop(): Promise<void>;
}

export interface PrivateServerOptions {
    /**
     * Give the server an adb daemon of its own on this port, with mDNS
     * discovery switched off (`ADB_MDNS=0`). Without it the server shares the
     * machine's daemon on 5037 — and on a developer's box that daemon
     * auto-connects every paired device advertising on the LAN, so "no device
     * connected" and "nothing advertising" stop being true for reasons that
     * have nothing to do with the app. Measured 2026-10-05: a Google TV
     * Streamer on the LAN appeared in the shared server's device list and in
     * its quick scan.
     */
    isolatedAdbPort?: number;
}

/** The adb binary the server installed under its data root, once it has. */
export function installedAdb(paths: PrivateServerPaths): string | undefined {
    const root = path.join(paths.dataRoot, 'dependencies');
    const stack = [root];
    while (stack.length) {
        const dir = stack.pop() as string;
        let entries: import('node:fs').Dirent[];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) stack.push(full);
            else if (e.name === (process.platform === 'win32' ? 'adb.exe' : 'adb')) return full;
        }
    }
    return undefined;
}

/**
 * Run the server's own adb against its isolated daemon — the out-of-band
 * witness for what the app's device list should say. Never the machine's
 * daemon, and never resolved from PATH.
 */
export function isolatedAdb(server: LockedPrivateServer, ...args: string[]): string {
    expect(server.isolatedAdbPort, 'this private server was started without an isolated adb daemon').toBeDefined();
    const adb = installedAdb(server.paths);
    expect(adb, 'the private server has not installed adb yet').toBeDefined();
    return execFileSync(adb as string, args, {
        encoding: 'utf8',
        timeout: 30_000,
        env: { ...process.env, ANDROID_ADB_SERVER_PORT: String(server.isolatedAdbPort), ADB_MDNS: '0' },
    });
}

/**
 * Wait until `names` all report an installed version, through a context that
 * can read /api/dependencies — in locked mode that is a signed-in admin, which
 * is why `waitForDependencies` (a fresh, sessionless context) cannot be used.
 */
export async function waitForInstalled(ctx: APIRequestContext, names: string[], timeoutMs = 120_000): Promise<void> {
    await expect
        .poll(
            async () => {
                const res = await ctx.get('/api/dependencies');
                if (res.status() !== 200) return `HTTP ${res.status()}`;
                const deps = (await res.json()) as { name: string; installedVersion: string | null }[];
                return names
                    .map((n) => `${n}=${deps.find((d) => d.name === n)?.installedVersion ? 'installed' : 'missing'}`)
                    .join(', ');
            },
            { timeout: timeoutMs, intervals: [1_000], message: `waiting for ${names.join(', ')} to install` },
        )
        .toBe(names.map((n) => `${n}=installed`).join(', '));
}

/**
 * A spec-owned server, booted and then put into locked mode with one admin and
 * one user-role account — so a row can be judged against login without ever
 * touching the shared server's auth state, which nothing in the API can undo.
 *
 * `name` must start `ws-scrcpy-web-e2e-164d-` and `port` must be one of
 * 8181–8189: batch D's private ranges. So must `isolatedAdbPort`.
 */
export async function startLockedPrivateServer(
    name: string,
    port: number,
    options: PrivateServerOptions = {},
): Promise<LockedPrivateServer> {
    const paths = privateServerPaths(name, port);
    seedPrivateDataRoot(paths);
    const isolatedAdbPort = options.isolatedAdbPort;
    // spawnServer copies process.env into the child at the call, so the two
    // variables are set for exactly that one synchronous call and put back.
    const saved = { port: process.env['ANDROID_ADB_SERVER_PORT'], mdns: process.env['ADB_MDNS'] };
    let handle: ServerHandle;
    try {
        if (isolatedAdbPort !== undefined) {
            process.env['ANDROID_ADB_SERVER_PORT'] = String(isolatedAdbPort);
            process.env['ADB_MDNS'] = '0';
        }
        handle = spawnServer(paths);
    } finally {
        if (saved.port === undefined) delete process.env['ANDROID_ADB_SERVER_PORT'];
        else process.env['ANDROID_ADB_SERVER_PORT'] = saved.port;
        if (saved.mdns === undefined) delete process.env['ADB_MDNS'];
        else process.env['ADB_MDNS'] = saved.mdns;
    }
    const server: LockedPrivateServer = { paths, handle, isolatedAdbPort, stop: async () => {} };
    const stop = async (): Promise<void> => {
        try {
            await stopServer(handle);
        } catch (err) {
            console.warn('stopping a batch D private server failed:', name, String(err));
        }
        // The isolated daemon is detached and outlives the server (on Windows the
        // kill is TerminateProcess, so the server's own clean shutdown never
        // runs); it also holds adb.exe open, which would block the rm below.
        if (isolatedAdbPort !== undefined && installedAdb(paths)) {
            try {
                isolatedAdb(server, 'kill-server');
            } catch {
                // Already gone — the server's SIGTERM handler kills it on Linux.
            }
        }
        try {
            rmSync(paths.programData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch (err) {
            // Windows can hold the WAL sidecars for a moment after the exit; the
            // next run's seedPrivateDataRoot wipes the directory regardless.
            console.warn('removing a batch D private data root failed:', paths.programData, String(err));
        }
    };
    try {
        await waitForServer(handle, paths.baseURL);
        const setup = await request.newContext({ baseURL: paths.baseURL });
        try {
            await mintToken(setup);
            const locked = await lockdown(setup, {
                adminUsername: PRIVATE_ADMIN.username,
                adminPassword: PRIVATE_ADMIN.password,
                username: PRIVATE_USER.username,
                password: PRIVATE_USER.password,
                role: 'user',
            });
            expect(locked.status(), 'first-user lockdown of the private server').toBe(201);
            expect(await locked.json()).toEqual({ ok: true });
            expect((await me(setup)).authEnabled, 'the private server is now in locked mode').toBe(true);
        } finally {
            await setup.dispose();
        }
    } catch (err) {
        await stop();
        throw err;
    }
    server.stop = stop;
    return server;
}

/**
 * Serve one HTML page at every path of `http://localhost:<port>`, on loopback
 * only. Bound on 127.0.0.1 and, where the host has it, ::1 — Chrome tries both
 * addresses for `localhost`. Close it in a `finally`.
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

/**
 * This host's first non-loopback, non-link-local IPv4 address, or undefined.
 *
 * Connecting to it from this same machine gives the server a socket whose
 * `remoteAddress` is that address rather than 127.0.0.1 — which is everything
 * `isLoopback` looks at, so it is the honest stand-in for "another machine".
 */
export function nonLoopbackIPv4(): string | undefined {
    for (const addrs of Object.values(networkInterfaces())) {
        for (const a of addrs ?? []) {
            if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) return a.address;
        }
    }
    return undefined;
}

/**
 * Count, in the page, every `fetch()` whose URL contains `fragment`, under
 * `window.__fetchCounts[fragment]`. Counted at CALL time, synchronously, so a
 * read straight after the action that would have caused one is exact — unlike a
 * network listener, which hears about the request later. Install before the
 * first navigation.
 */
export async function countFetches(page: Page, fragments: string[]): Promise<void> {
    await page.addInitScript((frags: string[]) => {
        const w = window as unknown as { __fetchCounts: Record<string, number> };
        w.__fetchCounts = Object.fromEntries(frags.map((f) => [f, 0]));
        const original = window.fetch.bind(window);
        window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            for (const f of frags) {
                if (url.includes(f)) w.__fetchCounts[f] = (w.__fetchCounts[f] ?? 0) + 1;
            }
            return original(input, init);
        };
    }, fragments);
}

export async function fetchCount(page: Page, fragment: string): Promise<number> {
    return page.evaluate(
        (f) => (window as unknown as { __fetchCounts?: Record<string, number> }).__fetchCounts?.[f] ?? -1,
        fragment,
    );
}

/**
 * Put the shared server's embed state back: cancel whatever request is pending
 * and revoke every approved origin. Through the app's own API — never a file
 * write, which would leave the live allowlist and config.json disagreeing.
 *
 * `ctx` must have loaded '/' (it needs the instance token) and be on loopback.
 */
export async function resetSharedEmbedState(ctx: APIRequestContext): Promise<void> {
    await mintToken(ctx);
    const pending = await ctx.get('/api/embed-request');
    expect(pending.status(), 'GET /api/embed-request (cleanup)').toBe(200);
    const body = (await pending.json()) as { request: { id: string } | null };
    if (body.request) {
        const res = await ctx.post(`/embed-request/${encodeURIComponent(body.request.id)}/cancel`);
        expect(res.status(), 'cancel the leftover pending embed request').toBe(200);
    }
    const listed = await ctx.get('/api/embed-origins');
    expect(listed.status(), 'GET /api/embed-origins (cleanup)').toBe(200);
    const { origins } = (await listed.json()) as { origins: string[] };
    for (const origin of origins) {
        const res = await ctx.post('/api/embed-origins/revoke', { data: { origin } });
        expect(res.status(), `revoke ${origin} (cleanup)`).toBe(200);
    }
}
