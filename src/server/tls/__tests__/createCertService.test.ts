import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDependencyDefinitions, mkcertExeName } from '../../DependencyDefinitions';
import { removeCaRootFiles, removeLeafFiles, resolveMkcertExe } from '../createCertService';

// Partial mock (N3 drift-guard test only): existsSync becomes spy-able while
// still delegating to the real implementation, so it behaves identically for
// every other test in this file (which use the real fs.mkdtempSync /
// writeFileSync / unlinkSync / rmSync against real temp directories).
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs')>();
    const existsSync = vi.fn(actual.existsSync);
    // Both forms are patched: this file's own `import * as fs` (named-export
    // lookup) AND DependencyDefinitions.ts's `import fs from 'fs'` (default
    // import) must see the SAME spy, or the drift-guard test below silently
    // watches a different existsSync than the one checkInstalled actually calls.
    return { ...actual, existsSync, default: { ...actual, existsSync } };
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
