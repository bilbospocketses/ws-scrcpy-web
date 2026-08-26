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
 */

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
        fs.renameSync(tmp, dest);
    } catch (err) {
        discard(tmp);
        throw err;
    }
}

/**
 * `fs.copyFileSync`, but atomic and immune to a hidden/read-only
 * destination. Creates missing parent directories.
 */
export function copyFileAtomicSync(src: string, dest: string): void {
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
        fs.renameSync(tmp, dest);
    } catch (err) {
        discard(tmp);
        throw err;
    }
}
