import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const CONTROL_DIR = 'control';
export const UNINSTALL_HANDOFF_FILENAME = 'uninstall-handoff.json';

export interface UninstallHandoffMarkerInput {
    targetSessionId: number | null;
    launcherPath: string;
    launcherArgs: string[];
}

export type WriteMarkerResult = { ok: true } | { ok: false; errorMessage: string };

/**
 * Write the uninstall-handoff marker atomically under
 * `<dataRoot>/control/uninstall-handoff.json`. Tray helpers in matching
 * sessions detect the marker, spawn the launcher, and delete the marker.
 */
export async function writeUninstallHandoffMarker(
    dataRoot: string,
    input: UninstallHandoffMarkerInput,
): Promise<WriteMarkerResult> {
    const dir = join(dataRoot, CONTROL_DIR);
    const finalPath = join(dir, UNINSTALL_HANDOFF_FILENAME);
    const tmpPath = `${finalPath}.tmp`;
    const body = JSON.stringify(
        {
            verb: 'uninstall-service',
            targetSessionId: input.targetSessionId,
            launcherPath: input.launcherPath,
            launcherArgs: input.launcherArgs,
            writtenAt: new Date().toISOString(),
        },
        null,
        2,
    );
    try {
        await mkdir(dir, { recursive: true });
        await writeFile(tmpPath, body, 'utf8');
        await rename(tmpPath, finalPath);
        return { ok: true };
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return { ok: false, errorMessage: message };
    }
}
