// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as os from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    _resetForTest,
    composePrebuiltKey,
    copySeedToDataRoot,
    dataRootPackageDir,
    packageHasBinary,
    ptyNodePath,
    verifyChecksum,
} from '../NodePtyResolver';

describe('NodePtyResolver — helpers', () => {
    let tmpDir: string;

    beforeEach(() => {
        _resetForTest();
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-web-resolver-'));
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
    });

    it('composePrebuiltKey produces linux key with libc suffix', () => {
        const key = composePrebuiltKey(
            {
                platform: 'linux',
                arch: 'x64',
                libc: 'glibc',
                nodeAbi: '127',
            },
            '1.1.0',
        );
        expect(key).toBe('node-pty-v1.1.0-node-abi127-linux-x64-glibc');
    });

    it('composePrebuiltKey omits libc suffix on win32', () => {
        const key = composePrebuiltKey(
            {
                platform: 'win32',
                arch: 'arm64',
                libc: 'glibc',
                nodeAbi: '127',
            },
            '1.1.0',
        );
        expect(key).toBe('node-pty-v1.1.0-node-abi127-win32-arm64');
    });

    it('verifyChecksum returns true for matching SHA256', async () => {
        const filePath = path.join(tmpDir, 'test.bin');
        fs.writeFileSync(filePath, 'hello world');
        const ok = await verifyChecksum(filePath, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
        expect(ok).toBe(true);
    });

    it('verifyChecksum returns false for mismatching SHA256', async () => {
        const filePath = path.join(tmpDir, 'test.bin');
        fs.writeFileSync(filePath, 'hello world');
        const ok = await verifyChecksum(filePath, '0'.repeat(64));
        expect(ok).toBe(false);
    });

    it('dataRootPackageDir composes path with version + host on win32', () => {
        const dir = dataRootPackageDir(tmpDir, '1.1.0', {
            platform: 'win32',
            arch: 'x64',
            libc: 'glibc',
            nodeAbi: '137',
        });
        expect(dir).toBe(path.join(tmpDir, 'node-pty', 'v1.1.0-win32-x64'));
    });

    it('dataRootPackageDir includes libc segment on linux', () => {
        const dir = dataRootPackageDir(tmpDir, '1.1.0', {
            platform: 'linux',
            arch: 'x64',
            libc: 'musl',
            nodeAbi: '127',
        });
        expect(dir).toBe(path.join(tmpDir, 'node-pty', 'v1.1.0-linux-x64-musl'));
    });

    it('packageHasBinary returns false for non-existent package dir', () => {
        expect(packageHasBinary(path.join(tmpDir, 'nope'))).toBe(false);
    });

    it('packageHasBinary returns true when pty.node exists at the expected path', () => {
        const pkgDir = path.join(tmpDir, 'pkg');
        const releaseDir = path.dirname(ptyNodePath(pkgDir));
        fs.mkdirSync(releaseDir, { recursive: true });
        fs.writeFileSync(path.join(releaseDir, 'pty.node'), 'fake');
        expect(packageHasBinary(pkgDir)).toBe(true);
    });

    it('copySeedToDataRoot returns true and short-circuits when target already has pty.node', () => {
        const pkgDir = path.join(tmpDir, 'pkg');
        const releaseDir = path.dirname(ptyNodePath(pkgDir));
        fs.mkdirSync(releaseDir, { recursive: true });
        fs.writeFileSync(path.join(releaseDir, 'pty.node'), 'fake');
        // Seed is missing — but since target already satisfies, copy returns true.
        expect(copySeedToDataRoot(pkgDir)).toBe(true);
    });

    it('copySeedToDataRoot returns false when seed is missing and target is empty', () => {
        const pkgDir = path.join(tmpDir, 'pkg');
        // Real seed at <__dirname>/../seed/node-pty-pkg WILL NOT exist in the
        // test environment (vitest runs from src, no compiled bundle), so the
        // seed-existence check fails cleanly.
        expect(copySeedToDataRoot(pkgDir)).toBe(false);
    });

    it('ptyNodePath ends with node_modules/node-pty/build/Release/pty.node', () => {
        const p = ptyNodePath(path.join(tmpDir, 'pkg'));
        const tail = p.split(path.sep).slice(-5).join('/');
        expect(tail).toBe('node_modules/node-pty/build/Release/pty.node');
    });
});
