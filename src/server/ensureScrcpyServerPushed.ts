// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { statSync } from 'fs';
import { DEVICE_SERVER_PATH } from '../common/Constants';
import type { AdbClient } from './AdbClient';

/**
 * Push scrcpy-server.jar to the device only when the remote copy is missing
 * or has a different size.
 *
 * Why this matters: Android runs dexopt on a JAR's first load to precompile
 * classes into an .odex alongside the jar. Repeated loads of the same file
 * skip dexopt — a 15-20s speedup on older devices like SM-T550. But an `adb
 * push` of a freshly-rebuilt file changes its mtime/content and invalidates
 * the dex cache. Keeping the remote copy in place between sessions preserves
 * the warm cache.
 *
 * We gate on size (via `wc -c`) rather than a hash to keep the check cheap.
 * If ws-scrcpy-web is rebuilt with a newer scrcpy-server binary, the size
 * changes, we push — which is what we want.
 */
export async function ensureScrcpyServerPushed(adbClient: AdbClient, serial: string, localPath: string): Promise<void> {
    const expectedSize = statSync(localPath).size;
    try {
        const out = await adbClient.shell(serial, `wc -c < ${DEVICE_SERVER_PATH} 2>/dev/null`);
        const remoteSize = Number.parseInt(out.trim(), 10);
        if (remoteSize === expectedSize) {
            return;
        }
    } catch {
        // Remote file absent or shell failed — fall through and push.
    }
    await adbClient.push(serial, localPath, DEVICE_SERVER_PATH);
}
