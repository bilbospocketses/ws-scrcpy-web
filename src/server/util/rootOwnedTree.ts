import fs from 'fs';
import path from 'path';

/** The slice of `fs.promises` this module uses; injectable for tests. */
export interface RootTreeFs {
    lstat(
        p: string,
    ): Promise<{ uid: number; gid: number; mode: number; isSymbolicLink(): boolean; isDirectory(): boolean }>;
    readdir(p: string): Promise<string[]>;
    lchown(p: string, uid: number, gid: number): Promise<void>;
    chmod(p: string, mode: number): Promise<void>;
}

const realFs: RootTreeFs = {
    lstat: (p) => fs.promises.lstat(p),
    readdir: (p) => fs.promises.readdir(p),
    lchown: (p, u, g) => fs.promises.lchown(p, u, g),
    chmod: (p, m) => fs.promises.chmod(p, m),
};

/** What makes one entry not exclusively root's, or null. Pure. Symlinks' own mode bits are meaningless (always 0777 on Linux), so only their owner counts. */
export function rootTreeProblem(st: {
    uid: number;
    gid: number;
    mode: number;
    isSymbolicLink(): boolean;
}): string | null {
    if (st.uid !== 0 || st.gid !== 0) return 'not owned by root:root';
    if (!st.isSymbolicLink() && (st.mode & 0o022) !== 0) return 'group- or other-writable';
    return null;
}

async function walk(root: string, fsi: RootTreeFs, visit: (p: string) => Promise<void>): Promise<void> {
    const stack = [root];
    while (stack.length > 0) {
        const p = stack.pop()!;
        await visit(p);
        const st = await fsi.lstat(p);
        if (!st.isSymbolicLink() && st.isDirectory()) {
            // POSIX joins: this only ever runs as root on Linux (see ensureRootOwnedTreeIfRoot).
            for (const name of await fsi.readdir(p)) stack.push(path.posix.join(p, name));
        }
    }
}

/**
 * Make every entry under `root` owned by root:root and not group/other-writable,
 * then check that it took; throw naming the first entry that still is not. Never
 * follows a symlink: its owner is set with lchown and its target is left alone.
 * Returns how many entries were changed.
 */
export async function repairRootOwnedTree(root: string, fsi: RootTreeFs = realFs): Promise<number> {
    let changed = 0;
    await walk(root, fsi, async (p) => {
        const st = await fsi.lstat(p);
        let touched = false;
        if (st.uid !== 0 || st.gid !== 0) {
            await fsi.lchown(p, 0, 0);
            touched = true;
        }
        if (!st.isSymbolicLink() && (st.mode & 0o022) !== 0) {
            await fsi.chmod(p, st.mode & 0o7755);
            touched = true;
        }
        if (touched) changed++;
    });
    await walk(root, fsi, async (p) => {
        const problem = rootTreeProblem(await fsi.lstat(p));
        if (problem) {
            throw new Error(`refusing to install a dependency tree root does not own exclusively: ${p} is ${problem}`);
        }
    });
    return changed;
}

/**
 * D16: when THIS process is root on Linux (the system service), a dependency
 * tree it is about to run must be root's alone -- repair it, and fail loudly if
 * the repair did not take. A no-op for any other user and on Windows, where the
 * tree belongs to the user who runs it by design.
 */
export async function ensureRootOwnedTreeIfRoot(
    root: string,
    opts: { getuid?: () => number; platform?: NodeJS.Platform; fsi?: RootTreeFs } = {},
): Promise<number> {
    const platform = opts.platform ?? process.platform;
    if (platform === 'win32') return 0;
    const uid = (opts.getuid ?? process.getuid)?.();
    if (uid !== 0) return 0;
    return repairRootOwnedTree(root, opts.fsi ?? realFs);
}
