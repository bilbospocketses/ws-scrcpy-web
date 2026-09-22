import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Crash-safe, attribute-safe replacements for `fs.writeFileSync` /
 * `fs.copyFileSync` when writing over a path the app manages.
 *
 * **Why this exists.** On Windows, `CreateFile(CREATE_ALWAYS)` and
 * `CopyFileEx` both refuse when the destination already exists and carries
 * `FILE_ATTRIBUTE_HIDDEN` (or `FILE_ATTRIBUTE_READONLY`). Node surfaces that
 * as `EPERM: operation not permitted`. Every file under a real install's
 * `dependencies/` tree was found carrying the hidden attribute, which broke
 * the dependency updater outright — it could not overwrite its own binaries —
 * and silently broke the node-pty manifest refresh on every single boot.
 * Nothing in this codebase sets that attribute, so the fix has to be
 * defensive: the writes must work regardless of how the destination got
 * marked.
 *
 * **How it works.** Write to a sibling temp file in the same directory, then
 * `rename` it over the destination. `MoveFileEx` carries no such restriction,
 * so the write lands. Three properties fall out of that, all of them wanted:
 *
 *  1. It succeeds against a hidden or read-only destination.
 *  2. It is atomic — a reader sees either the whole old file or the whole new
 *     one, never a half-written one, even if the process dies mid-write.
 *  3. The replacement inherits the temp file's attributes, so a stale hidden
 *     flag is cleared as a side effect and the condition self-heals.
 *
 * The temp file is a same-directory sibling deliberately: `rename` across
 * volumes fails, so it must not live in the system temp dir.
 *
 * The one thing rename does NOT give you for free is permissions — it installs
 * a new inode, which would otherwise adopt the writing process's umask. What
 * "correct" means there differs between the two functions, because the calls
 * they replace differ, so each is matched to its own original:
 *
 *  - `writeFileAtomicSync` re-applies an existing destination's mode.
 *    `fs.writeFileSync` truncates in place and keeps it.
 *  - `copyFileAtomicSync` keeps the SOURCE's mode. `fs.copyFileSync` does not
 *    preserve the destination's — libuv fchmods it to match the source.
 *
 * Both behaviours were measured on Linux, not assumed. Note also that `rename`
 * needs write permission on the directory rather than on the file, so on POSIX
 * these can replace a read-only destination where `fs.writeFileSync` raises
 * EACCES.
 *
 * **A SECOND EPERM cause, which temp-then-rename does NOT fix (item 140).**
 * Everything above is about a destination whose ATTRIBUTES refuse the write.
 * Windows reports a completely different condition with the same errno: a
 * rename fails `EPERM` while any other process holds an open handle on the
 * source or the destination, which on a developer or end-user machine is
 * routinely a real-time malware scanner that opened the temp file microseconds
 * after we created it. Renaming cannot help, because renaming is the operation
 * being refused. The only remedy is to wait for the handle to close and try
 * again, so every rename here goes through a bounded retry.
 *
 * Measured 2026-09-22: on a quiet machine the full test suite passed 17 runs
 * out of 17; with the CPU pinned at 100% it failed 1 run in 3, always as
 * `EPERM ... rename` out of one of these three functions, and a different
 * caller each time. Load does not cause the bug, it widens the window the
 * scanner already had. That is also why it read as flaky tests for weeks
 * rather than as the production defect it is: `Config.saveToDisk` and the
 * dependency installer run through here, so a user's config save can fail the
 * same way on a machine with an aggressive scanner.
 */

/**
 * Error codes worth retrying. All three mean "someone else is touching this
 * file right now" on Windows; `EBUSY` and `EACCES` are the other two shapes
 * the same sharing violation surfaces as, depending on which handle collided.
 * A code outside this set is a real failure and must surface immediately --
 * retrying `ENOENT` would only delay the error by the whole budget.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Backoff in milliseconds. Six attempts over ~315 ms total, front-loaded
 * because a scanner's handle is usually gone within a few milliseconds and the
 * long tail only matters when the machine is starved. Deliberately bounded: a
 * genuine permission error must still fail, and fail quickly enough that a
 * caller waiting on a config save notices nothing.
 */
const RENAME_BACKOFF_MS = [5, 10, 20, 60, 100, 120];

function isTransient(err: unknown): boolean {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return code !== undefined && TRANSIENT_RENAME_CODES.has(code);
}

/**
 * Block the calling thread for `ms`. `Atomics.wait` rather than a spin loop:
 * the synchronous callers here are already synchronous by contract, and
 * burning CPU while waiting for a scanner to release a handle would fight the
 * very contention that opened the window.
 */
function sleepSync(ms: number): void {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * The rename each helper performs, injectable so the retry policy can be
 * driven deterministically. Losing a real race with a scanner on demand is not
 * something a test can do; injecting the failure it produces is. Defaulted, so
 * every production caller is unaffected -- the same shape `Config`'s own
 * `readFile` parameter uses.
 */
export type RenameSyncImpl = (from: string, to: string) => void;
export type RenameImpl = (from: string, to: string) => Promise<void>;

/** `fs.renameSync` with a bounded retry on a transient sharing violation. */
function renameSyncWithRetry(tmp: string, dest: string, rename: RenameSyncImpl): void {
    for (let attempt = 0; ; attempt += 1) {
        try {
            rename(tmp, dest);
            return;
        } catch (err) {
            if (attempt >= RENAME_BACKOFF_MS.length || !isTransient(err)) {
                throw err;
            }
            sleepSync(RENAME_BACKOFF_MS[attempt] as number);
        }
    }
}

/** The `fs.promises.rename` twin, same budget, without blocking the loop. */
async function renameWithRetry(tmp: string, dest: string, rename: RenameImpl): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
        try {
            await rename(tmp, dest);
            return;
        } catch (err) {
            if (attempt >= RENAME_BACKOFF_MS.length || !isTransient(err)) {
                throw err;
            }
            const delay = RENAME_BACKOFF_MS[attempt] as number;
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}

let sequence = 0;

/** Same-directory sibling path, unique per process and per call. */
function tempSibling(dest: string): string {
    sequence += 1;
    return path.join(path.dirname(dest), `.${path.basename(dest)}.tmp-${process.pid}-${sequence}`);
}

function discard(tmp: string): void {
    try {
        fs.rmSync(tmp, { force: true });
    } catch {
        // Best-effort: the original failure is what the caller needs to see.
    }
}

/**
 * Permission bits of an existing destination, or undefined when there is
 * nothing there yet.
 *
 * Replacing by rename creates a NEW inode, so without this the replacement
 * would take the writing process's umask rather than inheriting what it
 * replaced. `fs.writeFileSync` / `fs.copyFileSync` keep the destination inode
 * and therefore its mode, so preserving it is what makes these true drop-in
 * substitutes. Barely observable on Windows, where mode is only the read-only
 * bit; it matters on POSIX for anything mode-sensitive — a system-scope
 * `config.json`, for one.
 */
function existingMode(dest: string): number | undefined {
    try {
        return fs.statSync(dest).mode & 0o777;
    } catch {
        return undefined;
    }
}

/** An explicit mode from the caller is intent, and outranks preservation. */
function hasExplicitMode(options?: fs.WriteFileOptions): boolean {
    return typeof options === 'object' && options !== null && options.mode !== undefined;
}

/**
 * `fs.writeFileSync`, but atomic and immune to a hidden/read-only
 * destination. Creates missing parent directories.
 */
export function writeFileAtomicSync(
    dest: string,
    data: string | NodeJS.ArrayBufferView,
    options?: fs.WriteFileOptions,
    rename: RenameSyncImpl = fs.renameSync,
): void {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const preserved = hasExplicitMode(options) ? undefined : existingMode(dest);
    const tmp = tempSibling(dest);
    try {
        if (options === undefined) {
            fs.writeFileSync(tmp, data);
        } else {
            fs.writeFileSync(tmp, data, options);
        }
        // Applied before the rename, so the destination is never briefly visible
        // with the wrong permissions.
        if (preserved !== undefined) {
            fs.chmodSync(tmp, preserved);
        }
        renameSyncWithRetry(tmp, dest, rename);
    } catch (err) {
        discard(tmp);
        throw err;
    }
}

/**
 * `fs.copyFileSync`, but atomic and immune to a hidden/read-only
 * destination. Creates missing parent directories.
 */
export function copyFileAtomicSync(src: string, dest: string, rename: RenameSyncImpl = fs.renameSync): void {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = tempSibling(dest);
    try {
        // No mode preservation here, deliberately, and it is the opposite of
        // writeFileAtomicSync. `fs.copyFileSync` onto an existing file does not
        // keep that file's mode — libuv fchmods the destination to match the
        // source — so the SOURCE mode is the drop-in behaviour. `copyFileSync`
        // into the fresh temp already gives us exactly that. Verified rather
        // than assumed: copying a 0755 source over a 0600 destination leaves
        // 0755 on Linux.
        fs.copyFileSync(src, tmp);
        renameSyncWithRetry(tmp, dest, rename);
    } catch (err) {
        discard(tmp);
        throw err;
    }
}

/**
 * `copyFileAtomicSync` for a caller that must not hold the event loop: the
 * first-run dependency install copies the extracted Node tree — ~2,500 files,
 * ~110 MB — while the server is answering requests, and done synchronously
 * that parked every one of them behind it (a 4-second `/api/config` measured
 * on a fast NVMe box; past 10 s on a CI runner). Same temp-then-rename
 * contract, same source-mode semantics, every step through `fs.promises` so
 * the loop turns between them.
 */
export async function copyFileAtomic(
    src: string,
    dest: string,
    rename: RenameImpl = fs.promises.rename,
): Promise<void> {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const tmp = tempSibling(dest);
    try {
        await fs.promises.copyFile(src, tmp);
        await renameWithRetry(tmp, dest, rename);
    } catch (err) {
        await fs.promises.rm(tmp, { force: true }).catch(() => {
            // Best-effort: the original failure is what the caller needs to see.
        });
        throw err;
    }
}
