import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DependencyStatus } from '../../common/DependencyTypes';
import { mkcertAssetName, mkcertExeName } from '../DependencyDefinitions';
import { DependencyManager, getDependencyManager, makeUpdateTmpDir } from '../DependencyManager';

describe('DependencyManager', () => {
    it('initializes with all dependencies in unknown state', async () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const deps = await mgr.getAll();
        expect(deps.length).toBe(4);
        expect(deps.every((d) => d.status === DependencyStatus.Unknown)).toBe(true);
    });

    it('getByName returns correct dependency', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const node = mgr.getByName('nodejs');
        expect(node).toBeDefined();
        expect(node!.displayName).toBe('Node.js');
    });

    it('getByName returns undefined for unknown dependency', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        expect(mgr.getByName('nonexistent')).toBeUndefined();
    });

    it('nodejs is marked as requires restart', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const node = mgr.getByName('nodejs');
        expect(node!.requiresRestart).toBe(true);
    });

    it('scrcpy-server is marked as no restart needed', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const scrcpy = mgr.getByName('scrcpy-server');
        expect(scrcpy!.requiresRestart).toBe(false);
    });
});

describe('DependencyManager.getAll() canUpdate', () => {
    it('reports canUpdate=true for all deps when launcher is available', async () => {
        vi.resetModules();
        vi.doMock('../service/elevatedRunner', () => ({
            launcherIsAvailable: async () => true,
            resolveLauncherPath: () => '/fake/launcher.exe',
        }));
        // Re-import after mock to pick up the stubbed module
        const { DependencyManager: Mgr } = await import('../DependencyManager');
        const mgr = new Mgr('/tmp/test-deps-canupdate-yes');
        const deps = await mgr.getAll();
        for (const dep of deps) {
            expect(dep.canUpdate).toBe(true);
        }
        vi.resetModules();
    });

    it('reports canUpdate=true with no launcher present — extraction is in-process', async () => {
        // Previously nodejs and adb reported canUpdate=false whenever the packaged
        // launcher was missing, which is every source checkout: the dependency
        // panel's update buttons were dead in dev on all three platforms. Nothing
        // consults the launcher any more, so the absence of one changes nothing.
        vi.resetModules();
        vi.doMock('../service/elevatedRunner', () => ({
            launcherIsAvailable: async () => false,
            resolveLauncherPath: () => '/fake/launcher.exe',
        }));
        const { DependencyManager: Mgr } = await import('../DependencyManager');
        const mgr = new Mgr('/tmp/test-deps-canupdate-no');
        const byName = Object.fromEntries((await mgr.getAll()).map((d) => [d.name, d]));
        expect(byName['nodejs']?.canUpdate).toBe(true);
        expect(byName['adb']?.canUpdate).toBe(true);
        expect(byName['scrcpy-server']?.canUpdate).toBe(true);
        vi.resetModules();
    });
});

describe('DependencyManager.requestRestart', () => {
    let tmpDir: string;
    let exitSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dm-'));
        exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit:${code}`);
        }) as never);
    });

    afterEach(() => {
        exitSpy.mockRestore();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes marker at the configured restartMarkerPath (decoupled from depsPath)', () => {
        // Constructor opts let callers route the marker anywhere — production
        // (index.ts) routes to <dataRoot>/.restart so the launcher's read at
        // paths.rs:70 finds it. Pre-fix, the marker was implicitly at
        // depsPath/.restart and the launcher never found it.
        const altMarkerPath = path.join(path.dirname(tmpDir), 'parent-side-marker');
        const mgr = new DependencyManager(tmpDir, { restartMarkerPath: altMarkerPath });
        expect(() => mgr.requestRestart()).toThrow(/exit:/);
        expect(fs.existsSync(altMarkerPath)).toBe(true);
        expect(fs.existsSync(path.join(tmpDir, '.restart'))).toBe(false);
    });

    it('default restartMarkerPath falls back to depsPath/.restart when no opts provided', () => {
        // Preserves pre-Phase-1 behavior for tests / callers that don't care.
        const mgr = new DependencyManager(tmpDir);
        expect(() => mgr.requestRestart()).toThrow(/exit:/);
        expect(fs.existsSync(path.join(tmpDir, '.restart'))).toBe(true);
    });

    it('exits with code 75', () => {
        const mgr = new DependencyManager(tmpDir);
        expect(() => mgr.requestRestart()).toThrow('exit:75');
    });

    it('marker body contains a timestamp marker', () => {
        const mgr = new DependencyManager(tmpDir);
        try {
            mgr.requestRestart();
        } catch {
            /* expected */
        }
        const body = fs.readFileSync(path.join(tmpDir, '.restart'), 'utf-8');
        expect(body).toMatch(/^restart-requested-\d+$/);
    });
});

describe('DependencyManager.update("mkcert") — checksum verification (I8)', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    let tmpDepsDir: string;
    const version = 'v1.4.4-bt.2';
    const FAKE_BINARY = 'not-a-real-mkcert-binary-but-deterministic-bytes';
    const assetName = mkcertAssetName(version);

    beforeEach(() => {
        tmpDepsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dm-mkcert-'));
    });

    afterEach(() => {
        fetchSpy?.mockRestore();
        fs.rmSync(tmpDepsDir, { recursive: true, force: true });
    });

    function mockFetch(checksumManifest: string) {
        fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.endsWith('SHA256SUMS.txt')) {
                return new Response(checksumManifest, { status: 200 });
            }
            return new Response(FAKE_BINARY, { status: 200 });
        });
    }

    it('installs on a matching hash, and refuses (leaving nothing installed) on a mismatch — contrast pair', async () => {
        const correctHash = createHash('sha256').update(FAKE_BINARY).digest('hex');
        const destFile = path.join(tmpDepsDir, 'mkcert', mkcertExeName());
        const mgr = new DependencyManager(tmpDepsDir);

        // --- matching checksum: installs ---
        mockFetch(`${correctHash}  ${assetName}\n`);
        mgr.getByName('mkcert')!.latestVersion = version;
        const okResult = await mgr.update('mkcert');
        expect(okResult.success).toBe(true);
        expect(fs.existsSync(destFile)).toBe(true);
        expect(fs.readFileSync(destFile, 'utf-8')).toBe(FAKE_BINARY);

        // --- mismatching checksum: refuses, and does NOT leave the old
        // (verified) install in place tampered -- re-download a WRONG
        // binary under a manifest that still claims the correct hash.
        fs.rmSync(destFile, { force: true });
        const wrongHash = '0'.repeat(64);
        mockFetch(`${wrongHash}  ${assetName}\n`);
        mgr.getByName('mkcert')!.latestVersion = version;
        const badResult = await mgr.update('mkcert');
        expect(badResult.success).toBe(false);
        expect(badResult.errorMessage).toMatch(/checksum mismatch/i);
        expect(fs.existsSync(destFile)).toBe(false);
    });

    it('refuses when the manifest does not list the downloaded asset at all', async () => {
        mockFetch(`${'a'.repeat(64)}  some-other-platform-asset\n`);
        const mgr = new DependencyManager(tmpDepsDir);
        mgr.getByName('mkcert')!.latestVersion = version;
        const result = await mgr.update('mkcert');
        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/does not list/i);
        expect(fs.existsSync(path.join(tmpDepsDir, 'mkcert', mkcertExeName()))).toBe(false);
    });

    it('refuses when the checksum manifest itself cannot be fetched', async () => {
        fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.endsWith('SHA256SUMS.txt')) {
                return new Response('not found', { status: 404 });
            }
            return new Response(FAKE_BINARY, { status: 200 });
        });
        const mgr = new DependencyManager(tmpDepsDir);
        mgr.getByName('mkcert')!.latestVersion = version;
        const result = await mgr.update('mkcert');
        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/checksum manifest fetch failed/i);
    });

    it('two concurrent installs of the SAME dependency both succeed rather than one seeing a spurious mismatch (N7)', async () => {
        // An end-to-end demonstration on top of the deterministic
        // makeUpdateTmpDir unit tests below: real concurrent update() calls
        // for the same name, both against a matching checksum, must BOTH
        // succeed. A tmpDir collision would make (at least) one of them race
        // the other's `using`-scoped cleanup and fail with a spurious
        // "checksum mismatch".
        const correctHash = createHash('sha256').update(FAKE_BINARY).digest('hex');
        mockFetch(`${correctHash}  ${assetName}\n`);
        const mgr = new DependencyManager(tmpDepsDir);
        mgr.getByName('mkcert')!.latestVersion = version;

        const [first, second] = await Promise.all([mgr.update('mkcert'), mgr.update('mkcert')]);

        expect(first.success).toBe(true);
        expect(second.success).toBe(true);
    });
});

describe('makeUpdateTmpDir (N7)', () => {
    it('never produces the same path twice for the same name, even called back-to-back synchronously', () => {
        // The historical bug was keying this on Date.now() alone, which two
        // calls landing in the same millisecond (Node's clock resolution is
        // coarser than its event loop) could produce identically. Calling it
        // twice with nothing in between is the deterministic version of that
        // race -- no reliance on real timing luck to reproduce it.
        const a = makeUpdateTmpDir('mkcert');
        const b = makeUpdateTmpDir('mkcert');
        expect(a).not.toBe(b);
    });

    it('still contains the dependency name, for a diagnosable path', () => {
        expect(makeUpdateTmpDir('mkcert')).toContain('update-mkcert-');
    });
});

describe('DependencyManager.autoInstallMissing — mkcert defers to first use (M2)', () => {
    it('installs adb (a normal boot-time dependency) but SKIPS mkcert even though both equally qualify', async () => {
        // Contrast pair: both entries start with installedVersion: null and a
        // known latestVersion, so both would normally be installed. Only
        // mkcert's `deferInstall` should hold it back -- a mutation that
        // removes the skip, or applies it to the wrong dependency, fails one
        // half of this assertion or the other.
        const mgr = new DependencyManager('/tmp/test-deps-autoinstall-defer');
        mgr.getByName('adb')!.latestVersion = '34.0.0';
        mgr.getByName('mkcert')!.latestVersion = 'v1.4.4-bt.2';

        const updateSpy = vi
            .spyOn(mgr, 'update')
            .mockResolvedValue({ success: true, newVersion: 'x', requiresRestart: false });

        await mgr.autoInstallMissing();

        expect(updateSpy).toHaveBeenCalledWith('adb');
        expect(updateSpy).not.toHaveBeenCalledWith('mkcert');
        updateSpy.mockRestore();
    });
});

describe('getDependencyManager (composition-root singleton)', () => {
    // Order matters within this describe block: both tests share the SAME
    // module-scoped singleton (there is no reset hook, deliberately -- a
    // reset would defeat the point of a composition-root singleton). The
    // first test's call is what seeds it for the second.
    it('returns the SAME instance across calls with the SAME config, so boot and an on-demand mkcert install share one state', () => {
        const opts = { dependenciesPath: '/tmp/test-deps-singleton-same' };
        const a = getDependencyManager(opts);
        const b = getDependencyManager(opts);
        expect(b).toBe(a);
    });

    it('throws on a mismatched second call rather than silently handing back a manager configured for someone else (N6)', () => {
        // The singleton is already seeded (with '/tmp/test-deps-singleton-same'
        // from the test above) by the time this runs -- a DIFFERENT
        // dependenciesPath here must be refused, not silently accepted.
        expect(() => getDependencyManager({ dependenciesPath: '/tmp/test-deps-singleton-DIFFERENT' })).toThrow();
    });
});

describe('DependencyManager resolveStatus — never auto-downgrade', () => {
    it('keeps UpToDate when installed version is newer than latest filtered', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const info = mgr.getByName('nodejs')!;
        info.installedVersion = '26.0.0';
        info.latestVersion = '24.14.1';
        // @ts-expect-error — invoke private method for unit test
        mgr.resolveStatus(info);
        expect(info.status).toBe(DependencyStatus.UpToDate);
    });

    it('produces UpdateAvailable when installed is older than latest', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const info = mgr.getByName('nodejs')!;
        info.installedVersion = '22.11.0';
        info.latestVersion = '24.14.1';
        // @ts-expect-error — invoke private method for unit test
        mgr.resolveStatus(info);
        expect(info.status).toBe(DependencyStatus.UpdateAvailable);
    });

    it('produces UpToDate when versions are equal', () => {
        const mgr = new DependencyManager('/tmp/test-deps');
        const info = mgr.getByName('nodejs')!;
        info.installedVersion = '24.14.1';
        info.latestVersion = '24.14.1';
        // @ts-expect-error — invoke private method for unit test
        mgr.resolveStatus(info);
        expect(info.status).toBe(DependencyStatus.UpToDate);
    });
});
