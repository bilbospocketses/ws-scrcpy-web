import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { mkcertExeName } from '../../DependencyDefinitions';
import { removeCaRootFiles, removeLeafFiles, resolveMkcertExe } from '../createCertService';

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
