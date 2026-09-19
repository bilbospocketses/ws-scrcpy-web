import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDependencyDefinitions, mkcertExeName } from '../../DependencyDefinitions';

vi.mock('../../Config', () => ({
    Config: { getInstance: vi.fn() },
}));

vi.mock('../../DependencyManager', () => ({
    getDependencyManager: vi.fn(),
}));

import { Config } from '../../Config';
import { getDependencyManager } from '../../DependencyManager';
import {
    ensureCaRootDirSync,
    ensureMkcertInstalled,
    removeCaRootFiles,
    removeLeafFiles,
    resolveMkcertExe,
} from '../createCertService';

// Partial mock: existsSync/chmodSync become spy-able while still delegating
// to the real implementation, so every other test in this file (which use
// the real fs.mkdtempSync / writeFileSync / unlinkSync / rmSync against real
// temp directories) behaves identically to before.
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    const existsSync = vi.fn(actual.existsSync);
    const chmodSync = vi.fn(actual.chmodSync);
    // Both forms are patched: this file's own `import * as fs` (named-export
    // lookup) AND DependencyDefinitions.ts's `import fs from 'fs'` (default
    // import) must see the SAME spies, or a test below silently watches a
    // different fs call than the one production code actually makes.
    return {
        ...actual,
        existsSync,
        chmodSync,
        default: { ...actual, existsSync, chmodSync },
    };
});

describe('resolveMkcertExe (Local-Dependencies-Only)', () => {
    it('resolves to an absolute path under the given dependencies directory, never PATH', () => {
        const depsPath = path.resolve('C:/fake-install-root/dependencies');
        const exe = resolveMkcertExe(depsPath);

        expect(path.isAbsolute(exe)).toBe(true);
        expect(exe.startsWith(depsPath)).toBe(true);
        expect(exe).toBe(path.join(depsPath, 'mkcert', mkcertExeName()));
    });

    it("matches the layout mkcert's own checkInstalled uses (DependencyDefinitions.ts) -- no version segment", () => {
        const depsPath = path.resolve('C:/fake-install-root/dependencies');
        const exe = resolveMkcertExe(depsPath);
        // <depsPath>/mkcert/<exe> -- exactly two path segments past depsPath.
        const relative = path.relative(depsPath, exe);
        expect(relative.split(path.sep)).toEqual(['mkcert', mkcertExeName()]);
    });

    it("is the EXACT path the mkcert DependencyDefinition's own checkInstalled stats (N3 drift guard)", async () => {
        // N3: the three assertions above prove shape (absolute, contained,
        // no version segment) but never read DependencyDefinitions.ts itself
        // -- change ITS path construction (add a version segment, rename the
        // folder) and those would stay green while the manager installs to
        // one path and this service spawns from another. Spying on
        // fs.existsSync and asserting checkInstalled stats exactly
        // resolveMkcertExe's answer couples the two for real.
        const depsPath = path.resolve('C:/fake-install-root/dependencies');
        const mkcertDef = getDependencyDefinitions(depsPath).find((d) => d.name === 'mkcert');
        expect(mkcertDef).toBeDefined();
        await mkcertDef!.checkInstalled(depsPath);
        expect(vi.mocked(fs.existsSync)).toHaveBeenCalledWith(resolveMkcertExe(depsPath));
    });
});

describe('removeCaRootFiles / removeLeafFiles -- destructive deletes, proven exact (amendment E)', () => {
    const dirs: string[] = [];

    function tmpDir(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-certdel-'));
        dirs.push(dir);
        return dir;
    }

    afterEach(() => {
        while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    });

    it('removeCaRootFiles deletes exactly rootCA.pem and rootCA-key.pem, nothing else', () => {
        const caRoot = tmpDir();
        fs.writeFileSync(path.join(caRoot, 'rootCA.pem'), 'ca-cert');
        fs.writeFileSync(path.join(caRoot, 'rootCA-key.pem'), 'ca-key');
        fs.writeFileSync(path.join(caRoot, 'unrelated.txt'), 'do not touch me');
        fs.mkdirSync(path.join(caRoot, 'subdir'));

        removeCaRootFiles(caRoot);

        expect(fs.existsSync(path.join(caRoot, 'rootCA.pem'))).toBe(false);
        expect(fs.existsSync(path.join(caRoot, 'rootCA-key.pem'))).toBe(false);
        // Never a directory, never a sibling file.
        expect(fs.existsSync(path.join(caRoot, 'unrelated.txt'))).toBe(true);
        expect(fs.existsSync(path.join(caRoot, 'subdir'))).toBe(true);
    });

    it('removeCaRootFiles is a no-op, not a throw, when the files are already gone', () => {
        const caRoot = tmpDir();
        expect(() => removeCaRootFiles(caRoot)).not.toThrow();
    });

    it('removeCaRootFiles never removes a directory, even if one exists at the exact rootCA.pem path (N12)', () => {
        const caRoot = tmpDir();
        const rootCaPath = path.join(caRoot, 'rootCA.pem');
        fs.mkdirSync(rootCaPath); // a directory happens to sit at that path
        fs.writeFileSync(path.join(caRoot, 'rootCA-key.pem'), 'ca-key');

        // unlink on a directory throws EPERM/EISDIR -- that is NOT swallowed as
        // a missing-file no-op, mirroring removeLeafFiles' equivalent test.
        expect(() => removeCaRootFiles(caRoot)).toThrow();
        expect(fs.existsSync(rootCaPath)).toBe(true);
    });

    it('removeLeafFiles deletes exactly certFile and keyFile, nothing else', () => {
        const dir = tmpDir();
        const certFile = path.join(dir, 'cert.pem');
        const keyFile = path.join(dir, 'key.pem');
        const unrelated = path.join(dir, 'unrelated.txt');
        fs.writeFileSync(certFile, 'leaf-cert');
        fs.writeFileSync(keyFile, 'leaf-key');
        fs.writeFileSync(unrelated, 'do not touch me');
        fs.mkdirSync(path.join(dir, 'subdir'));

        removeLeafFiles({ certFile, keyFile });

        expect(fs.existsSync(certFile)).toBe(false);
        expect(fs.existsSync(keyFile)).toBe(false);
        expect(fs.existsSync(unrelated)).toBe(true);
        expect(fs.existsSync(path.join(dir, 'subdir'))).toBe(true);
    });

    it('removeLeafFiles is a no-op, not a throw, when the files are already gone', () => {
        const dir = tmpDir();
        expect(() =>
            removeLeafFiles({ certFile: path.join(dir, 'cert.pem'), keyFile: path.join(dir, 'key.pem') }),
        ).not.toThrow();
    });

    it('never removes a directory, even if one exists at the exact leaf path', () => {
        const dir = tmpDir();
        const certFile = path.join(dir, 'cert.pem');
        fs.mkdirSync(certFile); // a directory happens to sit at that path
        const keyFile = path.join(dir, 'key.pem');
        fs.writeFileSync(keyFile, 'leaf-key');

        // unlink on a directory throws EPERM/EISDIR -- that is NOT swallowed as
        // a missing-file no-op, because it is not the missing-file case at all.
        expect(() => removeLeafFiles({ certFile, keyFile })).toThrow();
        expect(fs.existsSync(certFile)).toBe(true);
    });
});

describe('ensureCaRootDirSync (M3)', () => {
    const dirs: string[] = [];

    function tmpDir(): string {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-caroot-'));
        dirs.push(dir);
        return dir;
    }

    afterEach(() => {
        vi.mocked(fs.chmodSync).mockClear();
        while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    });

    it('creates a missing directory (and any missing parent)', () => {
        const base = tmpDir();
        const caRoot = path.join(base, 'nested', 'ca');
        expect(fs.existsSync(caRoot)).toBe(false);

        ensureCaRootDirSync(caRoot);

        expect(fs.existsSync(caRoot)).toBe(true);
    });

    it('chmods to 0700 even when the directory already existed at a looser mode -- the retro-fix case', () => {
        // mkdirSync's `mode` option only takes effect for a directory it
        // actually CREATES (Go's os.MkdirAll behaves the same way, which is
        // exactly the gap M3 is about: mkcert's own MkdirAll(CAROOT, 0755)
        // never re-tightens a directory it finds already there). Simulating
        // that by pre-creating the directory looser is what makes this test
        // prove the explicit chmodSync call matters, not just the mkdirSync.
        const base = tmpDir();
        const caRoot = path.join(base, 'ca');
        fs.mkdirSync(caRoot, { recursive: true, mode: 0o755 });

        ensureCaRootDirSync(caRoot);

        // Asserted as a call, not just a filesystem read-back: real POSIX
        // mode bits are only meaningful on a POSIX host (this repo's own
        // precedent for the leaf-key chmod test, CertService.test.ts, notes
        // reading a mode back "cannot work on this box" on Windows), but the
        // call itself is provable on every platform this suite runs on.
        expect(vi.mocked(fs.chmodSync)).toHaveBeenCalledWith(caRoot, 0o700);
        if (process.platform !== 'win32') {
            const mode = fs.statSync(caRoot).mode & 0o777;
            expect(mode).toBe(0o700);
        }
    });
});

describe('ensureMkcertInstalled (M2 -- fetched on first use)', () => {
    function mockConfig() {
        vi.mocked(Config.getInstance).mockReturnValue({
            dependenciesPath: '/fake/deps',
            restartMarkerPath: '/fake/deps/.restart',
        } as never);
    }

    afterEach(() => {
        vi.mocked(getDependencyManager).mockReset();
        vi.mocked(Config.getInstance).mockReset();
    });

    it('does nothing -- no Config/DependencyManager lookup at all -- when the binary already exists', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-mkcert-exists-'));
        const exe = path.join(dir, 'mkcert.exe');
        fs.writeFileSync(exe, 'already here');
        try {
            await expect(ensureMkcertInstalled(exe)).resolves.toBeUndefined();
            expect(Config.getInstance).not.toHaveBeenCalled();
            expect(getDependencyManager).not.toHaveBeenCalled();
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('installs through the getDependencyManager() singleton when the binary is missing, and resolves on success', async () => {
        const missingExe = path.join(os.tmpdir(), 'ws-mkcert-missing-', 'mkcert.exe');
        mockConfig();
        const update = vi.fn().mockResolvedValue({ success: true, newVersion: 'v1.4.4-bt.2', requiresRestart: false });
        vi.mocked(getDependencyManager).mockReturnValue({ update } as never);

        await expect(ensureMkcertInstalled(missingExe)).resolves.toBeUndefined();

        expect(getDependencyManager).toHaveBeenCalledWith({
            dependenciesPath: '/fake/deps',
            restartMarkerPath: '/fake/deps/.restart',
        });
        expect(update).toHaveBeenCalledWith('mkcert');
    });

    it('throws (surfacing the real reason) when the on-demand install fails -- never a silent spawn of a missing binary', async () => {
        const missingExe = path.join(os.tmpdir(), 'ws-mkcert-missing-2-', 'mkcert.exe');
        mockConfig();
        const update = vi.fn().mockResolvedValue({
            success: false,
            errorMessage: 'checksum mismatch for mkcert-v1.4.4-bt.2-windows-amd64.exe',
            requiresRestart: false,
        });
        vi.mocked(getDependencyManager).mockReturnValue({ update } as never);

        await expect(ensureMkcertInstalled(missingExe)).rejects.toThrow(/checksum mismatch/);
    });
});
