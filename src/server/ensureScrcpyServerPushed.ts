import { statSync } from 'fs';
import { DEVICE_SERVER_PATH } from '../common/Constants';
import type { AdbClient } from './AdbClient';
import { shArg } from './security/deviceInput';
import { sha256FileSync } from './verifySha256';

/**
 * The local jar's SHA-256, per path, and the file identity it was computed
 * from: hashed once per change to the file, not once per probe or stream.
 */
const localHashes = new Map<string, { ino: number; size: number; mtimeMs: number; sha256: string }>();

function localSha256(localPath: string, stat: { ino: number; size: number; mtimeMs: number }): string {
    const seen = localHashes.get(localPath);
    if (seen && seen.ino === stat.ino && seen.size === stat.size && seen.mtimeMs === stat.mtimeMs) {
        return seen.sha256;
    }
    const sha256 = sha256FileSync(localPath);
    localHashes.set(localPath, { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, sha256 });
    return sha256;
}

/**
 * The one device shell call: the remote jar's SHA-256 line, then its byte size.
 * Both commands share the group's stderr redirect, so a device without
 * `sha256sum` prints only the size, and a missing jar prints nothing.
 */
export function remoteJarCheckCommand(remotePath: string = DEVICE_SERVER_PATH): string {
    const p = shArg(remotePath);
    return `{ sha256sum ${p}; wc -c < ${p}; } 2>/dev/null`;
}

/**
 * Push scrcpy-server.jar to the device only when the remote copy is missing
 * or differs from the local jar.
 *
 * Why this matters: Android runs dexopt on a JAR's first load to precompile
 * classes into an .odex alongside the jar. Repeated loads of the same file
 * skip dexopt — a 15-20s speedup on older devices like SM-T550. But an `adb
 * push` of a freshly-rebuilt file changes its mtime/content and invalidates
 * the dex cache. Keeping the remote copy in place between sessions preserves
 * the warm cache.
 *
 * Compared by content (2026-10-08): the device's `sha256sum` (toybox has it
 * on modern Android) against the local jar's hash, both read in one shell call.
 * This used to compare byte sizes alone, so a new server the same size as the
 * old one would never have been pushed and the old one would have run under
 * the new version string. A device without `sha256sum` still gets the size
 * check, which is what it had before.
 */
export async function ensureScrcpyServerPushed(adbClient: AdbClient, serial: string, localPath: string): Promise<void> {
    const stat = statSync(localPath);
    try {
        const out = await adbClient.shell(serial, remoteJarCheckCommand());
        const lines = out
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
        const hashLine = lines.map((l) => /^([0-9a-fA-F]{64})(\s|$)/.exec(l)).find((m) => m !== null);
        if (hashLine) {
            if (hashLine[1]!.toLowerCase() === localSha256(localPath, stat)) {
                return;
            }
        } else {
            const sizeLine = lines.find((l) => /^\d+$/.test(l));
            if (sizeLine !== undefined && Number.parseInt(sizeLine, 10) === stat.size) {
                return;
            }
        }
    } catch {
        // Remote file absent or shell failed — fall through and push.
    }
    await adbClient.push(serial, localPath, DEVICE_SERVER_PATH);
}
