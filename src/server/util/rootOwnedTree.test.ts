import { describe, expect, it } from 'vitest';
import { ensureRootOwnedTreeIfRoot, type RootTreeFs, repairRootOwnedTree, rootTreeProblem } from './rootOwnedTree';
import { TAR_SAFE_EXTRACT_FLAGS, tarExtractArgs } from './tarExtract';

type Node = { uid: number; gid: number; mode: number; kind: 'dir' | 'file' | 'link'; children?: string[] };

/** An in-memory tree; lchown/chmod mutate it unless `stuck` says the change does not take. */
function fakeTree(nodes: Record<string, Node>, stuck = false) {
    const calls: string[] = [];
    const fsi: RootTreeFs = {
        lstat: async (p) => {
            const n = nodes[p];
            if (!n) throw new Error(`ENOENT ${p}`);
            return {
                uid: n.uid,
                gid: n.gid,
                mode: n.mode,
                isSymbolicLink: () => n.kind === 'link',
                isDirectory: () => n.kind === 'dir',
            };
        },
        readdir: async (p) => nodes[p]?.children ?? [],
        lchown: async (p, u, g) => {
            calls.push(`lchown ${p} ${u}:${g}`);
            if (!stuck) Object.assign(nodes[p]!, { uid: u, gid: g });
        },
        chmod: async (p, m) => {
            calls.push(`chmod ${p} ${m.toString(8)}`);
            if (!stuck) nodes[p]!.mode = m;
        },
    };
    return { fsi, calls, nodes };
}

// The measured beta.147 shape: dirs root-owned, files the tarball's uid 1001.
function nodeTree(): Record<string, Node> {
    return {
        '/d/node': { uid: 0, gid: 0, mode: 0o40755, kind: 'dir', children: ['bin', 'README.md'] },
        '/d/node/README.md': { uid: 1001, gid: 1001, mode: 0o100644, kind: 'file' },
        '/d/node/bin': { uid: 0, gid: 0, mode: 0o40775, kind: 'dir', children: ['node', 'npm'] },
        '/d/node/bin/node': { uid: 1001, gid: 1001, mode: 0o100755, kind: 'file' },
        '/d/node/bin/npm': { uid: 1001, gid: 1001, mode: 0o120777, kind: 'link' },
    };
}

describe('D16: dependency tarballs never keep the archive owners', () => {
    it('both extraction flags are always passed, before any caller extras', () => {
        expect(TAR_SAFE_EXTRACT_FLAGS).toEqual(['--no-same-owner', '--no-same-permissions']);
        expect(tarExtractArgs('/tmp/node.tar.gz', ['-C', '/tmp/x'])).toEqual([
            '-xzf',
            '/tmp/node.tar.gz',
            '--no-same-owner',
            '--no-same-permissions',
            '-C',
            '/tmp/x',
        ]);
        expect(tarExtractArgs('pty.tar.gz', ['--strip-components=1'])).toContain('--no-same-owner');
    });
});

describe('repairRootOwnedTree', () => {
    it('re-owns the measured beta.147 tree to root:root and drops group write, symlink modes untouched', async () => {
        const { fsi, calls, nodes } = fakeTree(nodeTree());
        const changed = await repairRootOwnedTree('/d/node', fsi);
        expect(changed).toBe(4); // README.md, bin (g+w), node, npm
        expect(calls).toContain('lchown /d/node/bin/node 0:0');
        expect(calls).toContain('lchown /d/node/bin/npm 0:0');
        expect(calls).toContain('chmod /d/node/bin 755'); // permission bits only; g-w dropped
        // A symlink's own 0777 is meaningless and must not be chmod'ed (that would follow it).
        expect(calls.some((c) => c.startsWith('chmod /d/node/bin/npm'))).toBe(false);
        for (const n of Object.values(nodes)) expect(n.uid === 0 && n.gid === 0).toBe(true);
    });

    it('leaves an already-clean tree alone', async () => {
        const clean: Record<string, Node> = {
            '/d/x': { uid: 0, gid: 0, mode: 0o40755, kind: 'dir', children: ['f'] },
            '/d/x/f': { uid: 0, gid: 0, mode: 0o100644, kind: 'file' },
        };
        const { fsi, calls } = fakeTree(clean);
        expect(await repairRootOwnedTree('/d/x', fsi)).toBe(0);
        expect(calls).toEqual([]);
    });

    it('fails loudly, naming the entry, when a repair does not take', async () => {
        const { fsi } = fakeTree(nodeTree(), true);
        await expect(repairRootOwnedTree('/d/node', fsi)).rejects.toThrow(
            /refusing to install .*not owned by root:root/,
        );
    });

    it('rootTreeProblem: owner applies to everything, mode only to non-symlinks', () => {
        const st = (uid: number, mode: number, link = false) => ({ uid, gid: uid, mode, isSymbolicLink: () => link });
        expect(rootTreeProblem(st(0, 0o100755))).toBeNull();
        expect(rootTreeProblem(st(0, 0o120777, true))).toBeNull();
        expect(rootTreeProblem(st(1001, 0o120777, true))).toMatch(/root:root/);
        expect(rootTreeProblem(st(0, 0o100775))).toMatch(/writable/);
    });
});

describe('ensureRootOwnedTreeIfRoot', () => {
    it('does nothing for a non-root user or on Windows', async () => {
        for (const opts of [
            { getuid: () => 1000, platform: 'linux' as const },
            { getuid: () => 0, platform: 'win32' as const },
        ]) {
            const { fsi, calls } = fakeTree(nodeTree());
            expect(await ensureRootOwnedTreeIfRoot('/d/node', { ...opts, fsi })).toBe(0);
            expect(calls).toEqual([]);
        }
    });
    it('repairs as root on Linux', async () => {
        const { fsi } = fakeTree(nodeTree());
        expect(await ensureRootOwnedTreeIfRoot('/d/node', { getuid: () => 0, platform: 'linux', fsi })).toBe(4);
    });
});
