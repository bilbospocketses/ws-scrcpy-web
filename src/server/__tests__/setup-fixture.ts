import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Build a tarball named {key}.tar.gz whose contents are everything under
 * `srcDir`, mirroring the matrix workflow's output format (archive has a
 * single top-level dir named after the key; resolver extracts with
 * --strip-components=1).
 *
 * Returns the tarball path and its SHA256 hash.
 */
export function buildFixtureTarball(srcDir: string, key: string, outDir: string): { tarPath: string; sha256: string } {
    fs.mkdirSync(outDir, { recursive: true });
    const stagingDir = path.join(outDir, '_staging');
    const keyDir = path.join(stagingDir, key);
    fs.mkdirSync(keyDir, { recursive: true });
    fs.cpSync(srcDir, keyDir, { recursive: true });

    const tarPath = path.join(outDir, `${key}.tar.gz`);
    // GNU tar on Windows (Git Bash) interprets 'C:\\...' as 'host:path'. Use
    // cwd-relative paths: cd into stagingDir, write tarball into its parent.
    execFileSync('tar', ['-czf', path.join('..', `${key}.tar.gz`), key], {
        stdio: 'inherit',
        cwd: stagingDir,
    });
    fs.rmSync(stagingDir, { recursive: true, force: true });

    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(tarPath));
    return { tarPath, sha256: hash.digest('hex') };
}
