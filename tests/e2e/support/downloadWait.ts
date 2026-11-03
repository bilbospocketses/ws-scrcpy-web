import { type Dirent, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { dockerCli, dockerExecRoot } from './dockerStack';
import { E2E_TEMP_ROOT } from './paths';
import { WAIT_MS } from './timeouts';

/**
 * Waits on a dependency download, bounded by NO PROGRESS and never by total time.
 *
 * The server's own status cannot carry this: a dependency reads `updating`, with
 * `installedVersion` null, for the whole of its download, extract and verify
 * (src/server/DependencyManager.ts), and nothing on the wire counts bytes. So a
 * wait that watched only the dependency list failed a slow download as stalled
 * while its bytes were still arriving. Progress here is the list OR the bytes on
 * disk changing; only when neither moves for the stall window does it fail, as
 * HUNG.
 */

/** One reading of the bytes a download has on disk, or null where this run has no view of them. */
export type ProgressProbe = () => string | null;

/** The scratch directory each download and extract runs in (src/server/DependencyManager.ts makeUpdateTmpDir). */
const UPDATE_DIR_PREFIX = 'ws-scrcpy-web-update-';

/**
 * The stall window when only the dependency status can be watched (an external
 * stack, where no byte view exists). Long, because one dependency's whole
 * download then looks like no progress at all.
 */
export const STATUS_ONLY_STALL_MS = 10 * 60_000;

/**
 * For a test that waits on a download: no total-time limit, so the no-progress
 * watch in `waitForDownloads` is the test's only bound. Every other wait in the
 * test keeps its own hang guard.
 */
export function noTotalTimeLimit(): void {
    test.setTimeout(0);
}

function addTree(dir: string, total: { files: number; bytes: number }): void {
    let entries: Dirent[];
    try {
        entries = readdirSync(dir, { withFileTypes: true });
    } catch {
        return; // removed while being read: the install finished with it
    }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            addTree(full, total);
        } else {
            try {
                total.bytes += statSync(full).size;
                total.files += 1;
            } catch {
                // removed between the listing and the stat
            }
        }
    }
}

/**
 * The bytes in every local server's download scratch directories. Every server
 * this suite spawns, the shared one included, has E2E_TEMP_ROOT as its
 * `os.tmpdir()` (paths.ts), which is where those directories are made.
 */
export function localDownloadProgress(): ProgressProbe {
    return () => {
        let entries: Dirent[];
        try {
            entries = readdirSync(E2E_TEMP_ROOT, { withFileTypes: true });
        } catch {
            return null;
        }
        const total = { files: 0, bytes: 0 };
        for (const e of entries) {
            if (e.isDirectory() && e.name.startsWith(UPDATE_DIR_PREFIX))
                addTree(path.join(E2E_TEMP_ROOT, e.name), total);
        }
        return `${total.files} files, ${total.bytes} bytes in update scratch dirs`;
    };
}

const DU = 'du -sk /tmp /data 2>/dev/null; true';

/** The bytes under a named container's temp directory and data volume, through `docker exec`. */
export function containerDownloadProgress(container: string): ProgressProbe {
    return () => {
        try {
            return dockerExecRoot(container, DU).trim();
        } catch {
            return null;
        }
    };
}

/**
 * The same for the docker tier's own compose service. None under an external
 * stack (QA_EXTERNAL_STACK): qa-harness's runner has no docker CLI, so there the
 * wait falls back to watching the status alone.
 */
export function composeServiceDownloadProgress(service = 'ws-scrcpy-web'): ProgressProbe {
    if (process.env['QA_EXTERNAL_STACK'] === '1') return () => null;
    return () => {
        try {
            return dockerCli(['compose', 'exec', '-T', '-u', '0', service, 'sh', '-c', DU]).trim();
        } catch {
            return null;
        }
    };
}

/**
 * `fetch` and its whole body, bounded by NO PROGRESS: it fails as HUNG only when
 * no response, or no further body bytes, arrive for `stallMs`. A slow mirror is
 * only slow.
 */
export async function fetchWatched(url: string, stallMs = WAIT_MS): Promise<{ status: number; body: Buffer }> {
    const controller = new AbortController();
    let stalled = false;
    let timer: NodeJS.Timeout | undefined;
    const progress = (): void => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            stalled = true;
            controller.abort();
        }, stallMs);
    };
    progress();
    try {
        const res = await fetch(url, { signal: controller.signal });
        const chunks: Uint8Array[] = [];
        const reader = res.body?.getReader();
        for (;;) {
            progress();
            const chunk = await reader?.read();
            if (!chunk || chunk.done) break;
            chunks.push(chunk.value);
        }
        return { status: res.status, body: Buffer.concat(chunks) };
    } catch (err) {
        if (stalled) throw new Error(`HUNG: nothing arrived from ${url} for ${stallMs / 1000} s`, { cause: err });
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

export interface DownloadWait {
    /** What is being waited for, for the HUNG text. */
    what: string;
    /** One read of the dependency list: done, or a summary of where it stands. */
    read: () => Promise<{ done: boolean; summary: string }>;
    progress: ProgressProbe;
    /** The stall window while the bytes on disk are watched. */
    stallMs?: number;
}

/** Poll `read` until done; fail as HUNG only when neither it nor the bytes on disk change for the stall window. */
export async function waitForDownloads(wait: DownloadWait): Promise<void> {
    const stallMs = wait.stallMs ?? WAIT_MS;
    let bytes: string | null = null;
    let seen: string | undefined;
    let changedAt = Date.now();
    for (;;) {
        const { done, summary } = await wait.read();
        if (done) return;
        const reading = wait.progress();
        if (reading !== null) bytes = reading;
        const key = `${summary}\n${bytes ?? ''}`;
        if (key !== seen) {
            seen = key;
            changedAt = Date.now();
        } else {
            const window = bytes !== null ? stallMs : STATUS_ONLY_STALL_MS;
            if (Date.now() - changedAt > window) {
                throw new Error(
                    bytes !== null
                        ? `HUNG: ${wait.what}: neither the dependency list nor the bytes on disk changed for ` +
                              `${window / 1000} s. Dependencies: ${summary}. On disk: ${bytes}`
                        : `HUNG: ${wait.what}: the dependency status did not change for ${window / 1000} s. Only the ` +
                              'status was watched: this run has no view of the bytes on disk, so a download still ' +
                              `running would read as stalled too. Dependencies: ${summary}`,
                );
            }
        }
        await new Promise((r) => setTimeout(r, 1_000));
    }
}
