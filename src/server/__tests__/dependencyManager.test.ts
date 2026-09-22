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

describe('DependencyManager.update("mkcert") — checksum verification, manifest pinned (I8)', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;
    let tmpDepsDir: string;
    const version = 'v1.4.4-bt.2';
    const FAKE_BINARY = 'not-a-real-mkcert-binary-but-deterministic-bytes';
    const assetName = mkcertAssetName(version);

    beforeEach(() => {
        tmpDepsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-dm-mkcert-'));
    });

    afterEach(async () => {
        fetchSpy?.mockRestore();
        fs.rmSync(tmpDepsDir, { recursive: true, force: true });
        vi.resetModules();
    });

    /** Mocks fetch: the manifest URL returns `checksumManifest`, everything
     * else (the binary asset) returns `assetBody`. Tracks asset-URL fetches
     * via `onAssetFetch`, so a test can assert the binary was never even
     * requested. */
    function mockFetch(checksumManifest: string, assetBody = FAKE_BINARY, onAssetFetch?: (url: string) => void) {
        fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async (input: string | URL | Request) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.endsWith('SHA256SUMS.txt')) {
                return new Response(checksumManifest, { status: 200 });
            }
            onAssetFetch?.(url);
            return new Response(assetBody, { status: 200 });
        });
    }

    /**
     * MKCERT_SHA256SUMS_PIN is a fixed constant in production -- these tests
     * need a DIFFERENT expected value per scenario (a manifest that lists a
     * correct binary digest, one that lists a wrong one, one deliberately
     * mismatching its own pin). Vitest can't spy a plain exported const, so
     * this re-imports DependencyManager fresh with DependencyDefinitions'
     * pin overridden -- the same dynamic-remock pattern this file already
     * uses for `elevatedRunner` above. Defaults to the manifest's OWN real
     * hash (pin passes); `pinOverride` forces a specific -- possibly
     * deliberately wrong -- value instead.
     */
    async function makeMgrWithPinnedManifest(
        depsDir: string,
        manifest: string,
        opts: { pinOverride?: string } = {},
    ): Promise<DependencyManager> {
        const pin = opts.pinOverride ?? createHash('sha256').update(manifest).digest('hex');
        vi.resetModules();
        vi.doMock('../DependencyDefinitions', async (importOriginal) => {
            const actual = await importOriginal<typeof import('../DependencyDefinitions')>();
            return { ...actual, MKCERT_SHA256SUMS_PIN: pin };
        });
        const { DependencyManager: Mgr } = await import('../DependencyManager');
        return new Mgr(depsDir);
    }

    it('installs on a matching hash, and refuses (leaving nothing installed) on a mismatch — contrast pair', async () => {
        const correctHash = createHash('sha256').update(FAKE_BINARY).digest('hex');
        const destFile = path.join(tmpDepsDir, 'mkcert', mkcertExeName());

        // --- matching checksum: installs ---
        const okManifest = `${correctHash}  ${assetName}\n`;
        mockFetch(okManifest);
        const mgr = await makeMgrWithPinnedManifest(tmpDepsDir, okManifest);
        mgr.getByName('mkcert')!.latestVersion = version;
        const okResult = await mgr.update('mkcert');
        expect(okResult.success).toBe(true);
        expect(fs.existsSync(destFile)).toBe(true);
        expect(fs.readFileSync(destFile, 'utf-8')).toBe(FAKE_BINARY);

        // --- mismatching checksum: refuses, and does NOT leave the old
        // (verified) install in place tampered -- re-download a WRONG
        // binary under a (pin-trusted) manifest that still claims the
        // correct hash for it.
        fs.rmSync(destFile, { force: true });
        const wrongHash = '0'.repeat(64);
        const badManifest = `${wrongHash}  ${assetName}\n`;
        mockFetch(badManifest);
        const mgr2 = await makeMgrWithPinnedManifest(tmpDepsDir, badManifest);
        mgr2.getByName('mkcert')!.latestVersion = version;
        const badResult = await mgr2.update('mkcert');
        expect(badResult.success).toBe(false);
        expect(badResult.errorMessage).toMatch(/checksum mismatch/i);
        expect(fs.existsSync(destFile)).toBe(false);
    });

    it('refuses when the (pin-trusted) manifest does not list the downloaded asset at all', async () => {
        const manifest = `${'a'.repeat(64)}  some-other-platform-asset\n`;
        mockFetch(manifest);
        const mgr = await makeMgrWithPinnedManifest(tmpDepsDir, manifest);
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

    it('refuses a manifest that fails the pin check BEFORE the binary is ever fetched -- "no download of anything else"', async () => {
        // The manifest text itself is well-formed (a real digest, a real
        // asset name) -- what fails is the manifest's OWN hash against a
        // deliberately wrong pin, which is exactly the "release changed
        // under us, or the pin is stale" case, distinct from a bad binary
        // download.
        const manifest = `${'1'.repeat(64)}  ${assetName}\n`;
        const assetFetches: string[] = [];
        mockFetch(manifest, FAKE_BINARY, (url) => assetFetches.push(url));
        const mgr = await makeMgrWithPinnedManifest(tmpDepsDir, manifest, { pinOverride: 'f'.repeat(64) });
        mgr.getByName('mkcert')!.latestVersion = version;

        const result = await mgr.update('mkcert');

        expect(result.success).toBe(false);
        expect(result.errorMessage).toMatch(/does not match the pinned digest/i);
        // Not just "it threw" -- the binary asset URL must never have been
        // requested at all.
        expect(assetFetches).toEqual([]);
        expect(fs.existsSync(path.join(tmpDepsDir, 'mkcert', mkcertExeName()))).toBe(false);
    });

    it('two concurrent installs of the SAME dependency both succeed rather than one seeing a spurious mismatch (N7)', async () => {
        // An end-to-end demonstration on top of the deterministic
        // makeUpdateTmpDir unit tests below: real concurrent update() calls
        // for the same name, both against a matching checksum, must BOTH
        // succeed. A tmpDir collision would make (at least) one of them race
        // the other's `using`-scoped cleanup and fail with a spurious
        // "checksum mismatch".
        const correctHash = createHash('sha256').update(FAKE_BINARY).digest('hex');
        const manifest = `${correctHash}  ${assetName}\n`;
        mockFetch(manifest);
        const mgr = await makeMgrWithPinnedManifest(tmpDepsDir, manifest);
        mgr.getByName('mkcert')!.latestVersion = version;

        const [first, second] = await Promise.all([mgr.update('mkcert'), mgr.update('mkcert')]);

        expect(first.success).toBe(true);
        expect(second.success).toBe(true);
    });

    // NF-5: N7 above proves both callers succeed; it does NOT prove only one
    // install ran. Distinct tmpDirs removed the spurious mismatch but left
    // both callers writing the same destination, which on Windows can still
    // EPERM in `renameSync`. Counting asset fetches is what distinguishes
    // "both succeeded" from "both succeeded because only one of them did the
    // work" -- the assertion N7 structurally cannot make.
    it('coalesces two concurrent updates of the same name into a single install (NF-5)', async () => {
        const correctHash = createHash('sha256').update(FAKE_BINARY).digest('hex');
        const manifest = `${correctHash}  ${assetName}\n`;
        const assetFetches: string[] = [];
        mockFetch(manifest, FAKE_BINARY, (url) => assetFetches.push(url));
        const mgr = await makeMgrWithPinnedManifest(tmpDepsDir, manifest);
        mgr.getByName('mkcert')!.latestVersion = version;

        const [first, second] = await Promise.all([mgr.update('mkcert'), mgr.update('mkcert')]);

        expect(first.success).toBe(true);
        expect(second.success).toBe(true);
        expect(assetFetches).toHaveLength(1);
    });

    // The other half of the contract: coalescing must not turn one failure
    // into a permanently poisoned name. The map entry is cleared in a
    // `finally`, so a retry after a failed install does real work again --
    // without this, a single transient network error would make the
    // dependency uninstallable until restart.
    it('does not poison the name after a failed install -- a retry installs for real (NF-5)', async () => {
        const correctHash = createHash('sha256').update(FAKE_BINARY).digest('hex');
        const manifest = `${correctHash}  ${assetName}\n`;

        const bad = await makeMgrWithPinnedManifest(tmpDepsDir, manifest, { pinOverride: 'f'.repeat(64) });
        mockFetch(manifest);
        bad.getByName('mkcert')!.latestVersion = version;
        const failed = await bad.update('mkcert');
        expect(failed.success).toBe(false);

        const assetFetches: string[] = [];
        mockFetch(manifest, FAKE_BINARY, (url) => assetFetches.push(url));
        const good = await makeMgrWithPinnedManifest(tmpDepsDir, manifest);
        good.getByName('mkcert')!.latestVersion = version;
        const retried = await good.update('mkcert');

        expect(retried.success).toBe(true);
        expect(assetFetches).toHaveLength(1);
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

describe('DependencyManager — deferInstall reaches the wire', () => {
    /**
     * `deferInstall` lived only on the server-side definition, so
     * `/api/dependencies` never carried it and the client could not tell "not
     * installed because something failed" from "not installed because nothing
     * has needed it yet". FirstRunBanner keys on exactly that difference, and
     * without this it raised a permanent setup-incomplete warning naming
     * mkcert. A flag that stops at the server boundary is invisible to the code
     * that needs it.
     */
    it('publishes deferInstall on the DependencyInfo the client receives', () => {
        const mgr = new DependencyManager('/tmp/test-deps-defer-wire');
        expect(mgr.getByName('mkcert')?.deferInstall).toBe(true);
        // The contrast half: a boot-time dependency must NOT carry it, or the
        // banner would stop reporting genuine first-run failures.
        expect(mgr.getByName('adb')?.deferInstall).toBeUndefined();
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
    // NF-4: this was two tests sharing the module-scoped singleton, where the
    // first test's call was what seeded the second. Deterministic under
    // Vitest's in-file ordering, but it FAILED (rather than skipped) if the
    // order ever changed or a `.only` landed on the second one -- an unusual
    // thing to debug, since the failure names the assertion and not the
    // missing precondition. `getDependencyManager` has no reset seam on
    // purpose (a reset would defeat a composition-root singleton), so the
    // robust form is one test that establishes the state it depends on.
    it('returns one instance per config and refuses a mismatched second call (N6)', () => {
        const opts = { dependenciesPath: '/tmp/test-deps-singleton-same' };

        // Same config twice: boot and an on-demand mkcert install must share
        // one state, or each would keep its own view of what is installed.
        const a = getDependencyManager(opts);
        const b = getDependencyManager(opts);
        expect(b).toBe(a);

        // A DIFFERENT dependenciesPath against the now-seeded singleton must
        // be refused, not silently handed a manager configured for someone
        // else. Seeded by THIS test's own calls above, not by a neighbour's.
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
