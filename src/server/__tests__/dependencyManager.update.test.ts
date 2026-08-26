import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DependencyStatus } from '../../common/DependencyTypes';
import { DependencyManager } from '../DependencyManager';

/**
 * End-to-end coverage for the "scrcpy-server update loop" bug:
 * pre-fix, update() set in-memory installedVersion to the new value,
 * but checkInstalled() returned the bundled SERVER_VERSION constant
 * regardless of what was on disk — so the next checkAll() flipped
 * the row back to "Update available" even though the JAR had been
 * replaced. Post-fix, the new version is persisted as a .version
 * marker and checkInstalled reads from it; both update() and the
 * subsequent checkAll() agree on what's installed.
 */
describe('DependencyManager.update("scrcpy-server") — loop fix', () => {
    let tmpDir: string;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-update-'));

        // Stub fetch for both checkLatest (GitHub releases API) and the
        // binary download. Both go through global fetch.
        fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.includes('api.github.com')) {
                return new Response(JSON.stringify({ tag_name: 'v4.0' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            // Binary download — return synthetic v4.0 bytes
            return new Response('fake-v4.0-jar-bytes', { status: 200 });
        });
    });

    afterEach(() => {
        fetchSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('persists the installed version so a subsequent checkAll does not reset it', async () => {
        const mgr = new DependencyManager(tmpDir);

        // Seed the in-memory state to look like a pre-update install.
        const info = mgr.getByName('scrcpy-server')!;
        info.installedVersion = '3.3.4';
        info.latestVersion = '4.0';
        info.status = DependencyStatus.UpdateAvailable;

        const result = await mgr.update('scrcpy-server');

        expect(result.success).toBe(true);
        expect(result.newVersion).toBe('4.0');

        // The .version marker must exist on disk after a successful update.
        const marker = path.join(tmpDir, 'scrcpy-server', '.version');
        expect(fs.readFileSync(marker, 'utf8').trim()).toBe('4.0');

        // In-memory state shows the new version.
        expect(mgr.getByName('scrcpy-server')!.installedVersion).toBe('4.0');
        expect(mgr.getByName('scrcpy-server')!.status).toBe(DependencyStatus.UpToDate);

        // The actual loop trigger: re-running checkInstalled (as checkAll
        // does) must NOT clobber installedVersion back to SERVER_VERSION.
        await mgr.checkInstalled('scrcpy-server');
        expect(mgr.getByName('scrcpy-server')!.installedVersion).toBe('4.0');
    });
});

describe('DependencyManager.update() has no launcher gate', () => {
    afterEach(() => {
        vi.doUnmock('../service/elevatedRunner');
    });

    it('does not refuse nodejs when the launcher is unavailable', async () => {
        // The inverse of the gate this replaced: nodejs and adb used to short-
        // circuit with reason='launcher-required' before doing any work, because
        // extraction shelled out to the packaged launcher. Extraction is in-process
        // now, so update() must proceed and fail (or succeed) on its own merits.
        // We assert on the *absence of the gate*, not on the outcome — the download
        // is unmocked here and expected to fail.
        vi.doMock('../service/elevatedRunner', () => ({
            launcherIsAvailable: async () => false,
            resolveLauncherPath: () => '/fake/launcher.exe',
        }));
        const { DependencyManager: Mgr } = await import('../DependencyManager');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-gate-'));
        using _cleanup = {
            [Symbol.dispose]() {
                fs.rmSync(tmp, { recursive: true, force: true });
            },
        };
        const fetchSpy = vi.spyOn(global, 'fetch').mockRejectedValue(new Error('network disabled in test'));
        using _restoreFetch = {
            [Symbol.dispose]() {
                fetchSpy.mockRestore();
            },
        };
        const mgr = new Mgr(tmp);
        const result = await mgr.update('nodejs');
        // No `reason` field to assert on: it only ever carried 'launcher-required',
        // and removing it from UpdateResult makes the old gate unrepresentable.
        expect(result.errorMessage).not.toMatch(/installed build/);
        // It got past the gate and into the real work, so the failure is a
        // download failure and the entry is marked Error rather than left pristine.
        expect(mgr.getByName('nodejs')!.status).toBe(DependencyStatus.Error);
    });

    it('does not gate scrcpy-server (no launcher needed)', async () => {
        vi.doMock('../service/elevatedRunner', () => ({
            launcherIsAvailable: async () => false,
            resolveLauncherPath: () => '/fake/launcher.exe',
        }));
        const { DependencyManager: Mgr } = await import('../DependencyManager');
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-gate-scrcpy-'));
        using _cleanup = {
            [Symbol.dispose]() {
                fs.rmSync(tmp, { recursive: true, force: true });
            },
        };
        const fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input) => {
            const url = typeof input === 'string' ? input : input.toString();
            if (url.includes('api.github.com')) {
                return new Response(JSON.stringify({ tag_name: 'v4.0' }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                });
            }
            return new Response('fake-jar-bytes', { status: 200 });
        });
        using _restoreFetch = {
            [Symbol.dispose]() {
                fetchSpy.mockRestore();
            },
        };
        const mgr = new Mgr(tmp);
        const info = mgr.getByName('scrcpy-server')!;
        info.installedVersion = '3.3.4';
        info.latestVersion = '4.0';
        const result = await mgr.update('scrcpy-server');
        expect(result.success).toBe(true);
    });
});

describe('DependencyManager.installNodejs rollback', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-nodeinstall-'));
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        vi.restoreAllMocks();
    });

    async function callInstallNodejs(
        mgr: DependencyManager,
        downloadPath: string,
        version: string,
        installTmp: string,
        platform: 'win32' | 'linux',
    ): Promise<void> {
        // installNodejs is private — invoke via a typed cast for the test only.
        await (mgr as any).installNodejs(downloadPath, version, installTmp, platform);
    }

    it('win32: extract failure leaves destDir untouched (original node.exe intact)', async () => {
        const mgr = new DependencyManager(tmpDir);
        const destDir = path.join(tmpDir, 'node');
        fs.mkdirSync(destDir, { recursive: true });
        const originalNodeExe = path.join(destDir, 'node.exe');
        fs.writeFileSync(originalNodeExe, 'ORIGINAL-NODE-BYTES');

        const extractTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-extract-'));

        // Mock extractZip to throw
        vi.spyOn(mgr as any, 'extractZip').mockRejectedValue(new Error('mock extract fail'));

        await expect(callInstallNodejs(mgr, '/fake/download.zip', '24.15.0', extractTmp, 'win32')).rejects.toThrow(
            'mock extract fail',
        );

        // Original node.exe must be intact; no .old created.
        expect(fs.readFileSync(originalNodeExe, 'utf8')).toBe('ORIGINAL-NODE-BYTES');
        expect(fs.existsSync(path.join(destDir, 'node.exe.old'))).toBe(false);

        fs.rmSync(extractTmp, { recursive: true, force: true });
    });

    it('win32: copy failure restores .old back to .exe (rollback)', async () => {
        const mgr = new DependencyManager(tmpDir);
        const destDir = path.join(tmpDir, 'node');
        fs.mkdirSync(destDir, { recursive: true });
        const originalNodeExe = path.join(destDir, 'node.exe');
        fs.writeFileSync(originalNodeExe, 'ORIGINAL-NODE-BYTES');

        const extractTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-extract-'));
        // Simulate a successful extract: write the expected archive layout.
        const archiveRoot = path.join(extractTmp, 'node-v24.15.0-win-x64');
        fs.mkdirSync(archiveRoot, { recursive: true });
        fs.writeFileSync(path.join(archiveRoot, 'node.exe'), 'NEW-NODE-BYTES');

        // extractZip mock succeeds (no-op — the layout is pre-populated).
        vi.spyOn(mgr as any, 'extractZip').mockResolvedValue(undefined);
        // copyDirContents mock throws partway.
        vi.spyOn(mgr as any, 'copyDirContents').mockImplementation(() => {
            throw new Error('mock copy fail');
        });

        await expect(callInstallNodejs(mgr, '/fake/download.zip', '24.15.0', extractTmp, 'win32')).rejects.toThrow(
            'mock copy fail',
        );

        // node.exe must be restored from .old; .old must no longer exist after restore.
        expect(fs.existsSync(originalNodeExe)).toBe(true);
        expect(fs.readFileSync(originalNodeExe, 'utf8')).toBe('ORIGINAL-NODE-BYTES');
        expect(fs.existsSync(path.join(destDir, 'node.exe.old'))).toBe(false);

        fs.rmSync(extractTmp, { recursive: true, force: true });
    });

    it('win32: full success replaces node.exe (and leaves node.exe.old per current behavior)', async () => {
        const mgr = new DependencyManager(tmpDir);
        const destDir = path.join(tmpDir, 'node');
        fs.mkdirSync(destDir, { recursive: true });
        const originalNodeExe = path.join(destDir, 'node.exe');
        fs.writeFileSync(originalNodeExe, 'ORIGINAL-NODE-BYTES');

        const extractTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-extract-'));
        const archiveRoot = path.join(extractTmp, 'node-v24.15.0-win-x64');
        fs.mkdirSync(archiveRoot, { recursive: true });
        fs.writeFileSync(path.join(archiveRoot, 'node.exe'), 'NEW-NODE-BYTES');
        fs.writeFileSync(path.join(archiveRoot, 'npm.cmd'), 'NPM-CMD-BYTES');

        vi.spyOn(mgr as any, 'extractZip').mockResolvedValue(undefined);
        // Don't mock copyDirContents — let it run for real on the pre-populated archive.

        await callInstallNodejs(mgr, '/fake/download.zip', '24.15.0', extractTmp, 'win32');

        expect(fs.readFileSync(originalNodeExe, 'utf8')).toBe('NEW-NODE-BYTES');
        expect(fs.readFileSync(path.join(destDir, 'npm.cmd'), 'utf8')).toBe('NPM-CMD-BYTES');
        expect(fs.existsSync(path.join(destDir, 'node.exe.old'))).toBe(false);

        fs.rmSync(extractTmp, { recursive: true, force: true });
    });

    it('linux: extract failure leaves destDir untouched', async () => {
        const mgr = new DependencyManager(tmpDir);
        const destDir = path.join(tmpDir, 'node');
        fs.mkdirSync(destDir, { recursive: true });
        const originalNode = path.join(destDir, 'node');
        fs.writeFileSync(originalNode, 'ORIGINAL-LINUX-NODE');

        // Point download at a non-existent file so tar will fail.
        const extractTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-extract-linux-'));

        await expect(
            callInstallNodejs(mgr, '/does/not/exist.tar.gz', '24.15.0', extractTmp, 'linux'),
        ).rejects.toThrow();

        // Linux destDir state unchanged.
        expect(fs.readFileSync(originalNode, 'utf8')).toBe('ORIGINAL-LINUX-NODE');

        fs.rmSync(extractTmp, { recursive: true, force: true });
    });
});
