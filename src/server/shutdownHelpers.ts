// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { execFile } from 'child_process';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Reap any stray adb.exe processes on Windows via taskkill.
 *
 * `adb kill-server` alone leaves stray adb processes when the daemon was
 * spawned detached (escaping the Node job object) or had stuck transports /
 * in-flight forwards. This belt-and-braces taskkill catches those. Non-zero
 * exit (no matching processes) is not an error — swallowed silently.
 *
 * No-op on non-Windows platforms.
 */
export async function reapStrayAdbOnWindows(): Promise<void> {
    if (process.platform !== 'win32') {
        return;
    }
    try {
        await execFileAsync('C:\\Windows\\System32\\taskkill.exe', ['/F', '/IM', 'adb.exe', '/T'], { timeout: 5_000 });
    } catch {
        // taskkill exits non-zero when no matching process; treat as success.
    }
}
