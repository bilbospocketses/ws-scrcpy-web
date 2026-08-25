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
 * `fs.writeFileSync`, but atomic and immune to a hidden/read-only
 * destination. Creates missing parent directories.
 */
export function writeFileAtomicSync(
    dest: string,
    data: string | NodeJS.ArrayBufferView,
    options?: fs.WriteFileOptions,
): void {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = tempSibling(dest);
    try {
        if (options === undefined) {
            fs.writeFileSync(tmp, data);
        } else {
            fs.writeFileSync(tmp, data, options);
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
        fs.copyFileSync(src, tmp);
        fs.renameSync(tmp, dest);
    } catch (err) {
        discard(tmp);
        throw err;
    }
}
