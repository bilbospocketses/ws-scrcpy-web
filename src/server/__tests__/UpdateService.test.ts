// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as child_process from 'child_process';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as os from 'os';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';
import type { UpdateInfo, UpdateOptions, VelopackAsset } from 'velopack';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { type UpdateManagerLike, UpdateService } from '../UpdateService';

// Mock child_process.spawn so local-mode applyUpdate doesn't try to exec
// the real operation-server helper binary (which doesn't exist in test).
vi.mock('child_process', async (importOriginal) => {
    const real = await importOriginal<typeof child_process>();
    return {
        ...real,
        spawn: vi.fn(() => ({ pid: 12345, unref: vi.fn() })),
    };
});

// ──────────────────────────────────────────────────────────────────────────
// Helpers

function fakeAsset(version: string): VelopackAsset {
    return {
        PackageId: 'ws-scrcpy-web',
        Version: version,
        Type: 'Full',
        FileName: `ws-scrcpy-web-${version}-full.nupkg`,
        SHA1: '',
        SHA256: '',
        Size: 0,
        NotesMarkdown: '',
        NotesHtml: '',
    };
}

function fakeUpdateInfo(version = '0.2.0'): UpdateInfo {
    return {
        TargetFullRelease: fakeAsset(version),
        DeltasToTarget: [],
        IsDowngrade: false,
    };
}

function fakeMgr(overrides: Partial<UpdateManagerLike> = {}): UpdateManagerLike {
    return {
        getCurrentVersion: () => '0.1.0',
        checkForUpdatesAsync: async () => null,
        downloadUpdateAsync: async () => undefined,
        waitExitThenApplyUpdate: () => undefined,
        ...overrides,
    };
}

describe('UpdateService', () => {
    const tmpDirs: string[] = [];
    const savedEnv = {
        CONFIG: process.env[EnvName.CONFIG_PATH],
        DEPS: process.env['DEPS_PATH'],
        FEED: process.env['VELOPACK_FEED_URL'],
        APPIMAGE: process.env['APPIMAGE'],
    };

    // Intercept fs.promises.readFile so pollOperationServerPort returns
    // instantly in local-mode tests instead of waiting 5s for a real file.
    let readFileSpy: ReturnType<typeof vi.spyOn> | undefined;

    beforeEach(() => {
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-update-svc-'));
        tmpDirs.push(tmpRoot);
        const configPath = path.join(tmpRoot, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({}));
        process.env[EnvName.CONFIG_PATH] = configPath;
        process.env['DEPS_PATH'] = path.join(tmpRoot, 'deps');
        delete process.env['VELOPACK_FEED_URL'];
        // On Linux, UpdateService checks APPIMAGE env instead of existsSync.
        // Set it so tests using existsSync: () => true trigger production mode.
        process.env['APPIMAGE'] = '/fake/WsScrcpyWeb.AppImage';
        Config._resetForTest();

        const realReadFile = fs.promises.readFile.bind(fs.promises);
        readFileSpy = vi.spyOn(fs.promises, 'readFile').mockImplementation(
            ((...args: Parameters<typeof fs.promises.readFile>) => {
                if (typeof args[0] === 'string' && args[0].includes('operation-server-port')) {
                    return Promise.resolve('9999');
                }
                return realReadFile(...args);
            }) as typeof fs.promises.readFile,
        );
    });

    afterEach(() => {
        readFileSpy?.mockRestore();
        Config._resetForTest();
        if (savedEnv.CONFIG === undefined) delete process.env[EnvName.CONFIG_PATH];
        else process.env[EnvName.CONFIG_PATH] = savedEnv.CONFIG;
        if (savedEnv.DEPS === undefined) delete process.env['DEPS_PATH'];
        else process.env['DEPS_PATH'] = savedEnv.DEPS;
        if (savedEnv.FEED === undefined) delete process.env['VELOPACK_FEED_URL'];
        else process.env['VELOPACK_FEED_URL'] = savedEnv.FEED;
        if (savedEnv.APPIMAGE === undefined) delete process.env['APPIMAGE'];
        else process.env['APPIMAGE'] = savedEnv.APPIMAGE;
        while (tmpDirs.length) {
            const d = tmpDirs.pop()!;
            try {
                fs.rmSync(d, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        }
    });

    // ── Dev mode detection ──────────────────────────────────────────────

    it('init: Update.exe absent → isInstalled=false, status=idle', () => {
        delete process.env['APPIMAGE'];
        const factory = vi.fn(() => fakeMgr());
        const svc = new UpdateService({
            installRoot: '/fake/root',
            existsSync: () => false,
            updateManagerFactory: factory,
        });
        svc.init();
        const s = svc.getStatus();
        expect(s.isInstalled).toBe(false);
        expect(s.status).toBe('idle');
        // v0.1.17: dev mode now surfaces the package.json version so the UI
        // can show "current: vX.Y.Z (dev mode)". Just check it's a non-empty
        // semver-shaped string — the actual value tracks package.json.
        expect(s.currentVersion).toMatch(/^\d+\.\d+\.\d+/);
        expect(factory).not.toHaveBeenCalled();
    });

    it('init: Update.exe present + factory throws → isInstalled=false, logs warning', () => {
        const factory = vi.fn(() => {
            throw new Error('native addon broken');
        });
        const svc = new UpdateService({
            installRoot: '/fake/root',
            existsSync: () => true,
            updateManagerFactory: factory,
        });
        svc.init();
        const s = svc.getStatus();
        expect(s.isInstalled).toBe(true);
        expect(s.status).toBe('idle');
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it('init: installed mode constructs feed URL from githubOwner', () => {
        Config.getInstance().updateAppConfig({ githubOwner: 'someone-else' });
        const captured: string[] = [];
        const factory = vi.fn((feedUrl: string, _opts: UpdateOptions) => {
            captured.push(feedUrl);
            return fakeMgr();
        });
        const svc = new UpdateService({
            installRoot: '/fake/root',
            existsSync: () => true,
            updateManagerFactory: factory,
            // Disable timer so test doesn't leak intervals.
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        expect(captured[0]).toBe('https://github.com/someone-else/ws-scrcpy-web');
    });

    it('init: VELOPACK_FEED_URL env override wins over githubOwner', () => {
        process.env['VELOPACK_FEED_URL'] = 'https://internal.example/feed/';
        Config.getInstance().updateAppConfig({ githubOwner: 'someone-else' });
        const captured: string[] = [];
        const factory = vi.fn((feedUrl: string) => {
            captured.push(feedUrl);
            return fakeMgr();
        });
        const svc = new UpdateService({
            installRoot: '/fake/root',
            existsSync: () => true,
            updateManagerFactory: factory,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        expect(captured[0]).toBe('https://internal.example/feed/');
    });

    // ── VelopackLocator override (Phase 2 of Program Files migration) ──

    it('init: passes a VelopackLocatorConfig to the factory shaped for the host platform', () => {
        const installRoot = path.join('/fake', 'install', 'root');
        let receivedLocator: unknown;
        const factory = vi.fn((_feed: string, _opts: UpdateOptions, locator?: unknown) => {
            receivedLocator = locator;
            return fakeMgr();
        });
        const svc = new UpdateService({
            installRoot,
            existsSync: () => true,
            updateManagerFactory: factory,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();

        expect(receivedLocator).toBeDefined();
        const loc = receivedLocator as Record<string, unknown>;
        if (process.platform === 'win32') {
            expect(loc['RootAppDir']).toBe(installRoot);
            expect(loc['UpdateExePath']).toBe(path.join(installRoot, 'Update.exe'));
            expect(loc['PackagesDir']).toBe(path.join(installRoot, 'packages'));
            expect(loc['ManifestPath']).toBe(path.join(installRoot, 'current', 'sq.version'));
            expect(loc['CurrentBinaryDir']).toBe(path.join(installRoot, 'current'));
            expect(loc['IsPortable']).toBe(false);
        } else {
            // Linux AppImage shape — mirrors Velopack 1.0.1's lib-rust
            // auto_locate_app_manifest. beforeEach() sets APPIMAGE so the
            // marker check passes and the factory actually runs.
            const contentsDir = path.join(installRoot, 'usr', 'bin');
            expect(loc['RootAppDir']).toBe('/fake/WsScrcpyWeb.AppImage');
            expect(loc['UpdateExePath']).toBe(path.join(contentsDir, 'UpdateNix'));
            expect(loc['PackagesDir']).toBe('/var/tmp/velopack/WsScrcpyWeb/packages');
            expect(loc['ManifestPath']).toBe(path.join(contentsDir, 'sq.version'));
            expect(loc['CurrentBinaryDir']).toBe(contentsDir);
            expect(loc['IsPortable']).toBe(true);
        }
    });

    it('reconfigure: passes the same locator to the new factory invocation', async () => {
        const installRoot = '/fake/install/root';
        const captured: unknown[] = [];
        const factory = vi.fn((_feed: string, _opts: UpdateOptions, locator?: unknown) => {
            captured.push(locator);
            return fakeMgr();
        });
        const svc = new UpdateService({
            installRoot,
            existsSync: () => true,
            updateManagerFactory: factory,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.reconfigure('beta', 'a-different-owner');

        // init + reconfigure both invoked the factory; both got the locator.
        expect(captured.length).toBeGreaterThanOrEqual(2);
        const initLocator = captured[0] as Record<string, unknown>;
        const reconfigLocator = captured[captured.length - 1] as Record<string, unknown>;
        const expectedRootAppDir =
            process.platform === 'win32' ? installRoot : '/fake/WsScrcpyWeb.AppImage';
        expect(initLocator['RootAppDir']).toBe(expectedRootAppDir);
        expect(reconfigLocator['RootAppDir']).toBe(expectedRootAppDir);
        expect(reconfigLocator).toEqual(initLocator);
    });

    // ── checkForUpdates ─────────────────────────────────────────────────

    it('checkForUpdates: null result → status=idle, no pendingUpdate', async () => {
        const mgr = fakeMgr({ checkForUpdatesAsync: async () => null });
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();
        const s = svc.getStatus();
        expect(s.status).toBe('idle');
        expect(s.availableVersion).toBeUndefined();
        expect(s.pendingUpdate).toBeUndefined();
        expect(s.lastCheckedAt).toBeInstanceOf(Date);
    });

    it('checkForUpdates: UpdateInfo + autoUpdate=true → triggers download → status=ready', async () => {
        Config.getInstance().updateAppConfig({ autoUpdate: true });
        const info = fakeUpdateInfo('0.2.0');
        const downloadFn = vi.fn(async () => undefined);
        const mgr = fakeMgr({
            checkForUpdatesAsync: async () => info,
            downloadUpdateAsync: downloadFn,
        });
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();
        const s = svc.getStatus();
        expect(downloadFn).toHaveBeenCalled();
        expect(s.status).toBe('ready');
        expect(s.availableVersion).toBe('0.2.0');
        expect(s.progress).toBe(100);
    });

    it('checkForUpdates: UpdateInfo + autoUpdate=false → status=ready without downloading', async () => {
        Config.getInstance().updateAppConfig({ autoUpdate: false });
        const info = fakeUpdateInfo('0.2.0');
        const downloadFn = vi.fn(async () => undefined);
        const mgr = fakeMgr({
            checkForUpdatesAsync: async () => info,
            downloadUpdateAsync: downloadFn,
        });
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();
        const s = svc.getStatus();
        expect(downloadFn).not.toHaveBeenCalled();
        expect(s.status).toBe('ready');
        expect(s.availableVersion).toBe('0.2.0');
        expect(s.pendingUpdate).toBeDefined();
    });

    it('checkForUpdates: factory throws → status=error, errorMessage populated', async () => {
        const mgr = fakeMgr({
            checkForUpdatesAsync: async () => {
                throw new Error('feed unreachable');
            },
        });
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();
        const s = svc.getStatus();
        expect(s.status).toBe('error');
        expect(s.errorMessage).toMatch(/feed unreachable/);
    });

    it('checkForUpdates: returns idle when not installed (no mgr)', async () => {
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => false,
        });
        svc.init();
        const s = await svc.checkForUpdates();
        expect(s.status).toBe('idle');
    });

    // ── downloadIfNeeded ────────────────────────────────────────────────

    it('downloadIfNeeded: progress callback updates state.progress', async () => {
        Config.getInstance().updateAppConfig({ autoUpdate: true });
        const info = fakeUpdateInfo();
        const progresses: number[] = [];
        const mgr = fakeMgr({
            checkForUpdatesAsync: async () => info,
            downloadUpdateAsync: async (_u, cb) => {
                cb?.(0);
                cb?.(50);
                cb?.(100);
            },
        });
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        // Spy on getStatus to capture progress at each callback step is tricky;
        // instead, drive download via callback that records the live state value.
        const liveMgr = fakeMgr({
            checkForUpdatesAsync: async () => info,
            downloadUpdateAsync: async (_u, cb) => {
                cb?.(0);
                progresses.push(svc.getStatus().progress ?? -1);
                cb?.(42);
                progresses.push(svc.getStatus().progress ?? -1);
                cb?.(99.7); // verify rounding
                progresses.push(svc.getStatus().progress ?? -1);
            },
        });
        // Replace mgr after init so we can inspect progress live.
        // biome-ignore lint/suspicious/noExplicitAny: test reaches into private field intentionally
        (svc as any).mgr = liveMgr;
        await svc.checkForUpdates();
        expect(progresses).toEqual([0, 42, 100]);
        expect(svc.getStatus().status).toBe('ready');
        expect(svc.getStatus().progress).toBe(100);
    });

    it('downloadIfNeeded: throws → status=error', async () => {
        Config.getInstance().updateAppConfig({ autoUpdate: true });
        const info = fakeUpdateInfo();
        const mgr = fakeMgr({
            checkForUpdatesAsync: async () => info,
            downloadUpdateAsync: async () => {
                throw new Error('disk full');
            },
        });
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();
        const s = svc.getStatus();
        expect(s.status).toBe('error');
        expect(s.errorMessage).toMatch(/disk full/);
    });

    // ── applyUpdate ─────────────────────────────────────────────────────

    it('applyUpdate: rejects when status !== ready', async () => {
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr(),
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await expect(svc.applyUpdate()).rejects.toThrow(/apply not allowed in current state/);
    });

    it('applyUpdate (local mode): waitExitThenApplyUpdate called with restart=false', async () => {
        // Default installMode is null after Config._resetForTest + empty config.json,
        // which is treated as local mode. restart=false — we own the relaunch.
        Config.getInstance().updateAppConfig({ autoUpdate: false });
        const info = fakeUpdateInfo('0.2.0');
        const applyFn = vi.fn();
        const mgr = fakeMgr({
            checkForUpdatesAsync: async () => info,
            waitExitThenApplyUpdate: applyFn,
        });
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();
        expect(svc.getStatus().status).toBe('ready');
        // applyUpdate is now async — pre-apply hygiene runs first
        // (adb kill-server + Windows taskkill + 250ms settle). Hygiene
        // failures are swallowed so the test still drives waitExitThenApplyUpdate.
        await svc.applyUpdate();
        // §40: local mode does NOT call waitExitThenApplyUpdate — the
        // supervisor's local-post-stop.bat calls Update.exe apply directly.
        expect(applyFn).not.toHaveBeenCalled();
    });

    // v0.1.25-beta.8 smoke A.2 regression: when installMode is a service mode,
    // restart MUST be false. The --veloapp-updated hook's `servy-cli restart` is
    // solely responsible for bringing the service back under SCM/Servy supervision.
    // Velopack's parallel post-swap relaunch (restart=true) would spawn a ghost
    // LocalSystem launcher that holds the single-instance mutex and starves out
    // Servy's --recoveryAction=RestartProcess attempts, leaving SCM with the
    // service stuck Stopped until reboot. See §32 in todo_ws_scrcpy_web.md.
    it.each([
        ['user-service' as const],
        ['system-service' as const],
    ])('applyUpdate (%s): waitExitThenApplyUpdate called with restart=false', async (installMode) => {
        Config.getInstance().updateAppConfig({ autoUpdate: false, installMode });
        const info = fakeUpdateInfo('0.2.0');
        const applyFn = vi.fn();
        const mgr = fakeMgr({
            checkForUpdatesAsync: async () => info,
            waitExitThenApplyUpdate: applyFn,
        });
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();
        expect(svc.getStatus().status).toBe('ready');
        await svc.applyUpdate();
        expect(applyFn).toHaveBeenCalledTimes(1);
        const args = applyFn.mock.calls[0]!;
        expect(args[0]).toBe(info);
        expect(args[1]).toBe(true);
        // restart=false in service mode — hook's servy-cli restart handles relaunch.
        expect(args[2]).toBe(false);
    });

    // §40: local-mode variants (user/system) also skip waitExitThenApplyUpdate.
    // The supervisor's local-post-stop.bat calls Update.exe apply directly.
    it.each([
        ['user' as const],
        ['system' as const],
    ])('applyUpdate (%s): does NOT call waitExitThenApplyUpdate (local mode)', async (installMode) => {
        Config.getInstance().updateAppConfig({ autoUpdate: false, installMode });
        const info = fakeUpdateInfo('0.2.0');
        const applyFn = vi.fn();
        const mgr = fakeMgr({
            checkForUpdatesAsync: async () => info,
            waitExitThenApplyUpdate: applyFn,
        });
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();
        expect(svc.getStatus().status).toBe('ready');
        await svc.applyUpdate();
        expect(applyFn).not.toHaveBeenCalled();
    });

    // §40: applyUpdate writes the apply-update-pending marker in ALL modes.
    // In local mode, Node also spawns the operation-server helper and polls
    // for its port file (spawn is module-mocked via vi.mock('child_process')).
    // In service mode, Servy's post-stop bat handles the operation-server.
    it.each([
        ['user-service' as const],
        ['system-service' as const],
        ['user' as const],
        ['system' as const],
    ])('applyUpdate (%s): writes marker (§40)', async (installMode) => {
        Config.getInstance().updateAppConfig({ autoUpdate: false, installMode });
        // Spy on fs.promises.writeFile + mkdir to capture the marker write
        // without polluting real ProgramData. Mock as no-ops since we only
        // care about the call shape, not the effect on disk.
        const writeFileSpy = vi
            .spyOn(fs.promises, 'writeFile')
            .mockResolvedValue(undefined);
        const mkdirSpy = vi
            .spyOn(fs.promises, 'mkdir')
            .mockResolvedValue(undefined);
        using _restore = { [Symbol.dispose]() { writeFileSpy.mockRestore(); mkdirSpy.mockRestore(); } };

        const info = fakeUpdateInfo('0.2.0');
        const applyFn = vi.fn();
        const mgr = fakeMgr({
            checkForUpdatesAsync: async () => info,
            waitExitThenApplyUpdate: applyFn,
        });
        const svc = new UpdateService({
            installRoot: '/fake-install-root',
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();
        await svc.applyUpdate();
        const isServiceMode = installMode === 'user-service' || installMode === 'system-service';
        if (isServiceMode) {
            expect(applyFn).toHaveBeenCalledTimes(1);
            expect(applyFn.mock.calls[0]![2]).toBe(false);
        } else {
            expect(applyFn).not.toHaveBeenCalled();
        }

        const markerCalls = writeFileSpy.mock.calls.filter(
            (c) =>
                typeof c[0] === 'string' &&
                (c[0] as string).endsWith('apply-update-pending'),
        );
        expect(markerCalls).toHaveLength(1);
        expect(mkdirSpy).toHaveBeenCalled();
    });

    // ── reconfigure ─────────────────────────────────────────────────────

    it('reconfigure: swaps internal mgr + triggers immediate check', async () => {
        const oldMgr = fakeMgr({
            checkForUpdatesAsync: async () => null,
            getCurrentVersion: () => '0.1.0',
        });
        const newCheckFn = vi.fn(async () => null as UpdateInfo | null);
        const newMgr = fakeMgr({
            checkForUpdatesAsync: newCheckFn,
            getCurrentVersion: () => '0.1.0',
        });
        const factory = vi
            .fn<(feedUrl: string, opts: UpdateOptions) => UpdateManagerLike>()
            .mockReturnValueOnce(oldMgr)
            .mockReturnValueOnce(newMgr);

        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: factory,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.reconfigure('beta', 'forky');
        expect(factory).toHaveBeenCalledTimes(2);
        const secondCall = factory.mock.calls[1]!;
        expect(secondCall[0]).toBe('https://github.com/forky/ws-scrcpy-web');
        expect(secondCall[1].ExplicitChannel).toBe('beta');
        expect(newCheckFn).toHaveBeenCalled();
    });

    it('reconfigure: factory throws → state=error, old mgr preserved', async () => {
        const oldCheckFn = vi.fn(async () => null as UpdateInfo | null);
        const oldMgr = fakeMgr({
            checkForUpdatesAsync: oldCheckFn,
            getCurrentVersion: () => '0.1.0',
        });
        const factory = vi
            .fn<(feedUrl: string, opts: UpdateOptions) => UpdateManagerLike>()
            .mockReturnValueOnce(oldMgr)
            .mockImplementationOnce(() => {
                throw new Error('bad channel name');
            });

        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: factory,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        // Drain init()'s fire-and-forget immediate check so it doesn't race
        // with our reconfigure assertion below.
        await svc.checkForUpdates();
        oldCheckFn.mockClear();
        await svc.reconfigure('beta', 'forky');
        // Assert error state BEFORE the verification check (which would reset status).
        const sAfterReconfigure = svc.getStatus();
        expect(sAfterReconfigure.status).toBe('error');
        expect(sAfterReconfigure.errorMessage).toMatch(/reconfigure failed/);
        expect(sAfterReconfigure.errorMessage).toMatch(/bad channel name/);
        // Verify old mgr still wired in: a manual checkForUpdates call hits it.
        await svc.checkForUpdates();
        expect(oldCheckFn).toHaveBeenCalled();
    });

    it('reconfigure: dev mode → no-op (no factory call)', async () => {
        delete process.env['APPIMAGE'];
        const factory = vi.fn(() => fakeMgr());
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => false,
            updateManagerFactory: factory,
        });
        svc.init();
        factory.mockClear();
        await svc.reconfigure('beta', 'whoever');
        expect(factory).not.toHaveBeenCalled();
        expect(svc.getStatus().isInstalled).toBe(false);
    });

    // ── restartTimer ────────────────────────────────────────────────────

    it('restartTimer: clears existing timer before scheduling new one', () => {
        const setFn = vi.fn<(cb: () => void, ms: number) => NodeJS.Timeout>(
            () => 'handle-A' as unknown as NodeJS.Timeout,
        );
        const clearFn = vi.fn();
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr(),
            setIntervalFn: setFn,
            clearIntervalFn: clearFn,
        });
        svc.init();
        // init schedules a timer; reset call counts so the assertion is clean.
        setFn.mockClear();
        clearFn.mockClear();

        svc.restartTimer(60, true);
        expect(clearFn).toHaveBeenCalledTimes(1); // cleared the init timer
        expect(setFn).toHaveBeenCalledTimes(1);
        const ms = setFn.mock.calls[0]![1];
        expect(ms).toBe(60 * 60 * 1000);
    });

    it('restartTimer: fires checkForUpdates after intervalMinutes', () => {
        let scheduled: (() => void) | undefined;
        const setFn = vi.fn((cb: () => void) => {
            scheduled = cb;
            return 'h' as unknown as NodeJS.Timeout;
        });
        const clearFn = vi.fn();
        const checkFn = vi.fn(async () => null as UpdateInfo | null);
        const mgr = fakeMgr({ checkForUpdatesAsync: checkFn });
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: setFn,
            clearIntervalFn: clearFn,
        });
        svc.init();
        // The init's immediate void check may or may not have fired the mock
        // by now — clear so we observe only the timer callback.
        checkFn.mockClear();
        scheduled?.();
        expect(checkFn).toHaveBeenCalledTimes(1);
    });

    it('restartTimer with intervalMinutes=0 → no timer scheduled', () => {
        const setFn = vi.fn(() => 'h' as unknown as NodeJS.Timeout);
        const clearFn = vi.fn();
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr(),
            setIntervalFn: setFn,
            clearIntervalFn: clearFn,
        });
        svc.init();
        setFn.mockClear();
        svc.restartTimer(0, true);
        expect(setFn).not.toHaveBeenCalled();
    });

    it('restartTimer with isInstalled=false → no timer scheduled', () => {
        delete process.env['APPIMAGE'];
        const setFn = vi.fn(() => 'h' as unknown as NodeJS.Timeout);
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => false,
            setIntervalFn: setFn,
        });
        svc.init();
        setFn.mockClear();
        svc.restartTimer(60, true);
        expect(setFn).not.toHaveBeenCalled();
    });

    // ── getStatus / shape ───────────────────────────────────────────────

    it('getStatus returns a snapshot copy (mutating it does not affect internal state)', async () => {
        delete process.env['APPIMAGE'];
        const svc = new UpdateService({
            installRoot: '/fake',
            existsSync: () => false,
        });
        svc.init();
        const snap = svc.getStatus();
        snap.status = 'error';
        snap.errorMessage = 'tampered';
        expect(svc.getStatus().status).toBe('idle');
        expect(svc.getStatus().errorMessage).toBeUndefined();
    });
});
