import * as fs from 'fs';
import * as path from 'path';
import { SERVER_JAR_SHA256, SERVER_VERSION } from '../common/Constants';
import { writeFileAtomicSync } from './util/atomicFile';
import { sha256FileSync } from './verifySha256';

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
 * What a marker-less jar was identified as, per jar path, and the file
 * identity it was identified from. A replaced jar (an atomic rename) has a new
 * inode, mtime or size, so it is hashed again; an unchanged one never is.
 */
const identifiedJars = new Map<string, { ino: number; size: number; mtimeMs: number; version: string | null }>();

/**
 * The version whose pinned hash the marker-less jar at `jar` matches, or null
 * when it matches none, is absent or cannot be read. Hashed at most once per
 * change to the file (see `identifiedJars`).
 */
function identifyMarkerlessJar(jar: string): string | null {
    let stat: fs.Stats;
    try {
        stat = fs.statSync(jar);
    } catch {
        return null;
    }
    const seen = identifiedJars.get(jar);
    if (seen && seen.ino === stat.ino && seen.size === stat.size && seen.mtimeMs === stat.mtimeMs) {
        return seen.version;
    }
    let version: string | null = null;
    try {
        version = scrcpyServerVersionForSha256(sha256FileSync(jar));
    } catch {
        version = null;
    }
    identifiedJars.set(jar, { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, version });
    return version;
}

/**
 * Reads the actual installed scrcpy-server version from the on-disk
 * marker at <deps>/scrcpy-server/.version. With no marker, the jar is
 * identified by its SHA-256 against SERVER_JAR_SHA256; only a jar that is
 * absent, unreadable or matches no pin falls back to the bundled
 * SERVER_VERSION constant.
 *
 * The marker is written by DependencyManager.installScrcpyServer after
 * a successful updater download, and by the seed promote. A jar an earlier
 * build seed-promoted WITHOUT a marker is given one at boot, before any probe
 * or stream can start, by DependencyManager.repairScrcpyServerVersionMarker.
 * The hash lookup here covers the case where that marker could not be
 * written (2026-10-08): answering SERVER_VERSION for a pinned 4.1 jar would
 * start it as "5.0", which the server refuses.
 *
 * Deliberately cheap and synchronous: it runs on every probe and stream. A
 * marker is one small read; a marker-less jar is hashed once and then
 * remembered until the file changes.
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
    return (
        readScrcpyServerVersionMarker(depsPath) ??
        identifyMarkerlessJar(path.join(depsPath, 'scrcpy-server', 'scrcpy-server')) ??
        SERVER_VERSION
    );
}

/**
 * Deletes <deps>/scrcpy-server/.version. Called BEFORE a jar is copied in, so
 * a crash between the copy and the new marker leaves a marker-less jar --
 * which the boot repair identifies by its hash -- rather than a new jar under
 * the old jar's marker, which nothing would ever question. Throws when the
 * marker exists and cannot be removed, so the caller does not copy.
 */
export function removeScrcpyServerVersionMarker(depsPath: string): void {
    fs.rmSync(path.join(depsPath, 'scrcpy-server', VERSION_MARKER), { force: true });
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
