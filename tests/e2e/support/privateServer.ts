import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, request, test } from '@playwright/test';
import { SEED_CONFIG } from './paths';

/**
 * A spec-owned server for the one row that must restart one (18.12).
 *
 * The fast tier's webServer is a bare `node dist/index.js` with no supervisor:
 * POST /api/dependencies/restart exits the process with code 75 and nothing
 * brings it back, so calling it on the shared 8123 server would end the suite.
 * 18.12 therefore spawns its own process on its own port and data root, kills
 * it the product's way, and spawns it again.
 *
 * Kept apart from auth.ts so the child_process and node:sqlite imports stay out
 * of the other rows, which can then never reach the spawn API by accident.
 *
 * The child is `process.execPath` — the runner's own interpreter, exactly what
 * playwright.config.ts's `node dist/index.js` resolves to. That is the settled
 * CI-runner exception to Local-Dependencies-Only (the interpreter that runs the
 * suite is its execution environment, not an app dependency); surfaced here for
 * the record, not vendored.
 */

export interface PrivateServerPaths {
    programData: string;
    dataRoot: string;
    configPath: string;
    dbPath: string;
    restartMarkerPath: string;
    port: number;
    baseURL: string;
}

/**
 * `<tmpdir>/<name>` as PROGRAMDATA and `<that>/WsScrcpyWeb` as DATA_ROOT — the
 * server resolves its root from PROGRAMDATA on Windows and DATA_ROOT elsewhere,
 * so both are set to name the same directory. The database and the restart
 * marker live beside config.json.
 */
export function privateServerPaths(name: string, port: number): PrivateServerPaths {
    const programData = path.join(tmpdir(), name);
    const dataRoot = path.join(programData, 'WsScrcpyWeb');
    return {
        programData,
        dataRoot,
        configPath: path.join(dataRoot, 'config.json'),
        dbPath: path.join(dataRoot, 'wsscrcpy.db'),
        restartMarkerPath: path.join(dataRoot, '.restart'),
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
    rmSync(paths.programData, { recursive: true, force: true });
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

/** The same env block the fast tier's webServer uses, pointed at the private root. */
export function spawnServer(paths: PrivateServerPaths): ServerHandle {
    // The config file lives at the repo root; `config.rootDir` is the test
    // directory, which is not where dist/ is.
    const configFile = test.info().config.configFile;
    const repoRoot = configFile ? path.dirname(configFile) : process.cwd();
    const distIndex = path.resolve(repoRoot, 'dist', 'index.js');
    const child = spawn(process.execPath, [distIndex], {
        env: {
            ...process.env,
            PROGRAMDATA: paths.programData,
            DATA_ROOT: paths.dataRoot,
            // The log file and the dependencies folder are keyed on DEPS_PATH,
            // not on DATA_ROOT (Logger.ts, Config.ts): without it a bare server
            // logs to the repo root and, on Linux, hydrates into
            // <repo>/dependencies. The launcher sets both; so does this.
            DEPS_PATH: path.join(paths.dataRoot, 'dependencies'),
            WS_SCRCPY_CONFIG: paths.configPath,
            WS_SCRCPY_WEB_PORT: String(paths.port),
        },
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
 * Wait until the server's first-run install has landed every dependency.
 *
 * A fresh data root downloads adb, scrcpy-server and node-pty at boot; a row
 * that stops the server mid-download would find that abort in the log and
 * blame it on the stop. Rows that read the log wait for this first.
 */
export async function waitForDependencies(baseURL: string, timeoutMs = 180_000): Promise<void> {
    const ctx = await request.newContext({ baseURL });
    try {
        expect((await ctx.get('/')).status(), 'document GET (mints the token)').toBe(200);
        const deadline = Date.now() + timeoutMs;
        let last = '';
        while (Date.now() < deadline) {
            const res = await ctx.get('/api/dependencies');
            if (res.status() === 200) {
                const deps = (await res.json()) as { name: string; installedVersion: string | null; status: string }[];
                if (deps.every((d) => d.installedVersion !== null)) return;
                last = deps.map((d) => `${d.name}=${d.installedVersion ?? d.status}`).join(', ');
            }
            await new Promise((r) => setTimeout(r, 1_000));
        }
        throw new Error(`dependencies not installed within ${timeoutMs} ms: ${last}`);
    } finally {
        await ctx.dispose();
    }
}

/** No-op once exited; otherwise kill (TerminateProcess on Windows, SIGTERM elsewhere) and await the exit. */
export async function stopServer(handle: ServerHandle, timeoutMs = 15_000): Promise<void> {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) return;
    handle.child.kill();
    await withTimeout(handle.exited, timeoutMs, () => `waiting for the private server to exit:\n${handle.output()}`);
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
