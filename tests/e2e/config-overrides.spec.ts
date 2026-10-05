import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from '@playwright/test';
import {
    countOccurrences,
    holdPort,
    isListening,
    json,
    NOTHING_SERVES,
    placeCertificate,
    raw,
    readLog,
    release,
    spawnServerWith,
    stopQuietly,
    tokenCookieFor,
} from './support/batchA';
import { SEED_CONFIG } from './support/paths';
import {
    type PrivateServerPaths,
    privateServerPaths,
    type ServerHandle,
    seedPrivateDataRoot,
    waitForDependencies,
    waitForServer,
    withTimeout,
} from './support/privateServer';

/**
 * Item 164, batch A: rows 10.14 (a hand-edited config.json is validated) and
 * 12.9 (environment and config overrides). Every case is a boot, so every case
 * runs a server of its own, on 8158 (config.json's webPort) and 8159 (the
 * override, or the Local HTTPS port), one at a time.
 */

const CONFIG_PORT = 8158;
const OTHER_PORT = 8159;
const HTTPS_COLLISION = (port: number) =>
    `config.json: httpsPort (${port}) collides with the http port (${port}); HTTPS is disabled for this boot`;

interface Envelope {
    config: { webPort: number; updateCheckIntervalMinutes: number };
    runtime: { webPort: number; portWasAutoShifted: boolean; frameAncestors: string[] };
}

async function envelope(port: number): Promise<Envelope> {
    const res = await raw({ port, path: '/api/config', headers: { host: `localhost:${port}` } });
    expect(res.status, res.body).toBe(200);
    return json(res) as Envelope;
}

interface TlsState {
    httpsPort: number;
    httpsListener: { bound: boolean; port?: number; reason?: string };
}

async function tlsState(port: number): Promise<TlsState> {
    const cookie = await tokenCookieFor(port);
    const res = await raw({ port, path: '/api/tls/state', headers: { host: `localhost:${port}`, cookie } });
    expect(res.status, res.body).toBe(200);
    return json(res) as TlsState;
}

/** Rewrite config.json whole: the seed, this server's port, and the case's keys. */
function writeConfig(paths: PrivateServerPaths, extra: Record<string, unknown>): void {
    writeFileSync(paths.configPath, JSON.stringify({ ...SEED_CONFIG, webPort: paths.port, ...extra }, null, 4), 'utf8');
}

function configFile(paths: PrivateServerPaths): Record<string, unknown> {
    return JSON.parse(readFileSync(paths.configPath, 'utf8')) as Record<string, unknown>;
}

/** The WARN lines the config loader wrote about one key. */
function configWarnings(paths: PrivateServerPaths, key: string): string[] {
    return readLog(paths)
        .split(/\r?\n/)
        .filter((l) => l.includes('[Config] WARN') && l.includes(`config.json: ${key}`));
}

/** GET / over HTTPS, trusting exactly the throwaway certificate. */
function httpsStatus(port: number, ca: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = https.get({ host: 'localhost', port, path: '/', ca, timeout: 5_000 }, (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', reject);
    });
}

/** Boot one private server, run `body` against it, and always stop it. */
async function withServer(
    paths: PrivateServerPaths,
    env: Record<string, string | undefined>,
    servedOn: number,
    body: (handle: ServerHandle) => Promise<void>,
): Promise<void> {
    const handle = spawnServerWith(paths, env);
    try {
        await waitForServer(handle, `http://localhost:${servedOn}`);
        await body(handle);
    } finally {
        await stopQuietly(handle, path.basename(paths.programData));
    }
}

test.describe('config.json validation and overrides (smoke 10.14, 12.9)', () => {
    test('10.14 frameAncestors: only the http(s) origin is accepted, with one WARN per rejected entry', async () => {
        test.setTimeout(120_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-cfg-frame', CONFIG_PORT);
        seedPrivateDataRoot(paths, {
            frameAncestors: ['*', 'http://a.test/x', 'ftp://b.test', 'http://localhost:5159'],
        });
        await withServer(paths, {}, paths.port, async () => {
            const warns = configWarnings(paths, 'frameAncestors');
            expect(warns, warns.join('\n')).toHaveLength(3);
            expect(warns[0]).toContain('frameAncestors "*" would allow any site to frame the app; skipping');
            expect(warns[1]).toContain(
                'frameAncestors entry "http://a.test/x" must be an http(s) origin only (no path); skipping',
            );
            expect(warns[2]).toContain(
                'frameAncestors entry "ftp://b.test" must be an http(s) origin only (no path); skipping',
            );
            expect(warns.join('\n')).not.toContain('localhost:5159');
            expect((await envelope(paths.port)).runtime.frameAncestors).toEqual(['http://localhost:5159']);
        });
    });

    test('10.14 httpsPort 70000: a warning and the default port', async () => {
        test.setTimeout(120_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-cfg-https-range', CONFIG_PORT);
        seedPrivateDataRoot(paths, { httpsPort: 70000 });
        await withServer(paths, {}, paths.port, async () => {
            expect(configWarnings(paths, 'httpsPort')).toEqual([
                expect.stringContaining(
                    'config.json: httpsPort must be an integer between 1 and 65535; using default 8443',
                ),
            ]);
            expect((await tlsState(paths.port)).httpsPort).toBe(8443);
        });
    });

    test('10.14 httpsPort equal to webPort: with no certificate nothing to disable and no warning; with one, HTTPS is off for the boot with a warning', async () => {
        test.setTimeout(180_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-cfg-https-collide', CONFIG_PORT);

        // No certificate: there is no HTTPS listener to drop, so nothing is said.
        seedPrivateDataRoot(paths, { httpsPort: CONFIG_PORT });
        await withServer(paths, {}, paths.port, async () => {
            expect(readLog(paths)).not.toContain('collides with the http port');
            const state = await tlsState(paths.port);
            expect(state.httpsPort).toBe(CONFIG_PORT);
            expect(state.httpsListener.bound).toBe(false);
        });

        // Control: the same certificate on its own port is served, so the
        // placement below is the one the boot really reads.
        seedPrivateDataRoot(paths, { httpsPort: OTHER_PORT });
        const pair = placeCertificate(paths);
        await withServer(paths, {}, paths.port, async () => {
            expect((await tlsState(paths.port)).httpsListener).toEqual({ bound: true, port: OTHER_PORT });
            expect(await httpsStatus(OTHER_PORT, pair.cert)).toBe(200);
        });

        // With the certificate: HTTP keeps the port, HTTPS is off for this boot.
        seedPrivateDataRoot(paths, { httpsPort: CONFIG_PORT });
        placeCertificate(paths);
        await withServer(paths, {}, paths.port, async () => {
            expect(countOccurrences(readLog(paths), HTTPS_COLLISION(CONFIG_PORT))).toBe(1);
            expect((await tlsState(paths.port)).httpsListener).toEqual({ bound: false, reason: 'port-collision' });
            expect((await envelope(paths.port)).runtime.webPort).toBe(CONFIG_PORT);
        });
    });

    test('10.14 a server[] array: /api/tls/state reports config-override', async () => {
        test.setTimeout(120_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-cfg-server-array', CONFIG_PORT);
        seedPrivateDataRoot(paths, { server: [{ secure: false, port: CONFIG_PORT }] });
        await withServer(paths, {}, paths.port, async () => {
            expect((await tlsState(paths.port)).httpsListener).toEqual({ bound: false, reason: 'config-override' });
        });
    });

    test('12.9 scanConcurrency above the file-descriptor budget is clamped to 512 with a WARN', async () => {
        test.setTimeout(120_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-scan-clamp', CONFIG_PORT);
        seedPrivateDataRoot(paths, { scanConcurrency: 100000 });
        await withServer(paths, {}, paths.port, async () => {
            expect(readLog(paths)).toContain(
                '[Config] WARN scanConcurrency 100000 exceeds the file-descriptor budget; using 512',
            );
        });
    });

    test('12.9 a scan* key set in the environment, the store and config.json resolves environment > store > file > default', async () => {
        test.setTimeout(240_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-scan-precedence', CONFIG_PORT);
        // Every value is above the budget on purpose: the clamp WARN names the
        // value that won BEFORE clamping, which makes the winner observable.
        const ENV = 700001;
        const STORE = 700002;
        const FILE = 700003;
        const clampLine = (n: number) => `scanConcurrency ${n} exceeds the file-descriptor budget`;
        const boot = async (env: Record<string, string | undefined>, expectWinner: number | null) => {
            const before = readLog(paths).length;
            await withServer(paths, env, paths.port, async () => {
                const lines = readLog(paths).slice(before);
                for (const n of [ENV, STORE, FILE]) {
                    if (n === expectWinner) expect(lines).toContain(clampLine(n));
                    else expect(lines).not.toContain(clampLine(n));
                }
                if (expectWinner === null) expect(lines).not.toContain('exceeds the file-descriptor budget');
            });
        };

        // config.json alone: the file beats the default. This boot also creates
        // the store the next step writes into.
        seedPrivateDataRoot(paths, { scanConcurrency: FILE });
        await boot({}, FILE);

        // The store's value goes straight into app_settings, with the server
        // stopped. No route writes a scan* key: PATCH /api/config answers 400
        // `unknown config key: scanConcurrency` (it accepts only AppConfig's
        // defaulted keys), so the store column of this precedence is reachable
        // only by an existing row — which is exactly what Config.getInstance reads.
        const sqlite = new DatabaseSync(paths.dbPath);
        try {
            sqlite
                .prepare(
                    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
                )
                .run('scanConcurrency', JSON.stringify(STORE));
        } finally {
            sqlite.close();
        }

        // All three set at once: the environment wins; without it, the store.
        expect(configFile(paths)['scanConcurrency'], 'the file still carries its value').toBe(FILE);
        await boot({ SCAN_CONCURRENCY: String(ENV) }, ENV);
        await boot({}, STORE);

        // Neither the store nor the file: the default, which is inside the budget.
        const clear = new DatabaseSync(paths.dbPath);
        try {
            clear.prepare('DELETE FROM app_settings WHERE key = ?').run('scanConcurrency');
        } finally {
            clear.close();
        }
        writeConfig(paths, {});
        await boot({}, null);
    });

    test('12.9 an update setting saved in Settings beats a config.json that disagrees', async () => {
        test.setTimeout(180_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-update-setting', CONFIG_PORT);
        seedPrivateDataRoot(paths, { updateCheckIntervalMinutes: 120 });
        await withServer(paths, {}, paths.port, async () => {
            // With nothing stored the file's value is the one in force.
            expect((await envelope(paths.port)).config.updateCheckIntervalMinutes).toBe(120);
            const cookie = await tokenCookieFor(paths.port);
            const save = await raw({
                port: paths.port,
                path: '/api/updates/config',
                method: 'PATCH',
                headers: { host: `localhost:${paths.port}`, cookie },
                body: { updateCheckIntervalMinutes: 360 },
            });
            expect(save.status, save.body).toBe(200);
        });
        writeConfig(paths, { updateCheckIntervalMinutes: 120 });
        expect(configFile(paths)['updateCheckIntervalMinutes']).toBe(120);
        await withServer(paths, {}, paths.port, async () => {
            expect((await envelope(paths.port)).config.updateCheckIntervalMinutes).toBe(360);
        });
    });

    test('12.9 adbPath in config.json is logged with its source; without it the bundled path is', async () => {
        test.setTimeout(180_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-adb-path', CONFIG_PORT);
        const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
        const custom = path.join(paths.programData, 'custom-adb', exe);
        seedPrivateDataRoot(paths, { adbPath: custom });
        await withServer(paths, {}, paths.port, async () => {
            expect(readLog(paths)).toContain(`[Config] adbPath=${custom} (source=config)`);
        });
        seedPrivateDataRoot(paths);
        await withServer(paths, {}, paths.port, async () => {
            const bundled = path.join(paths.dataRoot, 'dependencies', 'adb', exe);
            expect(readLog(paths)).toContain(`[Config] adbPath=${bundled} (source=bundled)`);
        });
    });

    test('12.9 DEPS_PATH inherited from the shell is honoured over config.json; without it dependencies land in config.json dependenciesPath', async () => {
        // Two genuine first-run installs (Node, adb, scrcpy-server), each inside
        // a 240 s wait; the budget must stay comfortably above both.
        test.setTimeout(600_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-deps-path', CONFIG_PORT);
        const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';
        const fromEnv = path.join(paths.programData, 'deps-from-env');
        const fromFile = path.join(paths.programData, 'deps-from-config');

        seedPrivateDataRoot(paths, { dependenciesPath: fromFile });
        await withServer(paths, { DEPS_PATH: fromEnv }, paths.port, async () => {
            await waitForDependencies(paths.baseURL, 240_000);
            expect(existsSync(path.join(fromEnv, 'adb', exe)), `adb under DEPS_PATH ${fromEnv}`).toBe(true);
            expect(existsSync(path.join(fromFile, 'adb', exe)), 'nothing under config.json dependenciesPath').toBe(
                false,
            );
        });

        seedPrivateDataRoot(paths, { dependenciesPath: fromFile });
        await withServer(paths, { DEPS_PATH: undefined }, paths.port, async () => {
            await waitForDependencies(paths.baseURL, 240_000);
            expect(existsSync(path.join(fromFile, 'adb', exe)), `adb under dependenciesPath ${fromFile}`).toBe(true);
            // dependenciesPath has no log line of its own (the row's point): only
            // where the files land says it was read.
            expect(readLog(paths)).not.toMatch(/dependenciesPath=/);
        });
    });

    test('12.9 WS_SCRCPY_CONFIG pointing at another file: that file is read, and the store opens beside it', async () => {
        test.setTimeout(120_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-alt-config', CONFIG_PORT);
        seedPrivateDataRoot(paths); // the default config.json: nothing allowed to frame
        const altDir = path.join(paths.programData, 'alt');
        const alt = path.join(altDir, 'alt-config.json');
        mkdirSync(altDir, { recursive: true });
        writeFileSync(
            alt,
            JSON.stringify({ ...SEED_CONFIG, webPort: paths.port, frameAncestors: ['http://localhost:5160'] }, null, 4),
            'utf8',
        );
        await withServer(paths, { WS_SCRCPY_CONFIG: alt }, paths.port, async () => {
            expect((await envelope(paths.port)).runtime.frameAncestors).toEqual(['http://localhost:5160']);
            await expect.poll(() => existsSync(path.join(altDir, 'wsscrcpy.db'))).toBe(true);
            expect(existsSync(paths.dbPath), 'no store beside the config.json that was not named').toBe(false);
        });
    });

    test('12.9 PORT is not read: the server listens on config.json webPort', async () => {
        test.setTimeout(120_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-port-env', CONFIG_PORT);
        seedPrivateDataRoot(paths);
        await withServer(paths, { WS_SCRCPY_WEB_PORT: undefined, PORT: String(OTHER_PORT) }, CONFIG_PORT, async () => {
            expect(await isListening(OTHER_PORT)).toBe(false);
            const env = await envelope(CONFIG_PORT);
            expect(env.runtime.webPort).toBe(CONFIG_PORT);
            expect(env.runtime.portWasAutoShifted).toBe(false);
        });
    });

    test('12.9 WS_SCRCPY_WEB_PORT on a free port that differs from config.json: listened on, reported and written as chosen, not shifted', async ({
        browser,
    }) => {
        test.setTimeout(120_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-override-free', CONFIG_PORT);
        seedPrivateDataRoot(paths);
        expect(configFile(paths)['webPort']).toBe(CONFIG_PORT);
        await withServer(paths, { WS_SCRCPY_WEB_PORT: String(OTHER_PORT) }, OTHER_PORT, async () => {
            expect(await isListening(CONFIG_PORT), `nothing on config.json's ${CONFIG_PORT}`).toBe(false);
            const env = await envelope(OTHER_PORT);
            expect(env.runtime.webPort).toBe(OTHER_PORT);
            expect(env.config.webPort).toBe(OTHER_PORT);
            expect(env.runtime.portWasAutoShifted).toBe(false);
            expect(configFile(paths)['webPort']).toBe(OTHER_PORT);
            // The browser URL the page shows is the override's.
            const context = await browser.newContext({ baseURL: `http://localhost:${OTHER_PORT}` });
            try {
                const page = await context.newPage();
                await page.goto('/');
                await expect(page.locator('.bookmark-reminder a')).toHaveText(`http://localhost:${OTHER_PORT}`);
            } finally {
                await context.close();
            }
        });
    });

    test('12.9 WS_SCRCPY_WEB_PORT on a busy port does not walk forward and does not fall back to config.json: the process exits non-zero', async () => {
        test.setTimeout(150_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-override-busy', CONFIG_PORT);
        seedPrivateDataRoot(paths);
        const blocker = await holdPort(OTHER_PORT);
        const handle = spawnServerWith(paths, { WS_SCRCPY_WEB_PORT: String(OTHER_PORT) });
        // Watch config.json's port for the whole life of the process: it must
        // never serve there instead.
        let configPortServed = false;
        let watching = true;
        const watcher = (async () => {
            while (watching) {
                if (await isListening(CONFIG_PORT)) configPortServed = true;
                await new Promise((r) => setTimeout(r, 100));
            }
        })();
        try {
            const exit = await withTimeout(handle.exited, 120_000, () => `waiting for the exit:\n${handle.output()}`);
            expect(exit.code, handle.output()).not.toBe(0);
            expect(exit.code).toBe(1);
            const log = readLog(paths);
            expect(log).toContain(
                `WS_SCRCPY_WEB_PORT ${OTHER_PORT} is busy; not walking forward (the override is exact)`,
            );
            expect(log).toContain(`HTTP listener on port ${OTHER_PORT} failed to bind (EADDRINUSE)`);
            expect(log).toContain(NOTHING_SERVES);
            expect(configFile(paths)['webPort'], 'a busy override is never persisted').toBe(CONFIG_PORT);
        } finally {
            watching = false;
            await watcher;
            await stopQuietly(handle, '12.9 busy override');
            await release(blocker);
        }
        expect(configPortServed, `config.json's port ${CONFIG_PORT} was never served`).toBe(false);
    });

    test('12.9 WS_SCRCPY_WEB_PORT set to the Local HTTPS port: HTTP takes it and HTTPS is disabled for the boot with the collision warning', async () => {
        test.setTimeout(120_000);
        const paths = privateServerPaths('ws-scrcpy-web-e2e-164a-override-https', CONFIG_PORT);
        seedPrivateDataRoot(paths, { httpsPort: OTHER_PORT });
        placeCertificate(paths);
        await withServer(paths, { WS_SCRCPY_WEB_PORT: String(OTHER_PORT) }, OTHER_PORT, async () => {
            expect(countOccurrences(readLog(paths), HTTPS_COLLISION(OTHER_PORT))).toBe(1);
            // Plain HTTP answers on the HTTPS port (waitForServer already got a 200 there).
            const env = await envelope(OTHER_PORT);
            expect(env.runtime.webPort).toBe(OTHER_PORT);
            expect((await tlsState(OTHER_PORT)).httpsListener.bound).toBe(false);
            expect(await isListening(CONFIG_PORT)).toBe(false);
        });
    });
});
