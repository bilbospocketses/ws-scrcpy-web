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

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Whether the server behind `baseURL` (or, with none given, the server a wait
 * is about) is one this run spawned on this machine, so its download scratch
 * directories are visible here. Not under an external stack, not in the docker
 * tier (its loopback server is a container), and not for a remote URL.
 */
export function serverIsLocal(baseURL?: string): boolean {
    if (process.env['QA_EXTERNAL_STACK'] === '1') return false;
    let configFile = '';
    try {
        configFile = test.info().config.configFile ?? '';
    } catch {
        // Outside a test: no tier to read, so the URL alone decides.
    }
    if (path.basename(configFile) === 'playwright.docker.config.ts') return false;
    if (baseURL === undefined) return true;
    try {
        return LOOPBACK_HOSTS.has(new URL(baseURL).hostname);
    } catch {
        return false;
    }
}

/**
 * The bytes in every local server's download scratch directories. Every server
 * this suite spawns, the shared one included, has E2E_TEMP_ROOT as its
 * `os.tmpdir()` (paths.ts), which is where those directories are made.
 *
 * None where the server is not local (`serverIsLocal`): the directories seen
 * here would be some other server's, so the wait falls back to watching the
 * status alone, with the long status-only window, and says so.
 *
 * Only directories that can still be live are read. A server stopped
 * mid-download (TerminateProcess on Windows) leaves its directory behind, and
 * they pile up: one development box held 560 of them, 234,608 files and 34 GiB,
 * and reading them all took 45 s per poll. So a directory last written over
 * SCRATCH_LOOKBACK_MS ago is never read, and one unchanged for
 * SCRATCH_DEAD_AFTER_MS (longer than any stall window, so a paused download
 * cannot be dropped while its wait still watches it) is read no more; its last
 * reading stays in the total, so dropping it is not mistaken for progress.
 */
export function localDownloadProgress(baseURL?: string, root = E2E_TEMP_ROOT): ProgressProbe {
    if (!serverIsLocal(baseURL)) return () => null;
    const watched = new Map<string, { reading: string; files: number; bytes: number; since: number }>();
    const frozen = new Set<string>();
    return () => {
        let entries: Dirent[];
        try {
            entries = readdirSync(root, { withFileTypes: true });
        } catch {
            return null;
        }
        const now = Date.now();
        const total = { files: 0, bytes: 0 };
        for (const e of entries) {
            if (!e.isDirectory() || !e.name.startsWith(UPDATE_DIR_PREFIX)) continue;
            const dir = path.join(root, e.name);
            const last = watched.get(dir);
            if (!frozen.has(dir)) {
                if (last === undefined) {
                    let mtimeMs: number;
                    try {
                        mtimeMs = statSync(dir).mtimeMs;
                    } catch {
                        continue; // removed between the listing and the stat
                    }
                    if (now - mtimeMs > SCRATCH_LOOKBACK_MS) {
                        frozen.add(dir); // a leftover: contributes nothing, ever
                        continue;
                    }
                }
                const tree = { files: 0, bytes: 0 };
                addTree(dir, tree);
                const reading = `${tree.files}/${tree.bytes}`;
                if (last === undefined || last.reading !== reading) {
                    watched.set(dir, { reading, ...tree, since: now });
                } else if (now - last.since > SCRATCH_DEAD_AFTER_MS) {
                    frozen.add(dir);
                }
            }
            const counted = watched.get(dir);
            if (counted) {
                total.files += counted.files;
                total.bytes += counted.bytes;
            }
        }
        return `${total.files} files, ${total.bytes} bytes in update scratch dirs`;
    };
}

/** An update scratch directory last written longer ago than this is a leftover, never read. */
const SCRATCH_LOOKBACK_MS = 24 * 60 * 60_000;
/** A scratch directory unchanged for this long is read no more (longer than any stall window). */
const SCRATCH_DEAD_AFTER_MS = 2 * STATUS_ONLY_STALL_MS;

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
    /**
     * False when `read` reports no dependency status, only whether a reply has
     * come (`whileDownloading` with no `status`): the HUNG text then names only
     * what was watched.
     */
    statusWatched?: boolean;
}

function hungText(wait: DownloadWait, window: number, summary: string, bytes: string | null): string {
    const s = window / 1000;
    if (wait.statusWatched === false) {
        return bytes !== null
            ? `HUNG: ${wait.what}: no reply, and the bytes on disk did not change for ${s} s. On disk: ${bytes}`
            : `HUNG: ${wait.what}: no reply for ${s} s. Nothing else was watched: this run has no view of the ` +
                  "bytes on disk and the server's status was not read, so a download still running would read " +
                  'as stalled too.';
    }
    return bytes !== null
        ? `HUNG: ${wait.what}: neither the dependency list nor the bytes on disk changed for ${s} s. ` +
              `Dependencies: ${summary}. On disk: ${bytes}`
        : `HUNG: ${wait.what}: the dependency status did not change for ${s} s. Only the status was watched: this ` +
              'run has no view of the bytes on disk, so a download still running would read as stalled too. ' +
              `Dependencies: ${summary}`;
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
            if (Date.now() - changedAt > window) throw new Error(hungText(wait, window, summary, bytes));
        }
        await new Promise((r) => setTimeout(r, 1_000));
    }
}

export interface ReplyWait {
    /** What is being waited for, for the HUNG text. */
    what: string;
    progress: ProgressProbe;
    /** A summary of the server's dependency status, watched as progress too. */
    status?: () => Promise<string>;
    stallMs?: number;
}

/**
 * Await `reply`, the answer to a request the server sends only once a download
 * has finished (the request itself is made with `timeout: 0`), while the
 * no-progress watch runs beside it. The reply wins as soon as it arrives; the
 * wait fails as HUNG only when neither the bytes on disk nor the status change
 * for the stall window.
 */
export async function whileDownloading<T>(reply: Promise<T>, wait: ReplyWait): Promise<T> {
    let settled = false;
    const tracked = reply.finally(() => {
        settled = true;
    });
    // If the watch fails first the reply is abandoned; its later rejection
    // (the page closing under it) must not surface as an unhandled one.
    tracked.catch(() => {});
    const watch = waitForDownloads({
        what: wait.what,
        progress: wait.progress,
        ...(wait.stallMs === undefined ? {} : { stallMs: wait.stallMs }),
        statusWatched: wait.status !== undefined,
        read: async () => {
            if (settled) return { done: true, summary: '' };
            if (!wait.status) return { done: false, summary: 'waiting for the reply' };
            try {
                return { done: false, summary: await wait.status() };
            } catch (err) {
                // An unreadable status is not progress; the reply still decides.
                return { done: false, summary: `status unreadable: ${(err as Error)?.message ?? String(err)}` };
            }
        },
    });
    const [answer] = await Promise.all([tracked, watch]);
    return answer;
}
