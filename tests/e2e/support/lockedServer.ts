import { execFileSync } from 'node:child_process';
import { type Dirent, readdirSync } from 'node:fs';
import path from 'node:path';
import { expect, request } from '@playwright/test';
import { type Credentials, lockdown, me, mintToken } from './auth';
import {
    type PrivateServerPaths,
    privateServerPaths,
    removePrivateRoot,
    type ServerHandle,
    seedPrivateDataRoot,
    spawnServer,
    stopQuietly,
    waitForServer,
} from './privateServer';

/**
 * A spec-owned server in locked mode, optionally with an adb daemon of its own,
 * for rows judged against login or against "no device" (smoke 7.10, 7.11,
 * 7.13, 7.14, 10.15, 10.16, 10.20) without ever touching the shared server's
 * auth state, which nothing in the API can undo.
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

export interface LockedServerOptions {
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
        let entries: Dirent[];
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
 * Boot a spec-owned server and put it into locked mode with one admin and one
 * user-role account (`PRIVATE_ADMIN`, `PRIVATE_USER`).
 *
 * `name` must start `ws-scrcpy-web-e2e-164d-` and `port` must be one of
 * 8181–8189, the range devices-ui.spec.ts and embed-trust.spec.ts share. So
 * must `isolatedAdbPort`.
 */
export async function startLockedPrivateServer(
    name: string,
    port: number,
    options: LockedServerOptions = {},
): Promise<LockedPrivateServer> {
    const paths = privateServerPaths(name, port);
    seedPrivateDataRoot(paths);
    const isolatedAdbPort = options.isolatedAdbPort;
    // Without an isolated daemon the child inherits whatever the runner has,
    // exactly as every other private server does.
    const handle = spawnServer(
        paths,
        isolatedAdbPort === undefined
            ? {}
            : { env: { ANDROID_ADB_SERVER_PORT: String(isolatedAdbPort), ADB_MDNS: '0' } },
    );
    const server: LockedPrivateServer = { paths, handle, isolatedAdbPort, stop: async () => {} };
    const stop = async (): Promise<void> => {
        await stopQuietly(handle, `locked private server ${name}`);
        // The adb daemon -- isolated or not -- is detached and outlives the
        // server (on Windows the kill is TerminateProcess, so the server's own
        // clean shutdown never runs), and it holds adb.exe open.
        // removePrivateRoot stops whatever runs from this root before removing
        // it (item 170), which takes that daemon with it and nothing outside the
        // root: a developer's own adb runs from its own install and never matches.
        try {
            removePrivateRoot(paths);
        } catch (err) {
            // Windows can hold the WAL sidecars for a moment after the exit; the
            // next run's seedPrivateDataRoot wipes the directory regardless.
            console.warn('removing a locked private data root failed:', paths.programData, String(err));
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
