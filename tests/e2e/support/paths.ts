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
 * Windows, `DATA_ROOT` elsewhere (see `resolveDataRoot` in `src/server/Config.ts`) —
 * so the suite sets both and works either way.
 */
export const E2E_PROGRAM_DATA = path.join(tmpdir(), 'ws-scrcpy-web-e2e');
export const E2E_DATA_ROOT = path.join(E2E_PROGRAM_DATA, 'WsScrcpyWeb');
export const E2E_CONFIG_PATH = path.join(E2E_DATA_ROOT, 'config.json');

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
