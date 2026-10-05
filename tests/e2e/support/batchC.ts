import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    type APIRequestContext,
    type Browser,
    type BrowserContext,
    expect,
    type Locator,
    type Page,
    request,
    test,
} from '@playwright/test';
import { dismissPromptsFor, mintToken } from './auth';
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
 * Helpers for the item-164 batch C specs: the Settings dialog's staged save
 * (smoke 13.4-13.9), the top-bar update pill (6.9), the dependency alert
 * (13.7), the welcome modal (1.11), the reminder cards (13.10) and the port
 * hand-off (13.11).
 *
 * Kept out of `privateServer.ts` and `auth.ts` on purpose: these rows needed
 * three things those modules do not offer (a spawn WITHOUT the port override, a
 * read of the settings write-ahead log, and an Updates tab that believes it is
 * an installed build), and the shared helpers are relied on by rows that must
 * not change shape under them.
 */

// ---------------------------------------------------------------------------
// Private servers
// ---------------------------------------------------------------------------

/** Every batch C data root starts with this, so a stray one is attributable. */
export const DATA_ROOT_PREFIX = 'ws-scrcpy-web-e2e-164c-';

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
    const paths = privateServerPaths(`${DATA_ROOT_PREFIX}${name}`, port);
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
    const paths = privateServerPaths(`${DATA_ROOT_PREFIX}${name}`, port);
    const handle = spawnServer(paths);
    await waitForServer(handle, paths.baseURL);
    return { paths, handle };
}

/**
 * `spawnServer` without `WS_SCRCPY_WEB_PORT`.
 *
 * The override forces an EXACT port and never walks forward, so it cannot
 * produce the auto-shifted port that 1.11's "start with the port shifted" is
 * about. Every other variable matches `spawnServer`, so the data root, the log
 * and the dependencies folder stay inside the private root.
 */
export function spawnServerWithoutPortOverride(paths: PrivateServerPaths): ServerHandle {
    const configFile = test.info().config.configFile;
    const repoRoot = configFile ? path.dirname(configFile) : process.cwd();
    const distIndex = path.resolve(repoRoot, 'dist', 'index.js');
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        PROGRAMDATA: paths.programData,
        DATA_ROOT: paths.dataRoot,
        DEPS_PATH: path.join(paths.dataRoot, 'dependencies'),
        WS_SCRCPY_CONFIG: paths.configPath,
    };
    delete env['WS_SCRCPY_WEB_PORT'];
    const child: ChildProcess = spawn(process.execPath, [distIndex], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: string[] = [];
    child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));
    child.stderr?.on('data', (d: Buffer) => chunks.push(d.toString()));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    return { child, exited, output: () => chunks.join('') };
}

/** Stop (if still running) and remove the private root. Safe to call twice. */
export async function disposePrivateServer(server: PrivateServer | undefined): Promise<void> {
    if (!server) return;
    await stopServer(server.handle);
    removeDataRoot(server.paths);
}

export function removeDataRoot(paths: PrivateServerPaths): void {
    // Windows can hold the database a beat after the process is gone.
    rmSync(paths.programData, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

/** An APIRequestContext on a private server with the instance token minted. */
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

export function readConfigFile(paths: PrivateServerPaths): Record<string, unknown> {
    return JSON.parse(readFileSync(paths.configPath, 'utf8')) as Record<string, unknown>;
}

export function readConfigBytes(paths: PrivateServerPaths): string {
    return readFileSync(paths.configPath, 'utf8');
}

/** `<dataRoot>/logs/ws-scrcpy-web.log`: the console echo is TTY-only, so the file is the log. */
export function readServerLog(paths: PrivateServerPaths): string {
    const file = path.join(paths.dataRoot, 'logs', 'ws-scrcpy-web.log');
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Hold a port the way another program would (dual-stack wildcard, like the app's own listen). */
export async function holdPort(port: number): Promise<net.Server> {
    // Accepted sockets are closed at once and their errors swallowed. A walking
    // server PROBES the busy port to ask whether a sibling instance holds it
    // (siblingInstance.ts), then aborts the probe; an accepted socket with no
    // 'error' listener turns that reset into an uncaught `read ECONNRESET` in
    // the test process, with no stack pointing anywhere near the cause.
    const blocker = net.createServer((socket) => {
        socket.on('error', () => {});
        socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(port, () => resolve());
    });
    return blocker;
}

export function releasePort(blocker: net.Server | undefined): Promise<void> {
    return new Promise((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
}

// ---------------------------------------------------------------------------
// The settings write-ahead log (pending_settings)
// ---------------------------------------------------------------------------

export interface WalRow {
    id: number;
    status: string;
    changes: { id: string; to: unknown }[];
    error: string | null;
}

function openDb(dbPath: string): DatabaseSync {
    try {
        return new DatabaseSync(dbPath, { readOnly: true });
    } catch {
        return new DatabaseSync(dbPath);
    }
}

/** Every row of the batch WAL, oldest first. Opened and closed per call. */
export function walRows(dbPath: string): WalRow[] {
    const db = openDb(dbPath);
    try {
        const rows = db.prepare('SELECT id, status, changes, error FROM pending_settings ORDER BY id').all() as {
            id: number;
            status: string;
            changes: string;
            error: string | null;
        }[];
        return rows.map((r) => ({
            id: r.id,
            status: r.status,
            changes: JSON.parse(r.changes) as WalRow['changes'],
            error: r.error,
        }));
    } finally {
        db.close();
    }
}

/**
 * Leave behind exactly what a server killed mid-apply leaves: a row still
 * `pending`. Only ever called while the server is STOPPED.
 *
 * The real kill cannot be timed from outside — the apply loop is synchronous
 * between `create` and `markCompleted` — so the spec plants its residue
 * instead and asserts what the next boot does with it.
 */
export function plantPendingBatch(dbPath: string, changes: { id: string; label: string; to: unknown }[]): number {
    const db = new DatabaseSync(dbPath);
    try {
        const info = db
            .prepare('INSERT INTO pending_settings (user_id, created_at, status, changes) VALUES (?, ?, ?, ?)')
            .run(1, Date.now(), 'pending', JSON.stringify(changes.map((c) => ({ ...c, from: null }))));
        return Number(info.lastInsertRowid);
    } finally {
        db.close();
    }
}

// ---------------------------------------------------------------------------
// Network observation and stubs
// ---------------------------------------------------------------------------

export interface SeenRequest {
    method: string;
    path: string;
    body: unknown;
}

/**
 * The boot-time theme persist: a user with no stored theme has the OS reading
 * written back on EVERY page load (`applyStoredTheme` in ThemeToggle.ts), so a
 * fresh or reset user sends `PATCH /api/settings {"theme": …}` whatever else
 * happens on the page. No batch C row is about it.
 */
export function isThemePersist(w: SeenRequest): boolean {
    return (
        w.method === 'PATCH' &&
        w.path === '/api/settings' &&
        typeof w.body === 'object' &&
        w.body !== null &&
        Object.keys(w.body).join(',') === 'theme'
    );
}

/** The per-user flags the reminder cards and the welcome modal write. */
export const PROMPT_FLAGS = ['bookmarkDismissedForPort', 'bookmarkDismissedGlobally', 'serviceFirstRunSeen'] as const;

/**
 * Record every NON-GET request the page sends to `/api/`. "Nothing is written"
 * is asserted against this: a write has to be a non-GET.
 *
 * Everything is recorded except the boot-time theme persist
 * (`isThemePersist`), which a user with no stored theme sends on load
 * regardless of what the row does, and which lands at a time no spec controls.
 */
export function recordApiWrites(page: Page): SeenRequest[] {
    const seen: SeenRequest[] = [];
    page.on('request', (req) => {
        const url = new URL(req.url());
        if (req.method() === 'GET' || !url.pathname.startsWith('/api/')) return;
        let body: unknown = null;
        try {
            body = req.postDataJSON();
        } catch {
            body = req.postData();
        }
        const write = { method: req.method(), path: url.pathname, body };
        if (!isThemePersist(write)) seen.push(write);
    });
    return seen;
}

export const INSTALLED_VERSION = '0.0.0-e2e';

/**
 * Make the Updates tab render its controls on a build that is not installed.
 *
 * The fast tier runs `node dist/index.js`, which is not a Velopack install, so
 * GET /api/updates/status answers `isInstalled: false` and the tab shows only
 * the dev-mode note (13.9's second half asserts exactly that, unstubbed). The
 * staged fields the rows are about exist only on the installed branch, so this
 * fetches the REAL status and flips that one flag. The four staged values
 * therefore stay the server's own, and Save still goes to the real
 * POST /api/settings/batch — only the GET is touched.
 */
export async function stubInstalledUpdates(page: Page): Promise<void> {
    await page.route('**/api/updates/status', async (route) => {
        // The rows that change the web port end the server mid-test, and the
        // pill keeps polling; a dead upstream is a failed request, not a
        // handler that throws into the test.
        let res: Awaited<ReturnType<typeof route.fetch>>;
        try {
            res = await route.fetch();
        } catch {
            await route.abort('connectionrefused');
            return;
        }
        const real = (await res.json()) as Record<string, unknown>;
        await route.fulfill({
            response: res,
            json: { ...real, isInstalled: true, currentVersion: INSTALLED_VERSION, status: 'idle' },
        });
    });
}

export interface UpdatesState {
    channel: string;
    autoUpdate: boolean;
    updateCheckIntervalMinutes: number;
    githubOwner: string;
}

/** The four staged values as the SERVER holds them (an unrouted request context). */
export async function serverUpdatesState(ctx: APIRequestContext): Promise<UpdatesState> {
    const res = await ctx.get('/api/updates/status');
    expect(res.status(), 'GET /api/updates/status').toBe(200);
    const s = (await res.json()) as UpdatesState;
    return {
        channel: s.channel,
        autoUpdate: s.autoUpdate,
        updateCheckIntervalMinutes: s.updateCheckIntervalMinutes,
        githubOwner: s.githubOwner,
    };
}

// ---------------------------------------------------------------------------
// Dialog locators and input
// ---------------------------------------------------------------------------

function modalTitled(page: Page, title: string): Locator {
    return page
        .locator('dialog.modal')
        .filter({ has: page.locator('.modal-title', { hasText: new RegExp(`^${title}$`) }) });
}

/** SettingsSummaryModal: "Review changes". */
export function reviewDialog(page: Page): Locator {
    return modalTitled(page, 'Review changes');
}

/** SettingsDirtyCloseModal: "Unsaved changes". */
export function unsavedDialog(page: Page): Locator {
    return modalTitled(page, 'Unsaved changes');
}

/** The review's lines, exactly as rendered. */
export function reviewLines(review: Locator): Locator {
    return review.locator('.settings-summary__list > li');
}

/** The dialog-level footer Save (lowercase `save`, `button.settings-save`). */
export function footerSave(settings: Locator): Locator {
    return settings.locator('button.settings-save');
}

/**
 * Type a value the way a user does, then leave the field.
 *
 * Typed, not `fill()`ed: the web-port guard hangs off `change`, and a
 * programmatic fill leaves the field un-dirtied so no blur commits it (13.3
 * measured this). The Updates fields commit on blur too.
 */
export async function typeAndLeave(input: Locator, value: string): Promise<void> {
    await input.click();
    await input.press('ControlOrMeta+a');
    await input.press('Delete');
    if (value.length > 0) await input.pressSequentially(value);
    await input.press('Tab');
}
