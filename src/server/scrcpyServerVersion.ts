import * as fs from 'fs';
import * as path from 'path';
import { SERVER_JAR_SHA256, SERVER_VERSION } from '../common/Constants';
import { writeFileAtomicSync } from './util/atomicFile';

const VERSION_MARKER = '.version';

/**
 * The version recorded in <deps>/scrcpy-server/.version, or null when the
 * marker is absent, unreadable or empty. `getInstalledScrcpyServerVersion`
 * falls back on a null; `DependencyManager.repairScrcpyServerVersionMarker`
 * acts on one.
 */
export function readScrcpyServerVersionMarker(depsPath: string): string | null {
    const marker = path.join(depsPath, 'scrcpy-server', VERSION_MARKER);
    try {
        const raw = fs.readFileSync(marker, 'utf8').trim();
        return raw ? raw : null;
    } catch {
        return null;
    }
}

/**
 * Reads the actual installed scrcpy-server version from the on-disk
 * marker at <deps>/scrcpy-server/.version, falling back to the bundled
 * SERVER_VERSION constant when the marker is absent or empty.
 *
 * The marker is written by DependencyManager.installScrcpyServer after
 * a successful updater download, and by the seed promote. A jar an earlier
 * build seed-promoted WITHOUT a marker is given one at boot, before any probe
 * or stream can start, by DependencyManager.repairScrcpyServerVersionMarker:
 * the fallback here used to be what answered for it, and after a
 * SERVER_VERSION bump it named a version that jar is not.
 *
 * Deliberately a cheap synchronous read: it runs on every probe and stream.
 *
 * Used by:
 *  - DependencyDefinitions.scrcpy-server.checkInstalled — for the UI's
 *    "Installed" column. Pre-fix this returned SERVER_VERSION
 *    unconditionally, causing the post-update "Update available" loop
 *    when the on-disk binary was actually newer.
 *  - DeviceProbe / ScrcpyConnection — as the version arg to
 *    `app_process / com.genymobile.scrcpy.Server <version> ...`.
 *    scrcpy validates this against the JAR; passing a stale constant
 *    against an updated JAR causes silent connection failures.
 */
export function getInstalledScrcpyServerVersion(depsPath: string): string {
    return readScrcpyServerVersionMarker(depsPath) ?? SERVER_VERSION;
}

/**
 * The version whose pinned jar hash (SERVER_JAR_SHA256) is `sha256`, or null
 * when no pin matches. Own keys only, compared case-insensitively.
 */
export function scrcpyServerVersionForSha256(sha256: string): string | null {
    const wanted = sha256.toLowerCase();
    for (const [version, pinned] of Object.entries(SERVER_JAR_SHA256)) {
        if (pinned.toLowerCase() === wanted) return version;
    }
    return null;
}

/**
 * Persists the installed scrcpy-server version to the on-disk marker.
 * Called after a successful updater install in
 * DependencyManager.installScrcpyServer, after a seed promote, and by the
 * boot-time marker repair. Idempotent — overwrites any existing marker.
 */
export function writeInstalledScrcpyServerVersion(depsPath: string, version: string): void {
    const dir = path.join(depsPath, 'scrcpy-server');
    fs.mkdirSync(dir, { recursive: true });
    writeFileAtomicSync(path.join(dir, VERSION_MARKER), version, 'utf8');
}
