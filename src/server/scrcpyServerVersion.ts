// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';
import { SERVER_VERSION } from '../common/Constants';

const VERSION_MARKER = '.version';

/**
 * Reads the actual installed scrcpy-server version from the on-disk
 * marker at <deps>/scrcpy-server/.version, falling back to the bundled
 * SERVER_VERSION constant when the marker is absent or empty.
 *
 * The marker is written by DependencyManager.installScrcpyServer after
 * a successful updater download. Pre-marker installs (legacy seed
 * promotions) do not have a marker; for those, SERVER_VERSION is the
 * accurate value because the seed binary is bundled at build time and
 * always matches the constant.
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
    const marker = path.join(depsPath, 'scrcpy-server', VERSION_MARKER);
    try {
        const raw = fs.readFileSync(marker, 'utf8').trim();
        if (raw) return raw;
    } catch {
        // Marker absent — fall through to bundled-seed fallback.
    }
    return SERVER_VERSION;
}

/**
 * Persists the installed scrcpy-server version to the on-disk marker.
 * Called after a successful updater install in
 * DependencyManager.installScrcpyServer. Idempotent — overwrites any
 * existing marker.
 */
export function writeInstalledScrcpyServerVersion(depsPath: string, version: string): void {
    const dir = path.join(depsPath, 'scrcpy-server');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, VERSION_MARKER), version, 'utf8');
}
