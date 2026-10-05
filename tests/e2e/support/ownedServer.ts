import {
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    expect,
    type Page,
    request,
} from '@playwright/test';
import { type Credentials, dismissPromptsFor, lockdown, me, mintToken } from './auth';
import {
    type PrivateServerPaths,
    privateServerPaths,
    removePrivateRoot,
    type ServerHandle,
    seedPrivateDataRoot,
    spawnServer,
    stopQuietly,
    stopServer,
    waitForServer,
} from './privateServer';

/**
 * A spec-owned server, seeded, booted and ready to serve, in the two shapes the
 * rows use:
 *
 *   - `OwnedServer`, which can restart on the same root and port with different
 *     environment, and removes its root on `dispose`. Its default spawn REMOVES
 *     the remote-admin opt-out, because a runner that happens to export it would
 *     make every "local" assertion lie (the auth-admin rows).
 *   - `startPrivateServer` / `restartOnPort`, a plain `{ paths, handle }` whose
 *     restart moves to another port on the same root — what the launcher's
 *     supervisor does after a web-port change (the settings rows).
 *
 * Either way the shared server is never touched: it must stay in open mode with
 * its users and settings as the later spec files expect them.
 */

/** A standalone API context on a spec-owned server, with the instance token already minted. */
export async function apiContext(baseURL: string): Promise<APIRequestContext> {
    const ctx = await request.newContext({ baseURL });
    await mintToken(ctx);
    return ctx;
}

/**
 * Dismiss the bookmark and service reminders for the implicit admin, as
 * global-setup does for the shared server. Rows that are not ABOUT the cards
 * call this so the card never sits over the controls they drive.
 */
export async function dismissPrivatePrompts(baseURL: string): Promise<void> {
    const ctx = await apiContext(baseURL);
    try {
        await dismissPromptsFor(ctx);
    } finally {
        await ctx.dispose();
    }
}

/** A fresh context on `baseURL` with one page, NOT yet navigated (routes go on first). */
export async function freshPage(browser: Browser, baseURL: string): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    return { context, page };
}

// ---------------------------------------------------------------------------
// OwnedServer: restartable on its own port, remote-admin opt-out removed
// ---------------------------------------------------------------------------

/** Data-root names all start with this, so a leftover is attributable at a glance. */
const OWNED_ROOT_PREFIX = 'ws-scrcpy-web-e2e-164b-';

/** The opt-out under test in 18.16 and 18.22; spelled once. requireOperator.ts. */
export const REMOTE_ADMIN_ENV = 'WS_SCRCPY_ALLOW_REMOTE_ADMIN';

/**
 * One spec-owned server: seeded root, spawned child, ready to serve. `restart`
 * stops the child and spawns a new one on the SAME root (and port), optionally
 * with different environment; `dispose` stops whatever is running and removes
 * the root.
 */
export class OwnedServer {
    readonly paths: PrivateServerPaths;
    private readonly handles: ServerHandle[] = [];

    private constructor(paths: PrivateServerPaths) {
        this.paths = paths;
    }

    static async start(
        row: string,
        port: number,
        env: Record<string, string | undefined> = { [REMOTE_ADMIN_ENV]: undefined },
    ): Promise<OwnedServer> {
        const server = new OwnedServer(privateServerPaths(`${OWNED_ROOT_PREFIX}${row}`, port));
        seedPrivateDataRoot(server.paths);
        await server.spawn(env);
        return server;
    }

    get baseURL(): string {
        return this.paths.baseURL;
    }

    /** The child currently serving (the last one spawned). */
    get handle(): ServerHandle {
        const h = this.handles[this.handles.length - 1];
        if (!h) throw new Error('no server spawned');
        return h;
    }

    async restart(env: Record<string, string | undefined> = { [REMOTE_ADMIN_ENV]: undefined }): Promise<void> {
        await stopServer(this.handle);
        await this.spawn(env);
    }

    private async spawn(env: Record<string, string | undefined>): Promise<void> {
        const handle = spawnServer(this.paths, { env });
        this.handles.push(handle);
        await waitForServer(handle, this.paths.baseURL);
    }

    async dispose(label: string): Promise<void> {
        for (const handle of this.handles) await stopQuietly(handle, label);
        try {
            removePrivateRoot(this.paths);
        } catch (err) {
            // EBUSY on the WAL sidecars is tolerated: the next run re-seeds the root.
            console.warn(`${label} cleanup: ${String(err)}`);
        }
    }
}

/**
 * Secure the admin account the product's way (one POST /api/users on a fresh
 * store) and leave the server LOCKED. The prompts are dismissed for user 1
 * first: lockdown renames user 1, so the admin inherits them.
 */
export async function lockDown(baseURL: string, admin: Credentials, user: Credentials): Promise<void> {
    const setup = await apiContext(baseURL);
    try {
        await dismissPromptsFor(setup);
        const boot = await me(setup);
        expect(boot.authEnabled, 'a spec-owned root must boot as a fresh install').toBe(false);
        const res = await lockdown(setup, {
            adminUsername: admin.username,
            adminPassword: admin.password,
            username: user.username,
            password: user.password,
            role: 'user',
        });
        expect(res.status(), `lockdown: ${await res.text()}`).toBe(201);
        expect(await res.json()).toEqual({ ok: true });
        expect(await me(setup)).toEqual({ authEnabled: true, user: null });
    } finally {
        await setup.dispose();
    }
}

// ---------------------------------------------------------------------------
// PrivateServer: a plain { paths, handle }, restartable on another port
// ---------------------------------------------------------------------------

/** Every settings-row data root starts with this, so a stray one is attributable. */
export const PRIVATE_ROOT_PREFIX = 'ws-scrcpy-web-e2e-164c-';

export interface PrivateServer {
    paths: PrivateServerPaths;
    handle: ServerHandle;
}

/**
 * Seed a fresh private data root and boot a server on it, the way 18.12 does.
 *
 * `extraConfig` lands in config.json verbatim (`firstRunComplete: false` for
 * the welcome modal).
 */
export async function startPrivateServer(
    name: string,
    port: number,
    extraConfig: Record<string, unknown> = {},
): Promise<PrivateServer> {
    const paths = privateServerPaths(`${PRIVATE_ROOT_PREFIX}${name}`, port);
    seedPrivateDataRoot(paths, extraConfig);
    const handle = spawnServer(paths);
    await waitForServer(handle, paths.baseURL);
    return { paths, handle };
}

/**
 * Boot the SAME data root again on another port: what the launcher's supervisor
 * does after the exit-75 a web-port change ends with. The fast tier has no
 * supervisor, so the spec plays its part. Not re-seeded — the point is the
 * state the first process left behind.
 */
export async function restartOnPort(name: string, port: number): Promise<PrivateServer> {
    const paths = privateServerPaths(`${PRIVATE_ROOT_PREFIX}${name}`, port);
    const handle = spawnServer(paths);
    await waitForServer(handle, paths.baseURL);
    return { paths, handle };
}

/** Stop (if still running) and remove the private root. Safe to call twice. */
export async function disposePrivateServer(server: PrivateServer | undefined): Promise<void> {
    if (!server) return;
    await stopServer(server.handle);
    removePrivateRoot(server.paths);
}
