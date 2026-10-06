import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type APIRequestContext, expect, request, test } from '@playwright/test';
import { E2E_TEMP_ENV, E2E_TEMP_ROOT, SEED_CONFIG } from './paths';
import { removeTree, stopProcessesUnder } from './rootProcesses';

/**
 * Spec-owned servers: every row that stops, restarts, locks or otherwise
 * changes a server the rest of the suite depends on.
 *
 * The fast tier's webServer is a bare `node dist/index.js` with no supervisor:
 * POST /api/dependencies/restart exits the process with code 75 and nothing
 * brings it back, so calling it on the shared 8123 server would end the suite.
 * Such a row spawns its own process on its own port and data root instead, and
 * this module is the one way to do that, so every private server gets the same
 * isolation.
 *
 * Kept apart from auth.ts so the child_process and node:sqlite imports stay out
 * of the other rows, which can then never reach the spawn API by accident.
 *
 * The child is `process.execPath` — the runner's own interpreter, exactly what
 * playwright.config.ts's `node dist/index.js` resolves to. It is deliberately
 * not vendored: the interpreter that runs the suite is its execution
 * environment, not an app dependency.
 */

export interface PrivateServerPaths {
    programData: string;
    dataRoot: string;
    configPath: string;
    dbPath: string;
    restartMarkerPath: string;
    /** Handed to the child as LOCALAPPDATA; see `spawnServer`. */
    localAppData: string;
    port: number;
    baseURL: string;
}

/**
 * `<E2E_TEMP_ROOT>/<name>` as PROGRAMDATA and `<that>/WsScrcpyWeb` as DATA_ROOT — the
 * server resolves its root from DATA_ROOT when set, else PROGRAMDATA on Windows,
 * so both are set to name the same directory. The database and the restart
 * marker live beside config.json.
 *
 * LOCALAPPDATA sits beside the data root, not inside it: `resolveCertPaths`
 * (src/server/tls/certPaths.ts) refuses a CA root that resolves under the data
 * root, and the refusal would switch Local HTTPS off for every row. Under
 * `programData` it is still wiped with the rest of the root.
 */
export function privateServerPaths(name: string, port: number): PrivateServerPaths {
    const programData = path.join(E2E_TEMP_ROOT, name);
    const dataRoot = path.join(programData, 'WsScrcpyWeb');
    return {
        programData,
        dataRoot,
        configPath: path.join(dataRoot, 'config.json'),
        dbPath: path.join(dataRoot, 'wsscrcpy.db'),
        restartMarkerPath: path.join(dataRoot, '.restart'),
        localAppData: path.join(programData, 'LocalAppData'),
        port,
        baseURL: `http://localhost:${port}`,
    };
}

/**
 * Wipe and re-seed the private root, mirroring the runner-only block in
 * playwright.config.ts: the seed config (with the port matching the override —
 * the override forces the EXACT port, and a shifted port would be persisted)
 * and the empty decline marker for the Linux system-wide-install offer.
 */
export function seedPrivateDataRoot(paths: PrivateServerPaths, extraConfig: Record<string, unknown> = {}): void {
    // A leftover from a run that never reached its teardown can still be
    // running from this root (item 170: the adb daemon), and would block the wipe.
    const leftovers = stopProcessesUnder(paths.programData);
    if (leftovers.length) {
        console.warn('stopped leftover process(es) running from a private root:', paths.programData, leftovers);
    }
    removeTree(paths.programData);
    mkdirSync(path.join(paths.dataRoot, 'control'), { recursive: true });
    // `extraConfig` is for boot-time-only keys such as `allowedHosts`, which the
    // server reads from the file once and never exposes through /api/config.
    writeFileSync(
        paths.configPath,
        JSON.stringify({ ...SEED_CONFIG, webPort: paths.port, ...extraConfig }, null, 4),
        'utf8',
    );
    writeFileSync(path.join(paths.dataRoot, 'control', 'system-install-declined'), '', 'utf8');
}

export interface ServerHandle {
    child: ChildProcess;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    /** Everything the child wrote so far, for failure messages. */
    output(): string;
}

export interface SpawnOptions {
    /**
     * Extra environment for the child, applied after the isolation block. A key
     * set to `undefined` is REMOVED from the child's environment, which is how a
     * row starts without a variable the runner (or the block) would hand it.
     */
    env?: Record<string, string | undefined>;
    /**
     * `false` spawns with no `WS_SCRCPY_WEB_PORT`, not even an inherited one.
     * The override forces the EXACT port and never walks forward, so a row about
     * a busy port being auto-shifted (1.11, 1.12) has to start without it.
     */
    portOverride?: boolean;
}

/**
 * Spawn `node dist/index.js` on a private root: the same env block the fast
 * tier's webServer uses, pointed at that root.
 */
export function spawnServer(paths: PrivateServerPaths, options: SpawnOptions = {}): ServerHandle {
    // The config file lives at the repo root; `config.rootDir` is the test
    // directory, which is not where dist/ is.
    const configFile = test.info().config.configFile;
    const repoRoot = configFile ? path.dirname(configFile) : process.cwd();
    const distIndex = path.resolve(repoRoot, 'dist', 'index.js');
    // Windows env names are case-insensitive, and an inherited `LocalAppData`
    // (or `Temp`) beside our `LOCALAPPDATA` (or `TEMP`) would leave which one the
    // child sees to chance.
    const replaced = new Set(['LOCALAPPDATA', ...Object.keys(E2E_TEMP_ENV)]);
    const env: Record<string, string | undefined> = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !replaced.has(key.toUpperCase())),
    );
    Object.assign(env, {
        PROGRAMDATA: paths.programData,
        DATA_ROOT: paths.dataRoot,
        // The log file and the dependencies folder are keyed on DEPS_PATH,
        // not on DATA_ROOT (Logger.ts, Config.ts): without it a bare server
        // logs to the repo root and, on Linux, hydrates into
        // <repo>/dependencies. The launcher sets both; so does this.
        DEPS_PATH: path.join(paths.dataRoot, 'dependencies'),
        WS_SCRCPY_CONFIG: paths.configPath,
        WS_SCRCPY_WEB_PORT: String(paths.port),
        // On Windows the TLS home is `%LOCALAPPDATA%\WsScrcpyWeb-tls`, outside
        // the data root (certPaths.ts). Inherited, every private server would
        // read the developer's real certificate, bind a real HTTPS listener,
        // and a generate would replace their real CA. Linux keeps the TLS home
        // under the data root and never reads this.
        LOCALAPPDATA: paths.localAppData,
        // A hand-run server (no launcher) booting with firstRunComplete false
        // opens the HOST's default browser on itself (src/server/index.ts,
        // shouldAutoOpenBrowser): every first-run row put a real tab on the
        // developer's desktop. The relaunch suppression is the product's own
        // off switch. A row about the open attempt itself (1.14) removes it
        // through `env`.
        WS_SCRCPY_NO_BROWSER: '1',
        // Boot skips the latest-version lookup for dependencies already
        // installed, as the fast tier's webServer does (playwright.config.ts
        // says why). A fresh private root has nothing installed, so its first
        // boot still looks everything up; a restart on the same root does not
        // spend api.github.com's quota again. A row about the boot lookups
        // themselves removes it through `env`.
        WS_SCRCPY_SKIP_BOOT_LATEST: '1',
        // On Windows the server's own temp folder (a Node.js update extracts
        // there) goes under E2E_TEMP_ROOT too; see paths.ts.
        ...E2E_TEMP_ENV,
    });
    if (options.portOverride === false) delete env['WS_SCRCPY_WEB_PORT'];
    for (const [key, value] of Object.entries(options.env ?? {})) {
        if (value === undefined) delete env[key];
        else env[key] = value;
    }
    mkdirSync(paths.localAppData, { recursive: true });
    const child = spawn(process.execPath, [distIndex], {
        env: env as NodeJS.ProcessEnv,
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

/**
 * Environment keys a developer's shell (or a CI step) could carry that would
 * silently change what a row measures: the port, the scan tuning, the
 * service/docker/launcher detection, the launcher's browser-open request, the
 * remote-admin opt-out and the update feed.
 *
 * Not WS_SCRCPY_NO_BROWSER: `spawnServer` sets that itself, so clearing it
 * here would put the real browser tabs back on the developer's desktop.
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
    'WS_SCRCPY_ALLOW_REMOTE_ADMIN',
    'VELOPACK_FEED_URL',
] as const;

/**
 * `env` for `spawnServer`, with every inherited override removed unless `env`
 * sets it on purpose. For rows whose subject IS one of these variables (12.9
 * sets and clears `PORT` and `SCAN_CONCURRENCY` case by case), where a stray
 * value from the runner would decide the result.
 */
export function withoutInheritedOverrides(
    env: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
    const cleared: Record<string, string | undefined> = {};
    for (const key of INHERITED_OVERRIDES) cleared[key] = undefined;
    return { ...cleared, ...env };
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: () => string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${label()}`)), ms);
    });
    try {
        return await Promise.race([p, timeout]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Poll GET / until 200. A document GET answers 200 in BOTH modes (the shell, or
 * the inline login page); /api/config would be 401 in locked mode. Fails with
 * the child's output if it exits first.
 */
export async function waitForServer(handle: ServerHandle, baseURL: string, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let exitedEarly: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    void handle.exited.then((r) => {
        exitedEarly = r;
    });
    const ctx = await request.newContext({ baseURL });
    try {
        while (Date.now() < deadline) {
            if (exitedEarly) {
                throw new Error(
                    `server exited (code ${exitedEarly.code}, signal ${exitedEarly.signal}) before it was ready:\n${handle.output()}`,
                );
            }
            try {
                const res = await ctx.get('/', { timeout: 2_000 });
                if (res.status() === 200) return;
            } catch {
                // not listening yet
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        throw new Error(`server on ${baseURL} not ready within ${timeoutMs} ms:\n${handle.output()}`);
    } finally {
        await ctx.dispose();
    }
}

/**
 * The dependencies a fresh data root installs AT BOOT, and therefore the only
 * ones it makes sense to wait for.
 *
 * Stated as what this helper REQUIRES, deliberately, rather than as a list of
 * what to skip. A skip list is a copy of `DependencyManager.autoInstallMissing`'s
 * own opt-outs, and a copy of another module's current behaviour is false the
 * moment that module changes -- the failure mode this branch hit five times
 * over in comments. mkcert is the case in point: it is a registered dependency
 * that is fetched on FIRST USE, never at boot, so `installedVersion` stays null
 * for the life of a server that never generates a certificate. Waiting for
 * "every dependency" therefore could not ever succeed once it was added, which
 * is exactly what CI reported -- three rows timing out at 240 s on
 * `nodejs=24.21.0, adb=37.0.1, scrcpy-server=4.1, mkcert=unknown`.
 */
export const BOOT_INSTALLED_DEPENDENCIES = ['nodejs', 'adb', 'scrcpy-server'] as const;

/**
 * The same, for the container image. Node.js and mkcert are not in it, the two
 * `hostOnly` definitions in DependencyDefinitions.ts: the image runs its own
 * interpreter, and a container has no Local HTTPS for mkcert to serve.
 */
export const CONTAINER_BOOT_INSTALLED_DEPENDENCIES = ['adb', 'scrcpy-server'] as const;

/**
 * Wait until every BOOT-INSTALLED dependency (or only `names`) reports an
 * installed version.
 *
 * A fresh data root downloads them at boot; a row that stops the server
 * mid-download would find that abort in the log and blame it on the stop, and
 * a row that drives adb before it lands is answered by a server still fetching
 * it. Such rows wait for this first.
 *
 * `target` is a base URL or a request context. A URL gets a fresh, sessionless
 * context with the instance token minted, which answers in open mode only. In
 * locked mode /api/dependencies needs a signed-in admin, so pass that admin's
 * context; it is used as it is.
 *
 * **Budget it against the caller's `test.setTimeout`, not against nothing.**
 * This waits on a real first-run download (Node + ADB), so on a slow runner it
 * can legitimately take minutes. If the caller's test budget is not comfortably
 * larger than `timeoutMs`, Playwright kills the test before this function can
 * throw, and the failure reads `Test timeout of Nms exceeded` with no clue which
 * dependency stalled — the message below never prints. That is exactly what
 * happened on 2026-09-09, when this default and row 10.3's `test.setTimeout`
 * were both 180_000.
 *
 * The default is deliberately lower than any current caller's test budget.
 */
export async function waitForDependencies(
    target: string | APIRequestContext,
    timeoutMs = 120_000,
    names: readonly string[] = BOOT_INSTALLED_DEPENDENCIES,
): Promise<void> {
    const owned = typeof target === 'string' ? await request.newContext({ baseURL: target }) : undefined;
    const ctx = owned ?? (target as APIRequestContext);
    try {
        if (owned) expect((await owned.get('/')).status(), 'document GET (mints the token)').toBe(200);
        const deadline = Date.now() + timeoutMs;
        let last = '';
        while (Date.now() < deadline) {
            const res = await ctx.get('/api/dependencies');
            if (res.status() === 200) {
                const deps = (await res.json()) as { name: string; installedVersion: string | null; status: string }[];
                const required = deps.filter((d) => names.includes(d.name));
                // A filter is only as good as the names it matches: rename a
                // dependency upstream and `required` silently becomes shorter,
                // `every` over the remainder still returns true, and this
                // function degrades into a no-op that waits for nothing while
                // reporting success. Assert the whole expected set is present
                // so that shows up as a named failure here instead of as a
                // mysterious log-noise failure three rows later.
                expect(
                    required.map((d) => d.name).sort(),
                    'the awaited dependency names must all appear in /api/dependencies',
                ).toEqual([...names].sort());
                if (required.every((d) => d.installedVersion !== null)) return;
                last = required.map((d) => `${d.name}=${d.installedVersion ?? d.status}`).join(', ');
            } else {
                last = `HTTP ${res.status()}`;
            }
            await new Promise((r) => setTimeout(r, 1_000));
        }
        throw new Error(`dependencies not installed within ${timeoutMs} ms: ${last}`);
    } finally {
        await owned?.dispose();
    }
}

/** No-op once exited; otherwise kill (TerminateProcess on Windows, SIGTERM elsewhere) and await the exit. */
export async function stopServer(handle: ServerHandle, timeoutMs = 15_000): Promise<void> {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
    handle.child.kill();
    await withTimeout(handle.exited, timeoutMs, () => `waiting for the private server to exit:\n${handle.output()}`);
}

/** `stopServer` that never throws out of a `finally`: cleanup must not mask the test's own failure. */
export async function stopQuietly(handle: ServerHandle | undefined, label: string): Promise<void> {
    if (!handle) return;
    try {
        await stopServer(handle);
    } catch (err) {
        console.warn(`${label} cleanup: ${String(err)}`);
    }
}

/**
 * Remove a private root whole: the data root and the LOCALAPPDATA beside it.
 *
 * Anything still running FROM the root is stopped first (item 170). On Windows
 * `stopServer` is TerminateProcess, so the server's own shutdown -- which kills
 * the adb daemon it pre-warmed, detached, from `<root>/WsScrcpyWeb/dependencies/adb`
 * -- never runs; the daemon outlives the server and holds adb.exe open. The stop
 * is scoped to executables inside this root, never a developer's adb.
 *
 * Retried (`removeTree`) because Windows can hold the database, or a stopped
 * process's image, a beat after the process is gone. Throws if it still cannot;
 * callers that must not throw catch it, and the next run's
 * `seedPrivateDataRoot` stops and wipes the same way.
 */
export function removePrivateRoot(paths: PrivateServerPaths): void {
    stopProcessesUnder(paths.programData);
    removeTree(paths.programData);
}

/** config.json as the server left it on disk. */
export function readConfigFile(paths: PrivateServerPaths): Record<string, unknown> {
    return JSON.parse(readConfigBytes(paths)) as Record<string, unknown>;
}

/** config.json's exact text, for rows that assert a file was not rewritten at all. */
export function readConfigBytes(paths: PrivateServerPaths): string {
    return readFileSync(paths.configPath, 'utf8');
}

/**
 * The sessions row for a cookie value, read straight from the database: the
 * server stores only sha256(sid) hex. Opened read-only and closed at once so no
 * handle lingers over the WAL sidecars at teardown.
 */
export function sessionRow(dbPath: string, sid: string): { user_id: number } | undefined {
    const tokenHash = createHash('sha256').update(sid).digest('hex');
    let db: DatabaseSync;
    try {
        db = new DatabaseSync(dbPath, { readOnly: true });
    } catch {
        db = new DatabaseSync(dbPath);
    }
    try {
        const row = db.prepare('SELECT user_id FROM sessions WHERE token_hash = ?').get(tokenHash) as
            | { user_id: number }
            | undefined;
        return row;
    } finally {
        db.close();
    }
}
