import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

/**
 * A throwaway data root for the end-to-end server.
 *
 * Deterministic rather than a random `mkdtemp` name on purpose: the Playwright
 * config and each spec worker import this module in a SEPARATE process, so a random
 * path would hand each of them a different directory and the file assertions would
 * read a config the server never wrote.
 *
 * The server resolves its data root per platform — `PROGRAMDATA/WsScrcpyWeb` on
 * Windows when `DATA_ROOT` is unset, and `DATA_ROOT` ahead of it on every
 * platform (see `resolveDataRoot` in `src/server/Config.ts`) —
 * so the suite sets both and works either way.
 */
export const E2E_PROGRAM_DATA = path.join(tmpdir(), 'ws-scrcpy-web-e2e');
export const E2E_DATA_ROOT = path.join(E2E_PROGRAM_DATA, 'WsScrcpyWeb');
export const E2E_CONFIG_PATH = path.join(E2E_DATA_ROOT, 'config.json');

/**
 * The per-user store the server opens beside config.json. Name mirrors
 * DB_FILENAME in `src/server/db/constants.ts`; copied rather than imported to
 * keep server modules out of the test process.
 */
export const E2E_DB_PATH = path.join(E2E_DATA_ROOT, 'wsscrcpy.db');

/**
 * Remove the e2e database and its sidecars so every RUN boots a fresh install.
 *
 * The auth specs depend on it: the first-user lockdown renames user 1 and gives
 * it a password hash, and nothing in the API ever takes that back — a second
 * lockdown is refused outright, and returning to open mode keeps the hash. A
 * database carried over from an earlier run therefore makes the next run's
 * "secure the admin account" take the normal-create branch and never enable
 * login; a run that died while locked makes global-setup's PATCH fail with 401
 * before a single spec runs. The WAL sidecars go with the main file (a stale
 * WAL beside a new database is undefined territory) and `.bak` keeps the
 * fixture hermetic.
 *
 * Pure node on purpose: playwright.config.ts imports it at config-load time,
 * which is the only hook that precedes `webServer`.
 */
export function wipeE2EDatabase(): void {
    for (const file of [E2E_DB_PATH, `${E2E_DB_PATH}-wal`, `${E2E_DB_PATH}-shm`, `${E2E_DB_PATH}.bak`]) {
        rmSync(file, { force: true });
    }
}

/**
 * Deliberately not 8000 — that is where a developer's real instance listens, and
 * binding there would either collide with it or silently drive it.
 */
export const E2E_PORT = 8123;
export const E2E_BASE_URL = `http://localhost:${E2E_PORT}`;

/**
 * The state every run starts from.
 *
 * `installMode`, `webPort` and `firstRunComplete` are here so the consent specs can
 * prove an approval preserves keys it has no business touching. That is not
 * hypothetical: `webPort` shares this file, so a rewrite rather than an amend would
 * move the running server to a different port.
 */
export const SEED_CONFIG = {
    installMode: 'user',
    webPort: E2E_PORT,
    firstRunComplete: true,
    frameAncestors: [] as string[],
};
