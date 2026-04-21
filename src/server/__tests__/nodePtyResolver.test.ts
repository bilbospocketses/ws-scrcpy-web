import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    resolveNodePty, getNodePty, _resetForTest,
    composePrebuiltKey, verifyChecksum,
    homebridgePrebuildPath, _findCacheEntry,
    type HostInfo,
} from '../NodePtyResolver';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as os from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';

describe('NodePtyResolver', () => {
    beforeEach(() => {
        _resetForTest();
        vi.restoreAllMocks();
    });

    it('getNodePty returns undefined before resolveNodePty is called', () => {
        expect(getNodePty()).toBeUndefined();
    });

    it('resolveNodePty returns { available: true } when homebridge require succeeds', async () => {
        // Default happy path — the test host should have homebridge installed
        // with a working prebuilt for its own ABI.
        const depsPath = path.join(os.tmpdir(), 'ws-scrcpy-web-test-deps-' + Date.now());
        const handle = await resolveNodePty(depsPath);
        expect(handle.available).toBe(true);
        expect(handle.pty).toBeDefined();
        expect(typeof (handle.pty as any).spawn).toBe('function');
    });

    it('getNodePty returns the resolved handle after resolveNodePty completes', async () => {
        const depsPath = path.join(os.tmpdir(), 'ws-scrcpy-web-test-deps-' + Date.now());
        await resolveNodePty(depsPath);
        const handle = getNodePty();
        expect(handle?.available).toBe(true);
    });

    it('resolveNodePty caches and returns the same handle on subsequent calls', async () => {
        const depsPath = path.join(os.tmpdir(), 'ws-scrcpy-web-test-deps-' + Date.now());
        const first = await resolveNodePty(depsPath);
        const second = await resolveNodePty(depsPath);
        expect(second).toBe(first);
    });
});

describe('NodePtyResolver — helpers', () => {
    let depsPath: string;

    beforeEach(() => {
        _resetForTest();
        depsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-web-prebuilds-'));
    });

    afterEach(() => {
        try { fs.rmSync(depsPath, { recursive: true, force: true }); } catch {}
    });

    it('composePrebuiltKey produces a stable filename for linux with libc suffix', async () => {
        const { composePrebuiltKey } = await import('../NodePtyResolver');
        const key = composePrebuiltKey({
            platform: 'linux',
            arch: 'x64',
            libc: 'glibc',
            nodeAbi: '127',
        }, '1.1.0');
        expect(key).toBe('node-pty-v1.1.0-node-abi127-linux-x64-glibc');
    });

    it('composePrebuiltKey omits libc suffix on win32', async () => {
        const { composePrebuiltKey } = await import('../NodePtyResolver');
        const key = composePrebuiltKey({
            platform: 'win32',
            arch: 'arm64',
            libc: 'glibc',
            nodeAbi: '127',
        }, '1.1.0');
        expect(key).toBe('node-pty-v1.1.0-node-abi127-win32-arm64');
    });

    it('verifyChecksum returns true for matching SHA256', async () => {
        const { verifyChecksum } = await import('../NodePtyResolver');
        const filePath = path.join(depsPath, 'test.bin');
        fs.writeFileSync(filePath, 'hello world');
        // sha256('hello world') = b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9
        const ok = await verifyChecksum(filePath, 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
        expect(ok).toBe(true);
    });

    it('verifyChecksum returns false for mismatching SHA256', async () => {
        const { verifyChecksum } = await import('../NodePtyResolver');
        const filePath = path.join(depsPath, 'test.bin');
        fs.writeFileSync(filePath, 'hello world');
        const ok = await verifyChecksum(filePath, '0'.repeat(64));
        expect(ok).toBe(false);
    });
});

describe('NodePtyResolver — homebridgePrebuildPath', () => {
    it('produces node.abi{N}.node path inside homebridge prebuilds dir on linux glibc', () => {
        const host: HostInfo = { platform: 'linux', arch: 'x64', libc: 'glibc', nodeAbi: '127' };
        const result = homebridgePrebuildPath(host);
        expect(result).toContain(path.join('prebuilds', 'linux-x64'));
        expect(path.basename(result)).toBe('node.abi127.node');
    });

    it('produces node.abi{N}.musl.node path on linux musl', () => {
        const host: HostInfo = { platform: 'linux', arch: 'arm64', libc: 'musl', nodeAbi: '115' };
        const result = homebridgePrebuildPath(host);
        expect(result).toContain(path.join('prebuilds', 'linux-arm64'));
        expect(path.basename(result)).toBe('node.abi115.musl.node');
    });

    it('produces node.abi{N}.node path on win32 (no musl suffix)', () => {
        const host: HostInfo = { platform: 'win32', arch: 'x64', libc: 'glibc', nodeAbi: '127' };
        const result = homebridgePrebuildPath(host);
        expect(result).toContain(path.join('prebuilds', 'win32-x64'));
        expect(path.basename(result)).toBe('node.abi127.node');
    });

    it('path lives under the installed @homebridge package directory', () => {
        const host: HostInfo = { platform: 'linux', arch: 'x64', libc: 'glibc', nodeAbi: '127' };
        const result = homebridgePrebuildPath(host);
        const pkgDir = path.dirname(require.resolve('@homebridge/node-pty-prebuilt-multiarch/package.json'));
        expect(result.startsWith(pkgDir)).toBe(true);
    });
});

describe('NodePtyResolver — _findCacheEntry', () => {
    let depsPath: string;
    let cacheDir: string;

    beforeEach(() => {
        depsPath = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-web-cache-'));
        cacheDir = path.join(depsPath, 'node-pty', 'prebuilds');
    });

    afterEach(() => {
        try { fs.rmSync(depsPath, { recursive: true, force: true }); } catch {}
    });

    it('returns null when cache directory does not exist', () => {
        const host: HostInfo = { platform: 'linux', arch: 'x64', libc: 'glibc', nodeAbi: '127' };
        const result = _findCacheEntry(host, path.join(depsPath, 'nonexistent'));
        expect(result).toBeNull();
    });

    it('returns null when no entry matches the host ABI/platform/arch', () => {
        const host: HostInfo = { platform: 'linux', arch: 'x64', libc: 'glibc', nodeAbi: '127' };
        fs.mkdirSync(cacheDir, { recursive: true });
        // Create an entry for a different ABI
        fs.mkdirSync(path.join(cacheDir, 'node-pty-v1.1.0-node-abi115-linux-x64-glibc'), { recursive: true });
        const result = _findCacheEntry(host, cacheDir);
        expect(result).toBeNull();
    });

    it('returns null when the abi/platform matches but libc differs', () => {
        const host: HostInfo = { platform: 'linux', arch: 'x64', libc: 'glibc', nodeAbi: '127' };
        fs.mkdirSync(cacheDir, { recursive: true });
        // musl entry, host wants glibc
        fs.mkdirSync(path.join(cacheDir, 'node-pty-v1.1.0-node-abi127-linux-x64-musl'), { recursive: true });
        const result = _findCacheEntry(host, cacheDir);
        expect(result).toBeNull();
    });

    it('finds a matching cache entry and returns the correct binary path', () => {
        const host: HostInfo = { platform: 'linux', arch: 'x64', libc: 'glibc', nodeAbi: '127' };
        const entryName = 'node-pty-v1.1.0-node-abi127-linux-x64-glibc';
        const entryDir = path.join(cacheDir, entryName);
        fs.mkdirSync(entryDir, { recursive: true });
        const fakeNodeFile = path.join(entryDir, 'pty.node');
        fs.writeFileSync(fakeNodeFile, 'fake binary content');

        const result = _findCacheEntry(host, cacheDir);
        expect(result).not.toBeNull();
        expect(result!.entryName).toBe(entryName);
        expect(result!.binaryPath).toBe(fakeNodeFile);
    });

    it('returns a result even when pty.node does not yet exist (caller checks existence)', () => {
        // _findCacheEntry only scans directory names; it does not check pty.node existence.
        const host: HostInfo = { platform: 'linux', arch: 'x64', libc: 'glibc', nodeAbi: '127' };
        const entryName = 'node-pty-v1.1.0-node-abi127-linux-x64-glibc';
        fs.mkdirSync(path.join(cacheDir, entryName), { recursive: true });
        // pty.node intentionally NOT created

        const result = _findCacheEntry(host, cacheDir);
        expect(result).not.toBeNull();
        expect(result!.entryName).toBe(entryName);
        // binaryPath is computed but file doesn't exist; caller is responsible for existsSync check
        expect(result!.binaryPath).toContain('pty.node');
    });

    it('picks the correct entry when multiple versions are present', () => {
        const host: HostInfo = { platform: 'linux', arch: 'x64', libc: 'glibc', nodeAbi: '127' };
        fs.mkdirSync(cacheDir, { recursive: true });
        // older version for different ABI
        fs.mkdirSync(path.join(cacheDir, 'node-pty-v1.0.0-node-abi115-linux-x64-glibc'), { recursive: true });
        // correct entry
        const correctEntry = 'node-pty-v1.1.0-node-abi127-linux-x64-glibc';
        fs.mkdirSync(path.join(cacheDir, correctEntry), { recursive: true });
        fs.writeFileSync(path.join(cacheDir, correctEntry, 'pty.node'), 'fake');

        const result = _findCacheEntry(host, cacheDir);
        expect(result?.entryName).toBe(correctEntry);
    });

    it('omits the libc suffix when looking up a win32 entry', () => {
        const host: HostInfo = { platform: 'win32', arch: 'x64', libc: 'glibc', nodeAbi: '127' };
        fs.mkdirSync(cacheDir, { recursive: true });
        const entryName = 'node-pty-v1.1.0-node-abi127-win32-x64';
        fs.mkdirSync(path.join(cacheDir, entryName), { recursive: true });
        fs.writeFileSync(path.join(cacheDir, entryName, 'pty.node'), 'fake');

        const result = _findCacheEntry(host, cacheDir);
        expect(result?.entryName).toBe(entryName);
    });
});

describe('NodePtyResolver — SHA256 mismatch delete behavior', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-sha-'));
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    });

    it('verifyChecksum returns false and file is still present (caller deletes)', async () => {
        const filePath = path.join(tmpDir, 'tarball.tar.gz');
        fs.writeFileSync(filePath, 'tampered content');
        const wrong = '0'.repeat(64);
        const ok = await verifyChecksum(filePath, wrong);
        expect(ok).toBe(false);
        // File should still exist — the download path calls rmSync after a false result
        expect(fs.existsSync(filePath)).toBe(true);
    });

    it('verifyChecksum handles non-existent file gracefully (returns false)', async () => {
        const result = await verifyChecksum(path.join(tmpDir, 'does-not-exist.bin'), 'a'.repeat(64));
        expect(result).toBe(false);
    });
});
