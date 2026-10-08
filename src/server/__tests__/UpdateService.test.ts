import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { UpdateInfo, UpdateOptions, VelopackAsset } from 'velopack';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdbClient } from '../AdbClient';
import { getAppVersion } from '../appVersion';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { liveStreams } from '../liveStreams';
import { PkexecDeclinedError } from '../service/SystemdClient';
import { stageSystemHelper } from '../service/systemHelper';
import { type UpdateManagerLike, UpdateService, type UpdateServiceOptions } from '../UpdateService';
import { GithubReleaseFeedResolver, RELEASES_PER_PAGE, type ResolvedReleaseFeed } from '../updateFeedResolver';
import { betas, type FakeGithubApi, fakeGithubApi, release } from './helpers/fakeGithubReleases';

// FD2: the system-service apply must spawn a bin_t copy under /opt, not the
// var_lib_t data-root helper. The stager itself is unit-tested beside it; here
// it returns its real destination so the spawn's argv shows which was used.
const STAGED = '/opt/ws-scrcpy-web/control/ws-scrcpy-web-launcher';
vi.mock('../service/systemHelper', () => ({ stageSystemHelper: vi.fn(() => STAGED) }));

// The running build's version decides the channel of an install with no stored
// channel (defaultChannelForVersion). The real one unless a test pins it; the
// tests of an update across that default (beta build -> stable release) do.
vi.mock('../appVersion', async (importOriginal) => {
    const real = await importOriginal<typeof import('../appVersion')>();
    return { getAppVersion: vi.fn(real.getAppVersion) };
});

/**
 * The install's Velopack packages folder, one per install and so shared by every
 * manager a test builds: the file names fakeMgr's downloadUpdateAsync has put
 * there. Neither Windows hand-off downloads anything, so both read it strictly:
 * fakeMgr's waitExitThenApplyUpdate throws as Velopack does on a package that
 * is not there (velopack 1.2.161 `manager.rs:629-634`), and an operation-server
 * spawned with its package missing is recorded in `operationServerMissing` --
 * the real one fails with "nupkg named by manifest not found" after the app
 * has gone down -- and fails the test in afterEach. Before 2026-10-08 both
 * fakes were no-ops, and every Windows apply test with autoUpdate off passed
 * an apply that could not work.
 */
const velopackPackages = vi.hoisted(() => ({
    onDisk: new Set<string>(),
    operationServerMissing: [] as string[],
}));

// Mock child_process.spawn so local-mode applyUpdate doesn't try to exec
// the real operation-server helper binary (which doesn't exist in test).
vi.mock('child_process', async (importOriginal) => {
    const real = await importOriginal<typeof child_process>();
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const realPath = await vi.importActual<typeof import('path')>('path');
    /**
     * The operation-server reads the package the verify manifest names from the
     * packages folder. A test that stubs fs.promises.writeFile leaves no manifest
     * on disk; the folder must then hold some package at least.
     */
    function operationServerFindsPackage(cwd: string | undefined): void {
        const manifest = realPath.join(cwd ?? '', 'control', 'apply-update-verify.json');
        if (cwd && realFs.existsSync(manifest)) {
            const { fileName } = JSON.parse(realFs.readFileSync(manifest, 'utf8')) as { fileName: string };
            if (!velopackPackages.onDisk.has(fileName)) velopackPackages.operationServerMissing.push(fileName);
        } else if (velopackPackages.onDisk.size === 0) {
            velopackPackages.operationServerMissing.push('(no manifest; the packages folder is empty)');
        }
    }
    return {
        ...real,
        spawn: vi.fn((_cmd: string, args?: readonly string[], opts?: { cwd?: string }) => {
            if (args?.includes('--operation-server')) operationServerFindsPackage(opts?.cwd);
            // Minimal ChildProcess stand-in: `unref` (detached non-systemd path)
            // + `once` (the systemd-run path awaits 'exit' = unit registration;
            // fire it on the next microtask so the await resolves in tests).
            const child: { pid: number; unref: () => void; once: (e: string, cb: () => void) => unknown } = {
                pid: 12345,
                unref: vi.fn(),
                once: vi.fn((event: string, cb: () => void) => {
                    if (event === 'exit') queueMicrotask(cb);
                    return child;
                }),
            };
            return child;
        }),
        // execFile too: applyUpdate's pre-apply hygiene runs `adb kill-server`
        // and the own-adb reaper, and without this the suite ran them for real
        // against the developer's machine -- a blanket `taskkill /IM adb.exe`
        // included, before the reaper was narrowed to the app's own binary.
        execFile: vi.fn((...args: unknown[]) => {
            const cb = args.find((a) => typeof a === 'function') as
                | ((err: Error | null, stdout: string, stderr: string) => void)
                | undefined;
            queueMicrotask(() => cb?.(null, '', ''));
            return { pid: 0 };
        }),
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

/**
 * Wait out init()'s fire-and-forget check. init() leaves the status at
 * 'checking' synchronously, and that check now awaits a GitHub lookup first.
 */
async function settled(svc: UpdateService): Promise<void> {
    await vi.waitFor(() => expect(['checking', 'downloading']).not.toContain(svc.getStatus().status));
}

/**
 * A Velopack manager. Overrides of downloadUpdateAsync and
 * waitExitThenApplyUpdate are wrapped, not replaced: a download that resolves
 * puts its package in the packages folder (velopackPackages) and, as Velopack
 * does, deletes every other package there (velopack 1.2.161
 * `manager.rs:419-481`) -- unless its own package was already on disk, which
 * Velopack skips without touching anything (`manager.rs:414-417`). An apply
 * throws Velopack's FileNotFound unless the package is there. So "download A,
 * download B, install A" fails here as it would for real.
 */
function fakeMgr(overrides: Partial<UpdateManagerLike> = {}): UpdateManagerLike {
    const {
        downloadUpdateAsync = async () => undefined,
        waitExitThenApplyUpdate = () => undefined,
        ...rest
    } = overrides;
    return {
        getCurrentVersion: () => '0.1.0',
        checkForUpdatesAsync: async () => null,
        ...rest,
        downloadUpdateAsync: async (update, progress) => {
            const name = update.TargetFullRelease.FileName;
            const alreadyOnDisk = velopackPackages.onDisk.has(name);
            await downloadUpdateAsync(update, progress);
            if (!alreadyOnDisk) velopackPackages.onDisk.clear();
            velopackPackages.onDisk.add(name);
        },
        waitExitThenApplyUpdate: (update, silent, restart, restartArgs) => {
            const name = update.TargetFullRelease.FileName;
            if (!velopackPackages.onDisk.has(name)) {
                throw new Error(`File does not exist: packages/${name}`);
            }
            return waitExitThenApplyUpdate(update, silent, restart, restartArgs);
        },
    };
}

/**
 * Watch the pre-apply cleanup: one open stream, `adb kill-server` and the
 * own-adb reaper (hand `reapOwnAdbFn` to the service). Each step is pushed to
 * `order` as it runs. Dispose with `using` -- the stream registry is
 * module-level and the kill-server spy is on the prototype.
 */
function hygieneProbe(order: string[] = []) {
    const stream = {
        closeForShutdown: vi.fn(() => {
            order.push('close stream');
            liveStreams.remove(stream);
        }),
    };
    liveStreams.add(stream);
    const killSpy = vi.spyOn(AdbClient.prototype, 'killServer').mockImplementation(async () => {
        order.push('kill-server');
    });
    const reapOwnAdbFn = vi.fn(async (_adbPath: string) => {
        order.push('reap');
        return 0;
    });
    return {
        reapOwnAdbFn,
        untouched: () => ({
            streamsClosed: stream.closeForShutdown.mock.calls.length,
            killServer: killSpy.mock.calls.length,
            reaped: reapOwnAdbFn.mock.calls.length,
        }),
        [Symbol.dispose](): void {
            killSpy.mockRestore();
            liveStreams.remove(stream);
        },
    };
}

describe('UpdateService', () => {
    const tmpDirs: string[] = [];
    const savedEnv = {
        CONFIG: process.env[EnvName.CONFIG_PATH],
        DEPS: process.env['DEPS_PATH'],
        FEED: process.env['VELOPACK_FEED_URL'],
        APPIMAGE: process.env['APPIMAGE'],
        DATA_ROOT: process.env['DATA_ROOT'],
    };

    // Intercept fs.promises.readFile so pollOperationServerPort returns
    // instantly in local-mode tests instead of waiting 5s for a real file.
    let readFileSpy: ReturnType<typeof vi.spyOn> | undefined;

    // Every update check resolves the selected channel's newest release through
    // api.github.com first. Global fetch is the fake for EVERY test, so nothing
    // here reaches the network; by default one release carries every feed.
    let api: FakeGithubApi;

    beforeEach(() => {
        api = fakeGithubApi([release('v9.9.9', ['beta', 'stable', 'linux-beta', 'linux-stable'])]);
        vi.stubGlobal('fetch', api.fetchFn);
        velopackPackages.onDisk.clear();
        velopackPackages.operationServerMissing.length = 0;
        const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-update-svc-'));
        tmpDirs.push(tmpRoot);
        const configPath = path.join(tmpRoot, 'config.json');
        fs.writeFileSync(configPath, JSON.stringify({}));
        process.env[EnvName.CONFIG_PATH] = configPath;
        process.env['DEPS_PATH'] = path.join(tmpRoot, 'deps');
        // The hand-off markers, the staged download and the verify manifest live
        // under the data root. Unpinned, that is the REAL one on Windows
        // (%ProgramData%\WsScrcpyWeb): every apply test wrote markers there for an
        // installed app to act on, and a "no marker left" assertion read whatever
        // any other run of this suite on the machine had left.
        process.env['DATA_ROOT'] = tmpRoot;
        delete process.env['VELOPACK_FEED_URL'];
        // On Linux, UpdateService checks APPIMAGE env instead of existsSync.
        // Set it so tests using existsSync: () => true trigger production mode.
        process.env['APPIMAGE'] = '/fake/WsScrcpyWeb.AppImage';
        Config._resetForTest();

        const realReadFile = fs.promises.readFile.bind(fs.promises);
        readFileSpy = vi.spyOn(fs.promises, 'readFile').mockImplementation(((
            ...args: Parameters<typeof fs.promises.readFile>
        ) => {
            if (typeof args[0] === 'string' && args[0].includes('operation-server-port')) {
                return Promise.resolve('9999');
            }
            return realReadFile(...args);
        }) as typeof fs.promises.readFile);
    });

    afterEach(() => {
        // Read now, asserted after the cleanup below: a failing assertion here
        // must not skip the restores and cascade into the next test.
        const operationServerMissing = [...velopackPackages.operationServerMissing];
        // The stream registry is a module singleton: a failed apply test can leave
        // a fake stream in it or the stop flag set, and that must not reach the
        // next test.
        liveStreams.closeAllForShutdown();
        liveStreams.cancelStop();
        vi.unstubAllGlobals();
        // Back to the real version (vi.fn's original implementation).
        vi.mocked(getAppVersion).mockReset();
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
        if (savedEnv.DATA_ROOT === undefined) delete process.env['DATA_ROOT'];
        else process.env['DATA_ROOT'] = savedEnv.DATA_ROOT;
        while (tmpDirs.length) {
            const d = tmpDirs.pop()!;
            try {
                fs.rmSync(d, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        }
        // Every operation-server a test spawned found its package (see velopackPackages).
        expect(operationServerMissing, 'operation-server spawned with its package missing').toEqual([]);
    });

    it('the fake packages folder keeps only the package downloaded last, as Velopack does', async () => {
        const mgr = fakeMgr();
        const a = fakeUpdateInfo('0.2.0');
        const b = fakeUpdateInfo('0.3.0');
        await mgr.downloadUpdateAsync(a);
        await mgr.downloadUpdateAsync(b);
        // Downloading B deleted A: installing A now is Velopack's FileNotFound.
        expect(() => mgr.waitExitThenApplyUpdate(a)).toThrow('File does not exist');
        // A package already on disk is skipped, and deletes nothing.
        await mgr.downloadUpdateAsync(b);
        expect(() => mgr.waitExitThenApplyUpdate(b)).not.toThrow();
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

    it('a check points Velopack at the githubOwner repo release that carries the channel', async () => {
        Config.getInstance().updateAppConfig({ githubOwner: 'someone-else' });
        const captured: unknown[] = [];
        const factory = vi.fn((feed: unknown, _opts: UpdateOptions) => {
            captured.push(feed);
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
        await svc.checkForUpdates();
        expect(api.calls[0]!.url).toContain('https://api.github.com/repos/someone-else/ws-scrcpy-web/releases');
        expect(captured.at(-1)).toEqual({
            kind: 'release',
            tag: 'v9.9.9',
            url: 'https://github.com/someone-else/ws-scrcpy-web/releases/download/v9.9.9/',
        });
    });

    it('init: VELOPACK_FEED_URL env override wins over githubOwner', () => {
        process.env['VELOPACK_FEED_URL'] = 'https://internal.example/feed/';
        Config.getInstance().updateAppConfig({ githubOwner: 'someone-else' });
        const captured: unknown[] = [];
        const factory = vi.fn((feed: unknown) => {
            captured.push(feed);
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
        expect(captured[0]).toEqual({ kind: 'override', url: 'https://internal.example/feed/' });
    });

    // ── Feed resolution: the selected channel's newest release ─────────────
    //
    // The rule (user, 2026-10-04): a higher version in the SELECTED channel
    // installs, whichever channel the running build came from. Handing Velopack
    // the bare repo URL broke that: its GithubSource reads only the 10 newest
    // releases (velopack 1.2.161 sources/github.rs:77-89), and betas ship many a
    // day, so a stable release went invisible about ten betas after it shipped.
    // The service now finds the channel's newest release itself and gives
    // Velopack THAT release's download folder.

    const quietTimers = {
        setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
        clearIntervalFn: () => undefined,
    };

    it('channel=stable with 15 newer betas: Velopack reads the stable release, not the 10 newest', async () => {
        api.set([...betas(15, 30), release('v0.1.30', ['stable', 'linux-stable']), ...betas(3, 15)]);
        Config.getInstance().updateAppConfig({ channel: 'stable', githubOwner: 'bilbospocketses' });
        const feeds: unknown[] = [];
        const factory = vi.fn((feed: unknown, _opts: UpdateOptions) => {
            feeds.push(feed);
            return fakeMgr();
        });
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: factory,
            ...quietTimers,
        });
        svc.init();
        await svc.checkForUpdates();
        expect(feeds.at(-1)).toEqual({
            kind: 'release',
            tag: 'v0.1.30',
            url: 'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download/v0.1.30/',
        });
        expect(factory.mock.calls.at(-1)![1].ExplicitChannel).toBe('stable');
    });

    it('channel=beta resolves to the newest beta', async () => {
        // The stable release is OLDER than the betas: a stable 0.1.30 would
        // outrank 0.1.30-beta.30 and win (see the superset tests below).
        api.set([...betas(15, 30), release('v0.1.29', ['stable', 'linux-stable'])]);
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses' });
        const feeds: unknown[] = [];
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: (feed) => {
                feeds.push(feed);
                return fakeMgr();
            },
            ...quietTimers,
        });
        svc.init();
        await svc.checkForUpdates();
        expect(feeds.at(-1)).toMatchObject({ kind: 'release', tag: 'v0.1.30-beta.30' });
    });

    it('linux resolves the linux-<channel> feed', async () => {
        api.set([release('v0.1.31', ['stable']), release('v0.1.30', ['stable', 'linux-stable'])]);
        Config.getInstance().updateAppConfig({ channel: 'stable', githubOwner: 'bilbospocketses' });
        const feeds: unknown[] = [];
        const svc = new UpdateService({
            platform: 'linux',
            installRoot: path.join('/fake', 'mount', 'usr'),
            existsSync: () => true,
            updateManagerFactory: (feed) => {
                feeds.push(feed);
                return fakeMgr();
            },
            ...quietTimers,
        });
        svc.init();
        await svc.checkForUpdates();
        expect(feeds.at(-1)).toMatchObject({ kind: 'release', tag: 'v0.1.30' });
    });

    it('no release carries the channel: idle, not an error, and Velopack is never asked', async () => {
        // Today's repo: betas only, no stable release at all.
        api.set(betas(14, 166));
        Config.getInstance().updateAppConfig({ channel: 'stable', githubOwner: 'bilbospocketses' });
        const checkFn = vi.fn(async () => null as UpdateInfo | null);
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr({ checkForUpdatesAsync: checkFn }),
            ...quietTimers,
        });
        svc.init();
        await svc.checkForUpdates();
        const s = svc.getStatus();
        expect(s.status).toBe('idle');
        expect(s.errorMessage).toBeUndefined();
        expect(s.availableVersion).toBeUndefined();
        expect(s.lastCheckedAt).toBeInstanceOf(Date);
        expect(checkFn).not.toHaveBeenCalled();
    });

    it('a refused GitHub lookup (403) is reported as an error status, not a crash', async () => {
        api.refuse(403);
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr(),
            ...quietTimers,
        });
        svc.init();
        const s = await svc.checkForUpdates();
        expect(s.status).toBe('error');
        expect(s.errorMessage).toMatch(/HTTP 403/);
    });

    it('VELOPACK_FEED_URL set: no GitHub lookup, the URL goes to Velopack as-is', async () => {
        process.env['VELOPACK_FEED_URL'] = 'file:///C:/sandbox/feed';
        const feeds: unknown[] = [];
        const checkFn = vi.fn(async () => null as UpdateInfo | null);
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: (feed) => {
                feeds.push(feed);
                return fakeMgr({ checkForUpdatesAsync: checkFn });
            },
            ...quietTimers,
        });
        svc.init();
        await svc.checkForUpdates();
        expect(api.calls).toHaveLength(0);
        expect(checkFn).toHaveBeenCalled();
        expect(feeds.length).toBeGreaterThan(0);
        for (const f of feeds) expect(f).toEqual({ kind: 'override', url: 'file:///C:/sandbox/feed' });
    });

    it('a channel switch re-resolves against the new channel', async () => {
        api.set([...betas(15, 30), release('v0.1.29', ['stable', 'linux-stable'])]);
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses' });
        const factory = vi.fn((_feed: unknown, _opts: UpdateOptions) => fakeMgr());
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: factory,
            ...quietTimers,
        });
        svc.init();
        await svc.checkForUpdates();
        expect(factory.mock.calls.at(-1)![0]).toMatchObject({ tag: 'v0.1.30-beta.30' });
        await svc.reconfigure('stable', 'bilbospocketses');
        const [feed, opts] = factory.mock.calls.at(-1)!;
        expect(feed).toMatchObject({ kind: 'release', tag: 'v0.1.29' });
        expect(opts.ExplicitChannel).toBe('stable');
    });

    it('the resolved release is cached across checks and refreshed when a newer one appears', async () => {
        api.set([...betas(3, 30), release('v0.1.29', ['stable'])]);
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses' });
        const factory = vi.fn((_feed: unknown, _opts: UpdateOptions) => fakeMgr());
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: factory,
            ...quietTimers,
        });
        svc.init();
        await svc.checkForUpdates();
        await svc.checkForUpdates();
        const builtFor = (tag: string) =>
            factory.mock.calls.filter(([f]) => (f as { tag?: string }).tag === tag).length;
        // Built once for beta.30 however many checks ran; later checks were
        // conditional requests the unchanged listing answered with 304.
        expect(builtFor('v0.1.30-beta.30')).toBe(1);
        expect(api.calls.at(-1)!.ifNoneMatch).not.toBeNull();

        api.set([...betas(1, 31), ...betas(3, 30), release('v0.1.29', ['stable'])]);
        await svc.checkForUpdates();
        expect(factory.mock.calls.at(-1)![0]).toMatchObject({ tag: 'v0.1.30-beta.31' });
    });

    it('a check that fails after resolving forgets the cached release', async () => {
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () =>
                fakeMgr({
                    checkForUpdatesAsync: async () => {
                        throw new Error('Network error: Http error: http status: 404');
                    },
                }),
            ...quietTimers,
        });
        svc.init();
        await svc.checkForUpdates();
        // Let init()'s own fire-and-forget check finish too.
        await settled(svc);
        expect(svc.getStatus().status).toBe('error');
        const before = api.calls.length;
        await svc.checkForUpdates();
        // A full walk, not a conditional request that would re-serve the same release.
        expect(api.calls[before]!.ifNoneMatch).toBeNull();
    });

    it('a refused lookup (403) with an answer already cached keeps the check working', async () => {
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr(),
            ...quietTimers,
        });
        svc.init();
        await settled(svc);
        expect(svc.getStatus().status).toBe('idle');
        api.refuse(403);
        const s = await svc.checkForUpdates();
        expect(s.status).toBe('idle');
        expect(s.errorMessage).toBeUndefined();
    });

    // ── The beta channel is a superset of stable (user decision 2026-10-07) ──
    //
    // A beta-channel check considers the newest beta-feed release AND the
    // newest stable-feed release, and reads whichever has the higher version --
    // from that release's folder AND with that feed's ExplicitChannel, since a
    // stable release publishes only releases.stable.json / releases.linux-stable.json.
    // The configured channel stays beta. The stable channel never sees a beta.

    /** A service on `platform` whose factory records every (feed, options) it is built with. */
    function recordingService(platform: NodeJS.Platform, checkFn?: () => Promise<UpdateInfo | null>) {
        const factory = vi.fn((_feed: unknown, _opts: UpdateOptions) =>
            fakeMgr(checkFn ? { checkForUpdatesAsync: checkFn } : {}),
        );
        const svc = new UpdateService({
            platform,
            installRoot: platform === 'linux' ? path.join('/fake', 'mount', 'usr') : '/fake',
            existsSync: () => true,
            updateManagerFactory: factory,
            ...quietTimers,
        });
        const last = () => {
            const [feed, opts] = factory.mock.calls.at(-1)!;
            return { feed: feed as { kind: string; tag?: string; url: string }, explicit: opts.ExplicitChannel };
        };
        return { svc, factory, last };
    }

    it.each([
        ['win32', 'stable'],
        ['linux', 'linux-stable'],
    ] as const)(
        'beta channel (%s): a stable release newer than every beta is read from its folder with the %s feed',
        async (platform, explicit) => {
            api.set([...betas(15, 30), release('v0.1.30', ['stable', 'linux-stable']), ...betas(3, 15)]);
            Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses' });
            const { svc, last } = recordingService(platform);
            svc.init();
            await settled(svc);
            await svc.checkForUpdates();
            expect(last().feed).toEqual({
                kind: 'release',
                tag: 'v0.1.30',
                url: 'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download/v0.1.30/',
            });
            expect(last().explicit).toBe(explicit);
            // The install stays on the beta channel: nothing wrote config.
            expect(Config.getInstance().getAppConfig().channel).toBe('beta');
        },
    );

    it.each([
        ['win32', 'beta'],
        ['linux', 'linux-beta'],
    ] as const)(
        'beta channel (%s): a beta newer than the newest stable is read with the %s feed',
        async (platform, explicit) => {
            api.set([...betas(3, 30), release('v0.1.29', ['stable', 'linux-stable'])]);
            Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses' });
            const { svc, last } = recordingService(platform);
            svc.init();
            await settled(svc);
            await svc.checkForUpdates();
            expect(last().feed).toMatchObject({ kind: 'release', tag: 'v0.1.30-beta.30' });
            expect(last().explicit).toBe(explicit);
        },
    );

    it('beta channel: the feed follows the newest version back and forth, rebuilding the manager each time', async () => {
        api.set([...betas(3, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses' });
        const { svc, last } = recordingService('win32');
        svc.init();
        await settled(svc);
        expect(last()).toMatchObject({ feed: { tag: 'v0.1.30' }, explicit: 'stable' });

        // The next beta cycle starts: its first beta outranks the stable release.
        api.set([release('v0.1.31-beta.1', ['beta', 'linux-beta']), ...betas(3, 30), release('v0.1.30', ['stable'])]);
        await svc.checkForUpdates();
        expect(last()).toMatchObject({ feed: { tag: 'v0.1.31-beta.1' }, explicit: 'beta' });

        // ...and the stable release that ends it outranks every one of its betas.
        api.set([
            release('v0.1.31', ['stable']),
            release('v0.1.31-beta.1', ['beta', 'linux-beta']),
            ...betas(3, 30),
            release('v0.1.30', ['stable']),
        ]);
        await svc.checkForUpdates();
        expect(last()).toMatchObject({ feed: { tag: 'v0.1.31' }, explicit: 'stable' });
        expect(Config.getInstance().getAppConfig().channel).toBe('beta');
    });

    it('beta channel: the same release folder read through a different feed rebuilds the manager', async () => {
        // The manager key carries the feed's ExplicitChannel, not the configured
        // channel: here the folder never changes, only which feed in it wins.
        api.set([release('v0.1.30', ['stable'])]);
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses' });
        const { svc, last } = recordingService('win32');
        svc.init();
        await settled(svc);
        expect(last()).toMatchObject({ feed: { tag: 'v0.1.30' }, explicit: 'stable' });
        api.set([release('v0.1.30', ['beta', 'stable'])]);
        await svc.checkForUpdates();
        expect(last()).toMatchObject({ feed: { tag: 'v0.1.30' }, explicit: 'beta' });
    });

    it('beta channel: on a tie the beta feed is kept (one release carrying both feeds)', async () => {
        api.set([release('v0.1.30', ['beta', 'stable'])]);
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses' });
        const { svc, last } = recordingService('win32');
        svc.init();
        await settled(svc);
        expect(last()).toMatchObject({ feed: { tag: 'v0.1.30' }, explicit: 'beta' });
    });

    it('stable channel: never offered a beta, however much newer', async () => {
        api.set([release('v0.9.0-beta.1', ['beta', 'linux-beta']), release('v0.1.30', ['stable', 'linux-stable'])]);
        Config.getInstance().updateAppConfig({ channel: 'stable', githubOwner: 'bilbospocketses' });
        const { svc, factory, last } = recordingService('linux');
        svc.init();
        await settled(svc);
        await svc.checkForUpdates();
        expect(last()).toMatchObject({ feed: { tag: 'v0.1.30' }, explicit: 'linux-stable' });
        // Call 0 is init()'s manager on the running build's own release (a beta
        // here); every manager a check built since read a stable release.
        expect(factory.mock.calls.length).toBeGreaterThan(1);
        for (const [feed, opts] of factory.mock.calls.slice(1)) {
            expect((feed as { tag?: string }).tag).not.toMatch(/beta/);
            expect(opts.ExplicitChannel).toBe('linux-stable');
        }
    });

    it('beta channel with no stable release yet: the newest beta, exactly as before', async () => {
        api.set(betas(14, 166));
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses' });
        const { svc, last } = recordingService('win32');
        svc.init();
        await settled(svc);
        const before = api.calls.length;
        await svc.checkForUpdates();
        expect(last()).toMatchObject({ feed: { tag: 'v0.1.30-beta.166' }, explicit: 'beta' });
        // One page, one request: the stable lookup costs nothing extra.
        expect(api.calls.length - before).toBe(1);
        expect(svc.getStatus().status).toBe('idle');
        expect(svc.getStatus().errorMessage).toBeUndefined();
    });

    it('beta channel: an unchanged two-page listing costs one conditional request per page, and no rebuild', async () => {
        api.set([...betas(RELEASES_PER_PAGE, 200), release('v0.1.31', ['stable', 'linux-stable'])]);
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses' });
        const { svc, factory, last } = recordingService('win32');
        svc.init();
        await settled(svc);
        expect(last()).toMatchObject({ feed: { tag: 'v0.1.31' }, explicit: 'stable' });
        const builds = factory.mock.calls.length;
        const before = api.calls.length;
        await svc.checkForUpdates();
        const second = api.calls.slice(before);
        // Both feeds answered from ONE walk: two pages, two requests, both conditional.
        expect(second.map((c) => new URL(c.url).searchParams.get('page'))).toEqual(['1', '2']);
        expect(second.every((c) => c.ifNoneMatch !== null)).toBe(true);
        expect(factory.mock.calls.length).toBe(builds);
    });

    it('beta channel: a refused lookup with the listing already read keeps offering the newer stable release', async () => {
        api.set([...betas(3, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses', autoUpdate: false });
        const { svc, factory, last } = recordingService('win32', async () => fakeUpdateInfo('0.1.30'));
        svc.init();
        await settled(svc);
        const builds = factory.mock.calls.length;
        api.refuse(403);
        const s = await svc.checkForUpdates();
        expect(s.status).toBe('ready');
        expect(s.availableVersion).toBe('0.1.30');
        expect(last()).toMatchObject({ feed: { tag: 'v0.1.30' }, explicit: 'stable' });
        expect(factory.mock.calls.length).toBe(builds);
    });

    it('beta channel: a refusal with no listing read yet fails the check, as before', async () => {
        api.set([...betas(3, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        api.refuse(403);
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses' });
        const { svc, factory } = recordingService('win32');
        svc.init();
        await settled(svc);
        const s = svc.getStatus();
        expect(s.status).toBe('error');
        expect(s.errorMessage).toMatch(/HTTP 403/);
        // Only init()'s own-release manager was ever built: neither feed was guessed at.
        expect(factory).toHaveBeenCalledTimes(1);
    });

    it('beta channel (linux): applying a newer stable release downloads the linux-stable AppImage from that release', async () => {
        const { createHash } = await import('crypto');
        api.set([...betas(3, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        Config.getInstance().updateAppConfig({
            autoUpdate: false,
            installMode: 'user',
            channel: 'beta',
            githubOwner: 'bilbospocketses',
        });
        const appImageBytes = Buffer.from('STABLE-APPIMAGE');
        const goodHash = createHash('sha256').update(appImageBytes).digest('hex');
        const sums = `${goodHash}  ./linux-final/WsScrcpyWeb-linux-stable.AppImage\n`;
        const fetched: string[] = [];
        const fetchFn = vi.fn(async (url: string) => {
            fetched.push(url);
            return url.endsWith('.AppImage') ? new Response(appImageBytes) : new Response(sums);
        }) as unknown as typeof fetch;
        vi.mocked(child_process.spawn).mockClear();
        const svc = new UpdateService({
            platform: 'linux',
            installRoot: path.join('/fake', 'mount', 'usr'),
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr({ checkForUpdatesAsync: async () => fakeUpdateInfo('0.1.30') }),
            ...quietTimers,
            fetchFn,
        });
        process.env['APPIMAGE'] = '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage';
        svc.init();
        await settled(svc);
        expect(svc.getStatus().status).toBe('ready');

        await svc.applyUpdate();
        expect(fetched).toContain(
            'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download/v0.1.30/WsScrcpyWeb-linux-stable.AppImage',
        );
        expect(fetched).toContain(
            'https://github.com/bilbospocketses/ws-scrcpy-web/releases/download/v0.1.30/SHA256SUMS',
        );
        expect(fetched.some((u) => u.includes('linux-beta'))).toBe(false);
        expect(vi.mocked(child_process.spawn)).toHaveBeenCalledTimes(1);
    });

    // ── ...and stays on beta after installing it (review 2026-10-07, finding 1) ──
    //
    // A version boots on the stored app_settings channel, else config.json's,
    // else its own version's default. A beta install whose radio was never
    // touched stores none: it is on beta only because it is a beta BUILD, and
    // the stable version it updates to would default to stable, never to be
    // offered a beta again. applyUpdate stores the channel before any hand-off.

    const BETA_BUILD = '0.1.30-beta.30';
    const STABLE = '0.1.30';

    /** A beta build with no stored channel: on beta by its version's default only. */
    function betaBuildWithNoStoredChannel(): void {
        vi.mocked(getAppVersion).mockReturnValue(BETA_BUILD);
        Config._resetForTest();
        expect(storedChannel()).toBeUndefined();
        expect(Config.getInstance().getAppConfig().channel).toBe('beta');
    }

    /** The app_settings channel row (undefined when none is stored). */
    function storedChannel(): unknown {
        return Config.getInstance().db.appSettings.get('channel');
    }

    /** The channel the updated app boots on: a fresh Config load as `version`. */
    function channelAfterRestartAs(version: string): string {
        vi.mocked(getAppVersion).mockReturnValue(version);
        Config._resetForTest();
        return Config.getInstance().getAppConfig().channel;
    }

    /** Make the next spawn record the stored channel at the moment it is called. */
    function recordChannelAtNextSpawn(): { atSpawn: unknown } {
        const seen: { atSpawn: unknown } = { atSpawn: 'never spawned' };
        const spawnMock = vi.mocked(child_process.spawn);
        const base = spawnMock.getMockImplementation()!;
        spawnMock.mockClear();
        spawnMock.mockImplementationOnce(((...args: Parameters<typeof child_process.spawn>) => {
            seen.atSpawn = storedChannel();
            return base(...args);
        }) as typeof child_process.spawn);
        return seen;
    }

    function betaInstallService(
        platform: NodeJS.Platform,
        target: string,
        extra: UpdateServiceOptions = {},
        mgrOverrides: Partial<UpdateManagerLike> = {},
    ): UpdateService {
        return new UpdateService({
            platform,
            installRoot: platform === 'linux' ? path.join('/fake', 'mount', 'usr') : '/fake',
            existsSync: () => true,
            updateManagerFactory: () =>
                fakeMgr({ checkForUpdatesAsync: async () => fakeUpdateInfo(target), ...mgrOverrides }),
            reapOwnAdbFn: async () => 0,
            ...quietTimers,
            ...extra,
        });
    }

    /** A fetch serving `asset` with a matching SHA256SUMS, for the Linux apply. */
    async function linuxAssetFetch(asset: string): Promise<typeof fetch> {
        const { createHash } = await import('crypto');
        const bytes = Buffer.from('APPIMAGE');
        const sums = `${createHash('sha256').update(bytes).digest('hex')}  ./linux-final/${asset}\n`;
        return vi.fn(async (url: string) =>
            url.endsWith('.AppImage') ? new Response(bytes) : new Response(sums),
        ) as unknown as typeof fetch;
    }

    it('precondition: with nothing stored, the stable version a beta build updates to boots on stable', () => {
        betaBuildWithNoStoredChannel();
        expect(channelAfterRestartAs(STABLE)).toBe('stable');
    });

    it('beta install with no stored channel (win32 local): a stable release is applied with beta stored before the hand-off', async () => {
        betaBuildWithNoStoredChannel();
        Config.getInstance().updateAppConfig({ autoUpdate: false });
        api.set([...betas(3, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        const seen = recordChannelAtNextSpawn();
        const svc = betaInstallService('win32', STABLE);
        svc.init();
        await settled(svc);
        expect(svc.getStatus()).toMatchObject({ status: 'ready', pendingChannel: 'stable' });

        await svc.applyUpdate();

        // The operation-server is the hand-off; the row was there before it.
        expect(seen.atSpawn).toBe('beta');
        expect(channelAfterRestartAs(STABLE)).toBe('beta');
    });

    it('beta install with no stored channel (win32 service): beta is stored before Velopack is handed the apply', async () => {
        betaBuildWithNoStoredChannel();
        Config.getInstance().updateAppConfig({ autoUpdate: false, installMode: 'user-service' });
        api.set([...betas(3, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        let atHandoff: unknown = 'never handed off';
        const svc = betaInstallService(
            'win32',
            STABLE,
            {},
            {
                waitExitThenApplyUpdate: () => {
                    atHandoff = storedChannel();
                },
            },
        );
        svc.init();
        await settled(svc);
        expect(svc.getStatus().status).toBe('ready');

        await svc.applyUpdate();

        expect(atHandoff).toBe('beta');
        expect(channelAfterRestartAs(STABLE)).toBe('beta');
    });

    it('beta install with no stored channel (linux local): beta is stored before the apply helper is spawned', async () => {
        betaBuildWithNoStoredChannel();
        Config.getInstance().updateAppConfig({ autoUpdate: false, installMode: 'user' });
        api.set([...betas(3, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        const seen = recordChannelAtNextSpawn();
        const svc = betaInstallService('linux', STABLE, {
            fetchFn: await linuxAssetFetch('WsScrcpyWeb-linux-stable.AppImage'),
        });
        svc.init();
        await settled(svc);
        expect(svc.getStatus()).toMatchObject({ status: 'ready', pendingChannel: 'stable' });

        await svc.applyUpdate();

        expect(seen.atSpawn).toBe('beta');
        expect(channelAfterRestartAs(STABLE)).toBe('beta');
    });

    it('beta install with no stored channel (linux machine-wide): beta is stored before the pkexec swap', async () => {
        betaBuildWithNoStoredChannel();
        Config.getInstance().updateAppConfig({ autoUpdate: false, installMode: 'user' });
        api.set([...betas(3, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        let atSwap: unknown = 'never swapped';
        const svc = betaInstallService('linux', STABLE, {
            fetchFn: await linuxAssetFetch('WsScrcpyWeb-linux-stable.AppImage'),
            runPkexecFn: async () => {
                atSwap = storedChannel();
                return '';
            },
        });
        process.env['APPIMAGE'] = '/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage';
        svc.init();
        await settled(svc);
        expect(svc.getStatus().status).toBe('ready');

        await svc.applyUpdate();

        // The swap of the /opt binary is the first step that cannot be undone.
        expect(atSwap).toBe('beta');
        expect(channelAfterRestartAs(STABLE)).toBe('beta');
    });

    it('beta install with no stored channel: a beta release is applied without storing anything, and the new beta boots on beta', async () => {
        // Its own default already says beta, so nothing is written: the install
        // still follows its build's default, exactly as before.
        betaBuildWithNoStoredChannel();
        Config.getInstance().updateAppConfig({ autoUpdate: false });
        api.set(betas(3, 31));
        const seen = recordChannelAtNextSpawn();
        const svc = betaInstallService('win32', '0.1.30-beta.31');
        svc.init();
        await settled(svc);
        expect(svc.getStatus()).toMatchObject({ status: 'ready', pendingChannel: 'beta' });

        await svc.applyUpdate();

        expect(seen.atSpawn).toBeUndefined();
        expect(storedChannel()).toBeUndefined();
        expect(channelAfterRestartAs('0.1.30-beta.31')).toBe('beta');
    });

    it('applying stores the channel the user has NOW, not the one the service last checked with', async () => {
        // The radio moves to stable after the check offered the stable release
        // (in the app the PATCH then reconfigures; this is the moment before).
        // The service still holds beta, but beta must not be written over the
        // user's choice.
        betaBuildWithNoStoredChannel();
        Config.getInstance().updateAppConfig({ autoUpdate: false });
        api.set([...betas(3, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        const svc = betaInstallService('win32', STABLE);
        svc.init();
        await settled(svc);
        expect(svc.getStatus().status).toBe('ready');
        Config.getInstance().updateAppConfig({ channel: 'stable' });

        await svc.applyUpdate();

        expect(storedChannel()).toBe('stable');
        expect(channelAfterRestartAs(STABLE)).toBe('stable');
    });

    it('a channel that cannot be stored refuses the apply before anything is touched', async () => {
        betaBuildWithNoStoredChannel();
        Config.getInstance().updateAppConfig({ autoUpdate: false });
        api.set([...betas(3, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        using probe = hygieneProbe();
        const spawnMock = vi.mocked(child_process.spawn);
        spawnMock.mockClear();
        const svc = betaInstallService('win32', STABLE, { reapOwnAdbFn: probe.reapOwnAdbFn });
        svc.init();
        await settled(svc);
        expect(svc.getStatus().status).toBe('ready');
        const write = vi.spyOn(Config.getInstance(), 'updateAppConfig').mockImplementation(() => {
            throw new Error('database is locked');
        });

        try {
            await expect(svc.applyUpdate()).rejects.toThrow(
                /could not record the beta channel before installing v0\.1\.30: database is locked/,
            );
        } finally {
            write.mockRestore();
        }

        expect(spawnMock).not.toHaveBeenCalled();
        expect(probe.untouched()).toEqual({ streamsClosed: 0, killServer: 0, reaped: 0 });
        expect(fs.existsSync(Config.getInstance().applyUpdatePendingMarkerPath)).toBe(false);
        expect(svc.getStatus().status).toBe('ready');
        // Not stuck as "in progress": once the write works, the retry goes ahead.
        await svc.applyUpdate();
        expect(storedChannel()).toBe('beta');
    });

    it('a channel that cannot be stored (linux machine-wide) drops the verified download and touches nothing', async () => {
        betaBuildWithNoStoredChannel();
        Config.getInstance().updateAppConfig({ autoUpdate: false, installMode: 'user' });
        api.set([...betas(3, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        using probe = hygieneProbe();
        const spawnMock = vi.mocked(child_process.spawn);
        spawnMock.mockClear();
        const pkexecMock = vi.fn<(shellCmd: string, label: string) => Promise<string>>(async () => '');
        const svc = betaInstallService('linux', STABLE, {
            fetchFn: await linuxAssetFetch('WsScrcpyWeb-linux-stable.AppImage'),
            runPkexecFn: pkexecMock,
            reapOwnAdbFn: probe.reapOwnAdbFn,
        });
        process.env['APPIMAGE'] = '/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage';
        svc.init();
        await settled(svc);
        expect(svc.getStatus()).toMatchObject({ status: 'ready', pendingChannel: 'stable' });
        const cfg = Config.getInstance();
        const staged = path.join(
            cfg.dataRoot ?? path.dirname(cfg.dependenciesPath),
            'control',
            'update-staging',
            'WsScrcpyWeb-linux-stable.AppImage.new',
        );
        // Read from this test's own data root, never the machine's.
        expect(path.relative(tmpDirs.at(-1)!, staged).startsWith('..')).toBe(false);
        let stagedAtWrite: boolean | undefined;
        const write = vi.spyOn(cfg, 'updateAppConfig').mockImplementation(() => {
            stagedAtWrite = fs.existsSync(staged);
            throw new Error('database is locked');
        });

        try {
            await expect(svc.applyUpdate()).rejects.toThrow(
                /could not record the beta channel before installing v0\.1\.30: database is locked/,
            );
        } finally {
            write.mockRestore();
        }

        // The write came after the verified download, which is then removed.
        expect(stagedAtWrite).toBe(true);
        expect(fs.existsSync(staged)).toBe(false);
        expect(pkexecMock).not.toHaveBeenCalled();
        expect(spawnMock).not.toHaveBeenCalled();
        expect(probe.untouched()).toEqual({ streamsClosed: 0, killServer: 0, reaped: 0 });
        expect(fs.existsSync(cfg.applyUpdatePendingMarkerPath)).toBe(false);
        expect(fs.existsSync(cfg.suppressBrowserOpenMarkerPath)).toBe(false);
        expect(storedChannel()).toBeUndefined();
        expect(svc.getStatus().status).toBe('ready');
        // Not stuck as "in progress": once the write works, the retry goes ahead.
        await svc.applyUpdate();
        expect(pkexecMock).toHaveBeenCalledTimes(1);
        expect(storedChannel()).toBe('beta');
    });

    it('beta install with no stored channel (win32): a failed download records nothing, the retry does', async () => {
        betaBuildWithNoStoredChannel();
        Config.getInstance().updateAppConfig({ autoUpdate: false });
        api.set([...betas(3, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        let fail = true;
        const svc = betaInstallService(
            'win32',
            STABLE,
            {},
            {
                downloadUpdateAsync: async () => {
                    if (fail) throw new Error('Network error');
                },
            },
        );
        svc.init();
        await settled(svc);
        expect(svc.getStatus().status).toBe('ready');

        await expect(svc.applyUpdate()).rejects.toThrow('update download failed: Network error');
        expect(storedChannel()).toBeUndefined();

        await settled(svc);
        fail = false;
        await svc.applyUpdate();
        expect(storedChannel()).toBe('beta');
    });

    it('beta install with no stored channel (linux local): a failed download records nothing, the retry does', async () => {
        betaBuildWithNoStoredChannel();
        Config.getInstance().updateAppConfig({ autoUpdate: false, installMode: 'user' });
        api.set([...betas(3, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
        const good = await linuxAssetFetch('WsScrcpyWeb-linux-stable.AppImage');
        let fail = true;
        const fetchFn = vi.fn((url: string, init?: RequestInit) =>
            fail ? Promise.resolve(new Response('gone', { status: 404 })) : good(url, init),
        ) as unknown as typeof fetch;
        const svc = betaInstallService('linux', STABLE, { fetchFn });
        svc.init();
        await settled(svc);
        expect(svc.getStatus().status).toBe('ready');

        await expect(svc.applyUpdate()).rejects.toThrow();
        expect(storedChannel()).toBeUndefined();

        fail = false;
        await svc.applyUpdate();
        expect(storedChannel()).toBe('beta');
    });

    // ── A channel switch while work for the old channel is still running ──
    //
    // reconfigure() bumps a generation; anything still running for the old
    // channel must not write its answer into the new channel's state.

    it('a Velopack check still running for the old channel drops its answer after a switch', async () => {
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses', autoUpdate: false });
        let hold = false;
        let answerBeta: ((info: UpdateInfo | null) => void) | undefined;
        const factory = vi.fn((_feed: unknown, opts: UpdateOptions) =>
            fakeMgr({
                checkForUpdatesAsync: () =>
                    hold && opts.ExplicitChannel === 'beta'
                        ? new Promise<UpdateInfo | null>((resolve) => {
                              answerBeta = resolve;
                          })
                        : Promise.resolve(null),
            }),
        );
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: factory,
            ...quietTimers,
        });
        svc.init();
        await settled(svc);
        hold = true;
        const oldCheck = svc.checkForUpdates();
        await vi.waitFor(() => expect(answerBeta).toBeDefined());
        await svc.reconfigure('stable', 'bilbospocketses');
        expect(svc.getStatus().status).toBe('idle');

        answerBeta!(fakeUpdateInfo('0.2.0'));
        await oldCheck;
        const s = svc.getStatus();
        expect(s.status).toBe('idle');
        expect(s.availableVersion).toBeUndefined();
        expect(s.pendingUpdate).toBeUndefined();
    });

    it('a release lookup still running for the old channel does not rebuild the manager after a switch', async () => {
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses', autoUpdate: false });
        let hold = false;
        let answerBeta: ((r: ResolvedReleaseFeed) => void) | undefined;
        const resolver = {
            resolve: vi.fn((_owner: string, channels: string | readonly string[]) => {
                const channel = typeof channels === 'string' ? channels : channels[0]!;
                return hold && channel === 'beta'
                    ? new Promise<ResolvedReleaseFeed>((resolve) => {
                          answerBeta = resolve;
                      })
                    : Promise.resolve({ tag: `v-${channel}`, url: `https://feeds.example/${channel}/`, channel });
            }),
        };
        const factory = vi.fn((_feed: unknown, _opts: UpdateOptions) => fakeMgr());
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: factory,
            releaseFeedResolver: resolver,
            ...quietTimers,
        });
        svc.init();
        await settled(svc);
        hold = true;
        const oldCheck = svc.checkForUpdates();
        await vi.waitFor(() => expect(answerBeta).toBeDefined());
        await svc.reconfigure('stable', 'bilbospocketses');
        expect(factory.mock.calls.at(-1)![1].ExplicitChannel).toBe('stable');
        const builds = factory.mock.calls.length;

        answerBeta!({ tag: 'v-beta-late', url: 'https://feeds.example/beta-late/', channel: 'beta' });
        await oldCheck;
        expect(factory.mock.calls.length).toBe(builds);
        expect(factory.mock.calls.at(-1)![1].ExplicitChannel).toBe('stable');
        expect(svc.getStatus().status).toBe('idle');
    });

    it('a download still running for the old channel does not report ready after a switch', async () => {
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses', autoUpdate: true });
        let finishDownload: (() => void) | undefined;
        const downloadFn = vi.fn(
            (_u: UpdateInfo) =>
                new Promise<void>((resolve) => {
                    finishDownload = resolve;
                }),
        );
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: (_feed, opts) =>
                fakeMgr({
                    checkForUpdatesAsync: async () =>
                        opts.ExplicitChannel === 'beta' ? fakeUpdateInfo('0.2.0') : null,
                    downloadUpdateAsync: downloadFn,
                }),
            ...quietTimers,
        });
        svc.init();
        await vi.waitFor(() => expect(finishDownload).toBeDefined());
        await svc.reconfigure('stable', 'bilbospocketses');
        expect(svc.getStatus().status).toBe('idle');

        finishDownload!();
        await new Promise((resolve) => setTimeout(resolve, 0));
        const s = svc.getStatus();
        expect(s.status).toBe('idle');
        expect(s.availableVersion).toBeUndefined();
        expect(s.pendingUpdate).toBeUndefined();
    });

    it('a switch never starts a second download while the old channel still holds the lock', async () => {
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses', autoUpdate: true });
        let active = 0;
        let maxActive = 0;
        const finishers: (() => void)[] = [];
        const downloaded: string[] = [];
        const downloadFn = vi.fn((u: UpdateInfo) => {
            active++;
            maxActive = Math.max(maxActive, active);
            downloaded.push(u.TargetFullRelease.Version);
            return new Promise<void>((resolve) => {
                finishers.push(() => {
                    active--;
                    resolve();
                });
            });
        });
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: (_feed, opts) =>
                fakeMgr({
                    checkForUpdatesAsync: async () =>
                        fakeUpdateInfo(opts.ExplicitChannel === 'beta' ? '0.2.0' : '0.3.0'),
                    downloadUpdateAsync: downloadFn,
                }),
            ...quietTimers,
        });
        svc.init();
        await vi.waitFor(() => expect(finishers).toHaveLength(1));
        const switching = svc.reconfigure('stable', 'bilbospocketses');
        await vi.waitFor(() => expect(svc.getStatus().availableVersion).toBe('0.3.0'));
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(downloadFn).toHaveBeenCalledTimes(1);

        finishers[0]!();
        await vi.waitFor(() => expect(finishers).toHaveLength(2));
        finishers[1]!();
        await switching;
        expect(maxActive).toBe(1);
        expect(downloaded).toEqual(['0.2.0', '0.3.0']);
        const s = svc.getStatus();
        expect(s.status).toBe('ready');
        expect(s.availableVersion).toBe('0.3.0');
        expect(s.progress).toBe(100);
    });

    // ── Overlapping checks in one generation ──
    //
    // The startup check, the interval timer and a manual check from the API
    // can be asked for while another check is still running. Two checks side
    // by side each resolved the newest release and swapped the manager for it,
    // so when they resolved different releases the answer that landed last was
    // paired with the other check's manager -- and Velopack's HttpSource, which
    // joins the package name onto the manager's release folder, 404'd.

    function deferred<T>() {
        let resolve!: (value: T) => void;
        let reject!: (err: Error) => void;
        const promise = new Promise<T>((res, rej) => {
            resolve = res;
            reject = rej;
        });
        return { promise, resolve, reject };
    }

    /**
     * A resolver whose answers the test hands out: while `hold` is set, every
     * resolve() waits in `held` for the test to answer it; otherwise it answers
     * `answer()` at once.
     */
    function heldResolver(answer: (channels: readonly string[]) => ResolvedReleaseFeed | null) {
        const held: { channels: readonly string[]; answer: (r: ResolvedReleaseFeed | null) => void }[] = [];
        const state = { hold: false };
        const resolve = vi.fn((_owner: string, channels: string | readonly string[]) => {
            const list = typeof channels === 'string' ? [channels] : channels;
            if (!state.hold) return Promise.resolve(answer(list));
            const d = deferred<ResolvedReleaseFeed | null>();
            held.push({ channels: list, answer: d.resolve });
            return d.promise;
        });
        return { resolver: { resolve }, resolve, held, state };
    }

    /** A Windows release folder whose feed offers `version` (the folder is `v<version>`). */
    function releaseOf(version: string, channel = 'stable'): ResolvedReleaseFeed {
        return { tag: `v${version}`, url: `https://feeds.example/v${version}/`, channel };
    }

    /**
     * Managers keyed by the release folder they read. Each offers that
     * folder's version; `holdChecks` parks its checkForUpdatesAsync for the
     * test to answer. A download asks the manager's own folder for the package,
     * so an UpdateInfo from another release 404s, as Velopack's HttpSource does.
     */
    function folderManagers() {
        const heldChecks: { tag: string; answer: () => void }[] = [];
        const downloads: { folder: string; version: string }[] = [];
        const opts = { holdChecks: false };
        const factory = vi.fn((feed: unknown, _opts: UpdateOptions) => {
            const tag = (feed as { tag?: string }).tag ?? 'own';
            const info = tag.startsWith('v') ? fakeUpdateInfo(tag.slice(1)) : null;
            return fakeMgr({
                checkForUpdatesAsync: () => {
                    if (!opts.holdChecks) return Promise.resolve(null);
                    const d = deferred<UpdateInfo | null>();
                    heldChecks.push({ tag, answer: () => d.resolve(info) });
                    return d.promise;
                },
                downloadUpdateAsync: async (u: UpdateInfo) => {
                    downloads.push({ folder: tag, version: u.TargetFullRelease.Version });
                    if (`v${u.TargetFullRelease.Version}` !== tag) {
                        throw new Error('Network error: Http error: http status: 404');
                    }
                },
            });
        });
        return { factory, heldChecks, downloads, opts };
    }

    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('two checks asked for at once run as one: the pending update and the downloading manager are one release', async () => {
        Config.getInstance().updateAppConfig({ channel: 'stable', githubOwner: 'bilbospocketses', autoUpdate: true });
        const { resolver, resolve, held, state } = heldResolver(() => null);
        const { factory, heldChecks, downloads, opts } = folderManagers();
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: factory,
            releaseFeedResolver: resolver,
            ...quietTimers,
        });
        svc.init();
        await settled(svc);
        resolve.mockClear();
        state.hold = true;
        opts.holdChecks = true;

        // The timer's check and a manual one, asked for together.
        const first = svc.checkForUpdates();
        const second = svc.checkForUpdates();
        // A second side-by-side check would resolve a newer release, published
        // in between: v0.3.0 to the first check's v0.2.0.
        held[0]?.answer(releaseOf('0.2.0'));
        held[1]?.answer(releaseOf('0.3.0'));
        await vi.waitFor(() => expect(heldChecks).toHaveLength(held.length));
        // The adverse order: the newer check answers first, the older one last.
        for (const check of [...heldChecks].reverse()) {
            check.answer();
            await tick();
        }
        await Promise.all([first, second]);

        // Every package was asked of the folder of its own release: no 404.
        for (const d of downloads) expect(d.folder).toBe(`v${d.version}`);
        const s = svc.getStatus();
        expect(s.errorMessage).toBeUndefined();
        expect(s.status).toBe('ready');
        // Because only one check ran: Velopack was asked once, the release lookup once.
        expect(heldChecks).toHaveLength(1);
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(s.availableVersion).toBe('0.2.0');
        expect(downloads).toEqual([{ folder: 'v0.2.0', version: '0.2.0' }]);
    });

    it('a download asked for while a check rebuilds the manager uses the manager the pending update came from', async () => {
        Config.getInstance().updateAppConfig({ channel: 'stable', githubOwner: 'bilbospocketses', autoUpdate: false });
        let newest = releaseOf('0.2.0');
        const { resolver } = heldResolver(() => newest);
        const { factory, heldChecks, downloads, opts } = folderManagers();
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: factory,
            releaseFeedResolver: resolver,
            ...quietTimers,
        });
        opts.holdChecks = true;
        svc.init();
        await vi.waitFor(() => expect(heldChecks).toHaveLength(1));
        heldChecks[0]!.answer();
        await settled(svc);
        expect(svc.getStatus()).toMatchObject({ status: 'ready', availableVersion: '0.2.0' });

        // v0.3.0 is published; the next check rebuilds the manager for it and
        // is still waiting on Velopack when a download of v0.2.0 is asked for.
        newest = releaseOf('0.3.0');
        const check = svc.checkForUpdates();
        await vi.waitFor(() => expect(heldChecks).toHaveLength(2));
        await svc.downloadIfNeeded();
        expect(downloads).toEqual([{ folder: 'v0.2.0', version: '0.2.0' }]);

        heldChecks[1]!.answer();
        await check;
        expect(svc.getStatus()).toMatchObject({ status: 'ready', availableVersion: '0.3.0' });
    });

    it('a channel switch during a check runs its own check of the new channel instead of joining the old one', async () => {
        Config.getInstance().updateAppConfig({ channel: 'beta', githubOwner: 'bilbospocketses', autoUpdate: false });
        const { resolver, resolve, held, state } = heldResolver((channels) =>
            channels[0] === 'stable' ? releaseOf('0.3.0') : null,
        );
        const { factory, opts } = folderManagers();
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: factory,
            releaseFeedResolver: resolver,
            ...quietTimers,
        });
        svc.init();
        await settled(svc);
        state.hold = true;
        const oldCheck = svc.checkForUpdates();
        expect(held).toHaveLength(1);
        state.hold = false;
        opts.holdChecks = false;

        let giveUp: NodeJS.Timeout | undefined;
        const switched = await Promise.race([
            svc.reconfigure('stable', 'bilbospocketses').then(() => 'checked the new channel'),
            new Promise((r) => {
                giveUp = setTimeout(() => r('joined the old check'), 2000);
            }),
        ]);
        clearTimeout(giveUp);
        expect(switched).toBe('checked the new channel');
        expect(resolve.mock.calls.at(-1)![1]).toEqual(['stable']);
        expect(factory.mock.calls.at(-1)![1].ExplicitChannel).toBe('stable');

        // The old check's late answer is dropped: it builds no manager for the old channel.
        const managersBuilt = factory.mock.calls.length;
        held[0]!.answer(releaseOf('0.2.0', 'beta'));
        await oldCheck;
        expect(factory).toHaveBeenCalledTimes(managersBuilt);
        expect(factory.mock.calls.at(-1)![1].ExplicitChannel).toBe('stable');
        expect(svc.getStatus()).toMatchObject({ status: 'idle', pendingChannel: undefined });
    });

    it('a timer check during a manual one joins it, and every check after it runs again', async () => {
        let timerFires: (() => void) | undefined;
        const { resolver, resolve, held, state } = heldResolver(() => null);
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr(),
            releaseFeedResolver: resolver,
            setIntervalFn: (cb) => {
                timerFires = cb;
                return 0 as unknown as NodeJS.Timeout;
            },
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await settled(svc);
        resolve.mockClear();

        state.hold = true;
        const manual = svc.checkForUpdates();
        timerFires!();
        expect(resolve).toHaveBeenCalledTimes(1);
        held[0]!.answer(null);
        await manual;
        expect(svc.getStatus().status).toBe('idle');

        state.hold = false;
        await svc.checkForUpdates();
        timerFires!();
        await settled(svc);
        await svc.checkForUpdates();
        expect(resolve).toHaveBeenCalledTimes(4);
    });

    it('a Velopack check that never answers gives up at its deadline, the next check runs, and its late answer is dropped', async () => {
        // Velopack's HttpSource has no timeout: after a sleep or on a half-open
        // connection checkForUpdatesAsync can wait forever, and every later check
        // in the generation would join it.
        Config.getInstance().updateAppConfig({ channel: 'stable', githubOwner: 'bilbospocketses', autoUpdate: false });
        const { resolver, resolve } = heldResolver(() => releaseOf('0.2.0'));
        const hung = deferred<UpdateInfo | null>();
        let hang = false;
        const checkFn = vi.fn(() => (hang ? hung.promise : Promise.resolve(null)));
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr({ checkForUpdatesAsync: checkFn }),
            releaseFeedResolver: resolver,
            velopackCheckTimeoutMs: 50,
            ...quietTimers,
        });
        svc.init();
        await settled(svc);
        resolve.mockClear();
        checkFn.mockClear();

        hang = true;
        const stuck = svc.checkForUpdates();
        await vi.waitFor(() => expect(svc.getStatus().status).toBe('error'));
        await stuck;
        expect(svc.getStatus().errorMessage).toBe('update check timed out after 0.05 s');

        hang = false;
        await svc.checkForUpdates();
        expect(resolve).toHaveBeenCalledTimes(2);
        expect(checkFn).toHaveBeenCalledTimes(2);
        expect(svc.getStatus()).toMatchObject({ status: 'idle', availableVersion: undefined });

        // The abandoned call finally answers: nothing it says reaches the state.
        hung.resolve(fakeUpdateInfo('0.2.0'));
        await tick();
        const s = svc.getStatus();
        expect(s).toMatchObject({ status: 'idle', availableVersion: undefined, pendingUpdate: undefined });
    });

    it('a check asked for while an update is being applied changes nothing, and checks resume once the apply fails', async () => {
        // The Linux apply downloads the AppImage before its point of no return;
        // the interval timer can fire in the middle of that.
        Config.getInstance().updateAppConfig({
            autoUpdate: false,
            installMode: 'user',
            channel: 'stable',
            githubOwner: 'bilbospocketses',
        });
        const { resolver, resolve } = heldResolver(() => releaseOf('0.2.0', 'linux-stable'));
        const checkFn = vi.fn(async () => fakeUpdateInfo('0.2.0'));
        const assetDownload = deferred<Response>();
        const fetchFn = vi.fn(() => assetDownload.promise) as unknown as typeof fetch;
        const svc = new UpdateService({
            platform: 'linux',
            installRoot: path.join('/fake', 'mount', 'usr'),
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr({ checkForUpdatesAsync: checkFn }),
            releaseFeedResolver: resolver,
            fetchFn,
            ...quietTimers,
        });
        process.env['APPIMAGE'] = '/home/u/Downloads/WsScrcpyWeb-linux-stable.AppImage';
        svc.init();
        await settled(svc);
        expect(svc.getStatus()).toMatchObject({ status: 'ready', availableVersion: '0.2.0' });
        resolve.mockClear();
        checkFn.mockClear();

        const applying = svc.applyUpdate();
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
        await svc.checkForUpdates();
        expect(resolve).not.toHaveBeenCalled();
        expect(checkFn).not.toHaveBeenCalled();
        const during = svc.getStatus();
        expect(during).toMatchObject({ status: 'ready', availableVersion: '0.2.0', pendingChannel: 'stable' });
        expect(during.pendingUpdate?.TargetFullRelease.Version).toBe('0.2.0');

        assetDownload.reject(new Error('network down'));
        await expect(applying).rejects.toThrow(/network down/);
        // Nothing changed during the apply, so its failure checks nothing itself.
        await tick();
        expect(resolve).not.toHaveBeenCalled();
        expect(checkFn).not.toHaveBeenCalled();
        await svc.checkForUpdates();
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(checkFn).toHaveBeenCalledTimes(1);
    });

    it('a channel change during an apply is checked as soon as the apply fails', async () => {
        // reconfigure() clears the pending update and sets idle, but its own
        // check is skipped while the apply runs. Without a check when the apply
        // fails, the new channel waits for the next interval tick (an hour by
        // default) and the Settings change appears to do nothing.
        Config.getInstance().updateAppConfig({
            autoUpdate: false,
            installMode: 'user',
            channel: 'stable',
            githubOwner: 'bilbospocketses',
        });
        const { resolver, resolve } = heldResolver(() => releaseOf('0.2.0', 'linux-stable'));
        const checkFn = vi.fn(async () => fakeUpdateInfo('0.2.0'));
        const assetDownload = deferred<Response>();
        const fetchFn = vi.fn(() => assetDownload.promise) as unknown as typeof fetch;
        const svc = new UpdateService({
            platform: 'linux',
            installRoot: path.join('/fake', 'mount', 'usr'),
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr({ checkForUpdatesAsync: checkFn }),
            releaseFeedResolver: resolver,
            fetchFn,
            ...quietTimers,
        });
        process.env['APPIMAGE'] = '/home/u/Downloads/WsScrcpyWeb-linux-stable.AppImage';
        svc.init();
        await settled(svc);
        expect(svc.getStatus()).toMatchObject({ status: 'ready', availableVersion: '0.2.0' });
        const stableChannels = resolve.mock.calls.at(-1)![1];
        resolve.mockClear();
        checkFn.mockClear();

        const applying = svc.applyUpdate();
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalled());
        await svc.reconfigure('beta', 'bilbospocketses');
        expect(resolve).not.toHaveBeenCalled();
        expect(checkFn).not.toHaveBeenCalled();
        expect(svc.getStatus()).toMatchObject({ status: 'idle', pendingUpdate: undefined });

        assetDownload.reject(new Error('network down'));
        await expect(applying).rejects.toThrow(/network down/);
        await settled(svc);
        expect(resolve).toHaveBeenCalledTimes(1);
        const betaChannels = resolve.mock.calls[0]![1];
        expect(betaChannels).not.toEqual(stableChannels);
        expect(betaChannels).toContain('linux-beta');
        expect(checkFn).toHaveBeenCalledTimes(1);
    });

    // ── VelopackLocator strategy (platform-split) ──────────────────────────
    //
    // BOTH platforms hand Velopack an explicit locator. `platform` is injected
    // so both branches run on any host.
    //
    // Linux history: beta.21 (PR #237) passed NO locator, delegating to
    // Velopack's native auto_locate_app_manifest. That FAILED on real AppImages:
    // auto_locate (lib-rust locator.rs) finds the install by searching
    // `std::env::current_exe()` for "/usr/bin/" — but our server runs under the
    // app's own Node binary in <dataRoot>/dependencies/node/,
    // which has no "/usr/bin/" in its path, so auto_locate returns "Could not
    // locate '/usr/bin/'" → UpdateManager construction throws → mgr=null → every
    // check silently no-ops. The fix hand-builds the locator anchored on
    // installRoot (= resolve(__dirname,'..','..') = <mount>/usr at runtime),
    // whose `bin` subdir is the Velopack contents dir. (beta.19's hand-built
    // attempt had the right anchor but did ../.. then re-appended usr/bin →
    // doubled `usr/usr/bin`; the contents dir is just installRoot/bin.)

    it('init (win32): passes an explicit Windows VelopackLocatorConfig', () => {
        const installRoot = path.join('/fake', 'install', 'root');
        let receivedLocator: unknown;
        const factory = vi.fn((_feed: unknown, _opts: UpdateOptions, locator?: unknown) => {
            receivedLocator = locator;
            return fakeMgr();
        });
        const svc = new UpdateService({
            platform: 'win32',
            installRoot,
            existsSync: () => true,
            updateManagerFactory: factory,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();

        expect(receivedLocator).toBeDefined();
        const loc = receivedLocator as Record<string, unknown>;
        expect(loc['RootAppDir']).toBe(installRoot);
        expect(loc['UpdateExePath']).toBe(path.join(installRoot, 'Update.exe'));
        expect(loc['PackagesDir']).toBe(path.join(installRoot, 'packages'));
        expect(loc['ManifestPath']).toBe(path.join(installRoot, 'current', 'sq.version'));
        expect(loc['CurrentBinaryDir']).toBe(path.join(installRoot, 'current'));
        expect(loc['IsPortable']).toBe(false);
    });

    it('init (linux): passes an explicit hand-built locator anchored on the AppImage mount', () => {
        // beforeEach sets APPIMAGE (= /fake/WsScrcpyWeb.AppImage) so the Linux
        // production-marker check passes and the factory actually runs.
        // installRoot stands in for resolve(__dirname,'..','..') = <mount>/usr.
        const installRoot = path.join('/fake', 'mount', 'usr');
        let receivedLocator: unknown;
        const factory = vi.fn((_feed: unknown, _opts: UpdateOptions, locator?: unknown) => {
            receivedLocator = locator;
            return fakeMgr();
        });
        const svc = new UpdateService({
            platform: 'linux',
            installRoot,
            existsSync: () => true,
            updateManagerFactory: factory,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();

        expect(receivedLocator).toBeDefined();
        const loc = receivedLocator as Record<string, unknown>;
        const contentsDir = path.join(installRoot, 'bin'); // <mount>/usr/bin
        // RootAppDir is the AppImage FILE path ($APPIMAGE), mirroring Velopack's
        // Linux auto_locate (locator.rs:505) — NOT the mount dir.
        expect(loc['RootAppDir']).toBe('/fake/WsScrcpyWeb.AppImage');
        expect(loc['UpdateExePath']).toBe(path.join(contentsDir, 'UpdateNix'));
        expect(loc['ManifestPath']).toBe(path.join(contentsDir, 'sq.version'));
        expect(loc['CurrentBinaryDir']).toBe(contentsDir);
        expect(loc['PackagesDir']).toBe('/var/tmp/velopack/WsScrcpyWeb/packages');
        expect(loc['IsPortable']).toBe(true);
    });

    it('reconfigure: re-passes the platform-appropriate locator on both platforms', async () => {
        for (const platform of ['win32', 'linux'] as const) {
            const installRoot = path.join('/fake', 'install', 'root');
            const captured: unknown[] = [];
            const factory = vi.fn((_feed: unknown, _opts: UpdateOptions, locator?: unknown) => {
                captured.push(locator);
                return fakeMgr();
            });
            const svc = new UpdateService({
                platform,
                installRoot,
                existsSync: () => true,
                updateManagerFactory: factory,
                setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
                clearIntervalFn: () => undefined,
            });
            svc.init();
            await svc.reconfigure('beta', 'a-different-owner');

            // init + reconfigure both invoked the factory.
            expect(captured.length).toBeGreaterThanOrEqual(2);
            const initLocator = captured[0];
            const reconfigLocator = captured[captured.length - 1];
            if (platform === 'win32') {
                expect((initLocator as Record<string, unknown>)['RootAppDir']).toBe(installRoot);
                expect(reconfigLocator).toEqual(initLocator);
            } else {
                // Linux: hand-built locator anchored on the mount, re-passed unchanged.
                const contentsDir = path.join(installRoot, 'bin');
                expect((initLocator as Record<string, unknown>)['UpdateExePath']).toBe(
                    path.join(contentsDir, 'UpdateNix'),
                );
                expect((initLocator as Record<string, unknown>)['CurrentBinaryDir']).toBe(contentsDir);
                expect(reconfigLocator).toEqual(initLocator);
            }
        }
    });

    // ── ExplicitChannel (platform-aware) ───────────────────────────────────
    //
    // Linux publishes per-platform channels (linux-beta / linux-stable) so its
    // releases.<channel>.json feed doesn't collide with the Windows beta/stable
    // feeds on the same GitHub release. The app must therefore query
    // 'linux-<channel>' on Linux. Windows queries the raw channel. (Without
    // this, a Linux app reads releases.beta.json — which lists only the Windows
    // package — and finds no Linux update even after the locator is fixed.)

    it('init (linux): ExplicitChannel is prefixed linux-<channel>', () => {
        Config.getInstance().updateAppConfig({ channel: 'beta' });
        let opts: UpdateOptions | undefined;
        const factory = vi.fn((_feed: unknown, o: UpdateOptions) => {
            opts = o;
            return fakeMgr();
        });
        const svc = new UpdateService({
            platform: 'linux',
            installRoot: path.join('/fake', 'mount', 'usr'),
            existsSync: () => true,
            updateManagerFactory: factory,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        expect(opts?.ExplicitChannel).toBe('linux-beta');
    });

    it('init (win32): ExplicitChannel is the raw channel (no prefix)', () => {
        Config.getInstance().updateAppConfig({ channel: 'beta' });
        let opts: UpdateOptions | undefined;
        const factory = vi.fn((_feed: unknown, o: UpdateOptions) => {
            opts = o;
            return fakeMgr();
        });
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: path.join('/fake', 'root'),
            existsSync: () => true,
            updateManagerFactory: factory,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        expect(opts?.ExplicitChannel).toBe('beta');
    });

    it('reconfigure (linux): ExplicitChannel is prefixed linux-<channel>', async () => {
        let lastOpts: UpdateOptions | undefined;
        const factory = vi.fn((_feed: unknown, o: UpdateOptions) => {
            lastOpts = o;
            return fakeMgr();
        });
        const svc = new UpdateService({
            platform: 'linux',
            installRoot: path.join('/fake', 'mount', 'usr'),
            existsSync: () => true,
            updateManagerFactory: factory,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.reconfigure('stable', 'bilbospocketses');
        expect(lastOpts?.ExplicitChannel).toBe('linux-stable');
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
            platform: 'win32',
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

    it('checkForUpdates (linux): autoUpdate=true does NOT download the nupkg; status=ready', async () => {
        Config.getInstance().updateAppConfig({ autoUpdate: true });
        const downloadUpdateAsync = vi.fn(async () => undefined);
        const mgr = fakeMgr({
            checkForUpdatesAsync: async () => fakeUpdateInfo('0.2.0'),
            downloadUpdateAsync,
        });
        const svc = new UpdateService({
            platform: 'linux',
            installRoot: path.join('/fake', 'mount', 'usr'),
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        process.env['APPIMAGE'] = '/home/u/Downloads/App.AppImage';
        svc.init();
        await svc.checkForUpdates();
        expect(svc.getStatus().status).toBe('ready');
        expect(downloadUpdateAsync).not.toHaveBeenCalled();
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
            // Pin win32: checkForUpdates only triggers downloadIfNeeded off Linux
            // (Linux skips the unused nupkg download). This covers the download path.
            platform: 'win32',
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        // Let init()'s own fire-and-forget check (which downloads via `mgr`) finish.
        await settled(svc);
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
        // Replace mgr after init so we can inspect progress live. The resolved
        // release is unchanged, so the check keeps this manager rather than
        // building a new one.
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
            // Pin win32: checkForUpdates only triggers downloadIfNeeded off Linux.
            platform: 'win32',
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
            // Windows local mode (operation-server helper). The Linux local-mode
            // path (waitExitThenApplyUpdate) has its own test below; pin win32 so
            // this Windows assertion is deterministic on a Linux CI host too.
            platform: 'win32',
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

    // Finding 2: pre-apply hygiene used to `taskkill /F /IM adb.exe /T`, which
    // killed every adb on the machine (Android Studio's included). It now reaps
    // only processes running the app's own configured adb binary.
    it("applyUpdate: pre-apply reaps only the app's own adb (config.adbPath), never taskkill /IM adb.exe", async () => {
        // A user override, so the assertion proves the reaper gets the CONFIGURED
        // path rather than a recomputed default.
        const ownAdb = 'D:\\custom\\platform-tools\\adb.exe';
        fs.writeFileSync(process.env[EnvName.CONFIG_PATH]!, JSON.stringify({ adbPath: ownAdb }));
        Config._resetForTest();
        Config.getInstance().updateAppConfig({ autoUpdate: false });
        expect(Config.getInstance().adbPath).toBe(ownAdb);
        const info = fakeUpdateInfo('0.2.0');
        const reapOwnAdbFn = vi.fn(async (_adbPath: string) => 1);
        const execFileMock = vi.mocked(child_process.execFile);
        execFileMock.mockClear();
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr({ checkForUpdatesAsync: async () => info }),
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
            reapOwnAdbFn,
        });
        svc.init();
        await svc.checkForUpdates();
        expect(svc.getStatus().status).toBe('ready');

        await svc.applyUpdate();

        expect(reapOwnAdbFn).toHaveBeenCalledTimes(1);
        expect(reapOwnAdbFn).toHaveBeenCalledWith(ownAdb);
        const blanket = execFileMock.mock.calls.filter(
            (call) => Array.isArray(call[1]) && (call[1] as unknown[]).some((a) => a === '/IM'),
        );
        expect(blanket).toEqual([]);
    });

    it('applyUpdate: closes the open streams as a deliberate stop before adb kill-server', async () => {
        // kill-server kills each stream's scrcpy-server; a stream still open then
        // told its viewer "stream failed" over an update they asked for.
        Config.getInstance().updateAppConfig({ autoUpdate: false });
        const order: string[] = [];
        const stream = {
            closeForShutdown: () => {
                order.push('close stream');
                liveStreams.remove(stream);
            },
        };
        liveStreams.add(stream);
        const killSpy = vi.spyOn(AdbClient.prototype, 'killServer').mockImplementation(async () => {
            order.push('kill-server');
        });
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr({ checkForUpdatesAsync: async () => fakeUpdateInfo('0.2.0') }),
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
            reapOwnAdbFn: async () => 0,
        });
        svc.init();
        await svc.checkForUpdates();

        try {
            await svc.applyUpdate();
        } finally {
            killSpy.mockRestore();
        }

        expect(order).toEqual(['close stream', 'kill-server']);
        expect(liveStreams.size()).toBe(0);
        // The process exits next, so a stream opened now is refused (1001).
        expect(liveStreams.isStopping()).toBe(true);
        liveStreams.cancelStop();
    });

    it('applyUpdate: an apply that fails after its point of no return accepts new streams again', async () => {
        // The process keeps running after a failed apply (UpdatesApi answers
        // 500), so it must not go on refusing every stream as if it were stopping.
        // Windows service mode reaches its point of no return (the hygiene closes
        // the streams as a stop) before Velopack's waitExitThenApplyUpdate, so a
        // throw from that call is a failure AFTER it.
        Config.getInstance().updateAppConfig({ autoUpdate: false, installMode: 'user-service' });
        let closed = 0;
        const stream = {
            closeForShutdown: () => {
                closed++;
                liveStreams.remove(stream);
            },
        };
        liveStreams.add(stream);
        const killSpy = vi.spyOn(AdbClient.prototype, 'killServer').mockResolvedValue(undefined);
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () =>
                fakeMgr({
                    checkForUpdatesAsync: async () => fakeUpdateInfo('0.2.0'),
                    waitExitThenApplyUpdate: () => {
                        throw new Error('velopack apply failed');
                    },
                }),
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();

        try {
            await expect(svc.applyUpdate()).rejects.toThrow(/velopack apply failed/);
        } finally {
            killSpy.mockRestore();
        }

        expect(closed).toBe(1);
        expect(liveStreams.isStopping()).toBe(false);
        // The hand-off did not happen, so its markers are gone too.
        expect(fs.existsSync(Config.getInstance().applyUpdatePendingMarkerPath)).toBe(false);
        expect(fs.existsSync(Config.getInstance().suppressBrowserOpenMarkerPath)).toBe(false);
    });

    it('applyUpdate: a failure before the point of no return leaves a stop it did not start alone', async () => {
        // Only a stop this apply started is cancelled. A stop already under way
        // (a stand-in for a real shutdown racing the apply) must stay in force.
        Config.getInstance().updateAppConfig({ autoUpdate: false, installMode: 'user' });
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr({ checkForUpdatesAsync: async () => fakeUpdateInfo('0.2.0') }),
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();
        // The verify manifest fails to write: a failure before the point of no return.
        const manifestPath = Config.getInstance().applyUpdateVerifyManifestPath;
        const realWriteFile = fs.promises.writeFile;
        const writeSpy = vi
            .spyOn(fs.promises, 'writeFile')
            .mockImplementation((file, data, options) =>
                file === manifestPath
                    ? Promise.reject(new Error('EACCES: manifest not writable'))
                    : realWriteFile(file, data, options),
            );
        liveStreams.closeAllForShutdown();

        try {
            await expect(svc.applyUpdate()).rejects.toThrow(/manifest not writable/);
        } finally {
            writeSpy.mockRestore();
        }

        expect(liveStreams.isStopping()).toBe(true);
    });

    it('applyUpdate: a second apply while one is running is refused', async () => {
        Config.getInstance().updateAppConfig({ autoUpdate: false, installMode: 'user-service' });
        const applyFn = vi.fn();
        const killSpy = vi.spyOn(AdbClient.prototype, 'killServer').mockResolvedValue(undefined);
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () =>
                fakeMgr({
                    checkForUpdatesAsync: async () => fakeUpdateInfo('0.2.0'),
                    waitExitThenApplyUpdate: applyFn,
                }),
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();

        try {
            const first = svc.applyUpdate();
            await expect(svc.applyUpdate()).rejects.toThrow(/already in progress/);
            await first;
        } finally {
            killSpy.mockRestore();
        }

        expect(applyFn).toHaveBeenCalledTimes(1);
    });

    it('applyUpdate (windows local): a verify manifest that cannot be written fails the apply and closes no stream', async () => {
        // The manifest is written before the point of no return. Its failure used
        // to be caught and answered like a hand-off, so UpdatesApi exited with the
        // streams still open and no update applied.
        Config.getInstance().updateAppConfig({ autoUpdate: false, installMode: 'user' });
        let closed = 0;
        const stream = {
            closeForShutdown: () => {
                closed++;
                liveStreams.remove(stream);
            },
        };
        liveStreams.add(stream);
        const killSpy = vi.spyOn(AdbClient.prototype, 'killServer').mockResolvedValue(undefined);
        const manifestPath = Config.getInstance().applyUpdateVerifyManifestPath;
        const realWriteFile = fs.promises.writeFile;
        const writeSpy = vi
            .spyOn(fs.promises, 'writeFile')
            .mockImplementation((file, data, options) =>
                file === manifestPath
                    ? Promise.reject(new Error('EACCES: manifest not writable'))
                    : realWriteFile(file, data, options),
            );
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr({ checkForUpdatesAsync: async () => fakeUpdateInfo('0.2.0') }),
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();

        try {
            await expect(svc.applyUpdate()).rejects.toThrow(/manifest not writable/);
            expect(closed).toBe(0);
            expect(liveStreams.isStopping()).toBe(false);
            expect(fs.existsSync(Config.getInstance().applyUpdatePendingMarkerPath)).toBe(false);
        } finally {
            writeSpy.mockRestore();
            killSpy.mockRestore();
            liveStreams.remove(stream);
        }
    });

    it('applyUpdate: an apply that fails before its point of no return closes no stream', async () => {
        // A bad checksum fails before the point of no return (since 2026-10-06),
        // so the streams stay open and nothing was stopped.
        Config.getInstance().updateAppConfig({
            autoUpdate: false,
            installMode: 'user',
            channel: 'beta',
            githubOwner: 'bilbospocketses',
        });
        let closed = 0;
        const stream = {
            closeForShutdown: () => {
                closed++;
                liveStreams.remove(stream);
            },
        };
        liveStreams.add(stream);
        const killSpy = vi.spyOn(AdbClient.prototype, 'killServer').mockResolvedValue(undefined);
        const sums = `${'0'.repeat(64)}  ./linux-final/WsScrcpyWeb-linux-beta.AppImage\n`;
        const fetchFn = vi.fn(async (url: string) =>
            url.endsWith('.AppImage') ? new Response(Buffer.from('CORRUPT')) : new Response(sums),
        ) as unknown as typeof fetch;
        const svc = new UpdateService({
            platform: 'linux',
            installRoot: path.join('/fake', 'mount', 'usr'),
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr({ checkForUpdatesAsync: async () => fakeUpdateInfo('0.1.30-beta.26') }),
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
            fetchFn,
        });
        process.env['APPIMAGE'] = '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage';
        svc.init();
        await svc.checkForUpdates();

        try {
            await expect(svc.applyUpdate()).rejects.toThrow(/mismatch/i);
        } finally {
            killSpy.mockRestore();
        }

        expect(closed).toBe(0);
        expect(liveStreams.isStopping()).toBe(false);
        liveStreams.remove(stream);
    });

    it('applyUpdate: with the default reaper, no execFile call ever carries /IM', async () => {
        Config.getInstance().updateAppConfig({ autoUpdate: false });
        const info = fakeUpdateInfo('0.2.0');
        const execFileMock = vi.mocked(child_process.execFile);
        execFileMock.mockClear();
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr({ checkForUpdatesAsync: async () => info }),
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();
        await svc.applyUpdate();

        const blanket = execFileMock.mock.calls.filter(
            (call) => Array.isArray(call[1]) && (call[1] as unknown[]).some((a) => a === '/IM'),
        );
        expect(blanket).toEqual([]);
    });

    // v0.1.25-beta.8 smoke A.2 regression: when installMode is a service mode,
    // restart MUST be false. The --veloapp-updated hook's `servy-cli restart` is
    // solely responsible for bringing the service back under SCM/Servy supervision.
    // Velopack's parallel post-swap relaunch (restart=true) would spawn a ghost
    // LocalSystem launcher that holds the single-instance mutex and starves out
    // Servy's --recoveryAction=RestartProcess attempts, leaving SCM with the
    // service stuck Stopped until reboot. See §32 in todo_ws_scrcpy_web.md.
    it.each([['user-service' as const], ['system-service' as const]])(
        'applyUpdate (%s): waitExitThenApplyUpdate called with restart=false',
        async (installMode) => {
            Config.getInstance().updateAppConfig({ autoUpdate: false, installMode });
            const info = fakeUpdateInfo('0.2.0');
            const applyFn = vi.fn();
            const mgr = fakeMgr({
                checkForUpdatesAsync: async () => info,
                waitExitThenApplyUpdate: applyFn,
            });
            const svc = new UpdateService({
                // Windows service mode keeps Velopack's waitExitThenApplyUpdate. Linux
                // service mode now uses the download-based apply (item 39), so this
                // assertion is win32-specific — without the pin it breaks on Linux CI.
                platform: 'win32',
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
        },
    );

    // §40: local-mode variants (user/system) also skip waitExitThenApplyUpdate.
    // The supervisor's local-post-stop.bat calls Update.exe apply directly.
    it.each([['user' as const], ['system' as const]])(
        'applyUpdate (%s): does NOT call waitExitThenApplyUpdate (local mode)',
        async (installMode) => {
            Config.getInstance().updateAppConfig({ autoUpdate: false, installMode });
            const info = fakeUpdateInfo('0.2.0');
            const applyFn = vi.fn();
            const mgr = fakeMgr({
                checkForUpdatesAsync: async () => info,
                waitExitThenApplyUpdate: applyFn,
            });
            const svc = new UpdateService({
                // Windows local mode; Linux local mode is tested separately. Pin
                // win32 so this Windows assertion holds on a Linux CI host too.
                platform: 'win32',
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
        },
    );

    // §40: applyUpdate writes the apply-update-pending marker in ALL modes.
    // In local mode, Node also spawns the operation-server helper and polls
    // for its port file (spawn is module-mocked via vi.mock('child_process')).
    // In service mode, Servy's post-stop bat handles the operation-server.
    it.each([['user-service' as const], ['system-service' as const], ['user' as const], ['system' as const]])(
        'applyUpdate (%s): writes marker (§40)',
        async (installMode) => {
            Config.getInstance().updateAppConfig({ autoUpdate: false, installMode });
            // Spy on fs.promises.writeFile + mkdir to capture the marker write
            // without polluting real ProgramData. Mock as no-ops since we only
            // care about the call shape, not the effect on disk.
            const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
            const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
            using _restore = {
                [Symbol.dispose]() {
                    writeFileSpy.mockRestore();
                    mkdirSpy.mockRestore();
                },
            };

            const info = fakeUpdateInfo('0.2.0');
            const applyFn = vi.fn();
            const mgr = fakeMgr({
                checkForUpdatesAsync: async () => info,
                waitExitThenApplyUpdate: applyFn,
            });
            const svc = new UpdateService({
                // Pin win32: service variants call waitExitThenApplyUpdate; the
                // local (user/system) variants use the Windows operation-server
                // helper (not waitExitThenApplyUpdate). Linux local mode differs and
                // is covered separately — without this pin the local variants fail
                // on a Linux CI host (they'd hit the new Linux apply branch).
                platform: 'win32',
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
                (c) => typeof c[0] === 'string' && (c[0] as string).endsWith('apply-update-pending'),
            );
            expect(markerCalls).toHaveLength(1);
            expect(mkdirSpy).toHaveBeenCalled();
        },
    );

    // §49: in Windows LOCAL mode (user/system) the operation-server re-extracts
    // the nupkg itself, so Node must hand it the Velopack-authenticated
    // version + filename + SHA-256 to verify against. Service mode uses
    // Velopack's own verified apply (no manifest); Linux uses SHA256SUMS.
    it.each([
        ['user' as const, true],
        ['system' as const, true],
        ['user-service' as const, false],
        ['system-service' as const, false],
    ])(
        'applyUpdate (%s): writes apply-update-verify.json only in local mode (§49)',
        async (installMode, expectManifest) => {
            Config.getInstance().updateAppConfig({ autoUpdate: false, installMode });
            const writeFileSpy = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue(undefined);
            const mkdirSpy = vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
            // Local mode polls for the operation-server port file; return one so the
            // poll resolves immediately instead of waiting out the 5s timeout.
            const readFileSpy = vi.spyOn(fs.promises, 'readFile').mockResolvedValue('8001' as never);
            using _restore = {
                [Symbol.dispose]() {
                    writeFileSpy.mockRestore();
                    mkdirSpy.mockRestore();
                    readFileSpy.mockRestore();
                },
            };

            const info = fakeUpdateInfo('0.2.0');
            info.TargetFullRelease.SHA256 = 'A1B2C3';
            info.TargetFullRelease.FileName = 'ws-scrcpy-web-0.2.0-full.nupkg';
            const mgr = fakeMgr({
                checkForUpdatesAsync: async () => info,
                waitExitThenApplyUpdate: vi.fn(),
            });
            const svc = new UpdateService({
                platform: 'win32',
                installRoot: '/fake-install-root',
                existsSync: () => true,
                updateManagerFactory: () => mgr,
                setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
                clearIntervalFn: () => undefined,
            });
            svc.init();
            await svc.checkForUpdates();
            await svc.applyUpdate();

            const manifestCalls = writeFileSpy.mock.calls.filter(
                (c) => typeof c[0] === 'string' && (c[0] as string).endsWith('apply-update-verify.json'),
            );
            if (expectManifest) {
                expect(manifestCalls).toHaveLength(1);
                const written = JSON.parse(manifestCalls[0]![1] as string);
                expect(written).toEqual({
                    version: '0.2.0',
                    fileName: 'ws-scrcpy-web-0.2.0-full.nupkg',
                    sha256: 'A1B2C3',
                });
            } else {
                expect(manifestCalls).toHaveLength(0);
            }
        },
    );

    // Linux local-mode apply: replaces Velopack's broken UpdateNix apply with a
    // hand-rolled download -> verify-sha256 -> spawn-helper. (Velopack 1.0.1's apply
    // fails on our AppImage — see docs/specs/2026-06-01-linux-appimage-self-update-design.md.)
    it('applyUpdate (linux local): downloads + verifies + spawns helper; no waitExitThenApplyUpdate', async () => {
        const { createHash } = await import('crypto');
        Config.getInstance().updateAppConfig({
            autoUpdate: false,
            installMode: 'user',
            channel: 'beta',
            githubOwner: 'bilbospocketses',
        });
        const appImageBytes = Buffer.from('NEW-APPIMAGE-CONTENT');
        const goodHash = createHash('sha256').update(appImageBytes).digest('hex');
        const sums = `${goodHash}  ./linux-final/WsScrcpyWeb-linux-beta.AppImage\n`;
        const fetchFn = vi.fn(async (url: string) =>
            url.endsWith('.AppImage') ? new Response(appImageBytes) : new Response(sums),
        ) as unknown as typeof fetch;
        const applyFn = vi.fn();
        const mgr = fakeMgr({
            checkForUpdatesAsync: async () => fakeUpdateInfo('0.1.30-beta.26'),
            waitExitThenApplyUpdate: applyFn,
        });
        const spawnMock = vi.mocked(child_process.spawn);
        spawnMock.mockClear();
        const svc = new UpdateService({
            platform: 'linux',
            installRoot: path.join('/fake', 'mount', 'usr'),
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
            fetchFn,
        });
        process.env['APPIMAGE'] = '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage';
        svc.init();
        await svc.checkForUpdates();
        expect(svc.getStatus().status).toBe('ready');

        const result = await svc.applyUpdate();
        expect(result.redirectPort).toBeNull();
        expect(applyFn).not.toHaveBeenCalled();
        expect(spawnMock).toHaveBeenCalledTimes(1);
        // #27: the helper is spawned so it OUTLIVES the app's cgroup teardown.
        // On a systemd host it's wrapped in `systemd-run --user --collect` (cmd =
        // systemd-run, launcher in argv); on a non-systemd host it's spawned
        // directly (cmd = launcher). Assert on the full command line so the test
        // is robust across both — buildDetachedSpawn's exact wrapping (incl. the
        // setsid/bare fallback) is covered by systemTools.test.ts.
        const [bin, argv] = spawnMock.mock.calls[0]!;
        const cmdline = [String(bin), ...(argv as string[]).map(String)].join(' ');
        expect(cmdline).toMatch(/control[\\/]operation-server[\\/]ws-scrcpy-web-launcher\.exe/);
        expect(cmdline).toContain('--linux-apply');
        expect(cmdline).toContain('--target /home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage');
    });

    it('applyUpdate (linux local): SHA mismatch aborts, no helper spawn', async () => {
        Config.getInstance().updateAppConfig({
            autoUpdate: false,
            installMode: 'user',
            channel: 'beta',
            githubOwner: 'bilbospocketses',
        });
        const sums = `${'0'.repeat(64)}  ./linux-final/WsScrcpyWeb-linux-beta.AppImage\n`;
        const fetchFn = vi.fn(async (url: string) =>
            url.endsWith('.AppImage') ? new Response(Buffer.from('CORRUPT')) : new Response(sums),
        ) as unknown as typeof fetch;
        const spawnMock = vi.mocked(child_process.spawn);
        spawnMock.mockClear();
        const svc = new UpdateService({
            platform: 'linux',
            installRoot: path.join('/fake', 'mount', 'usr'),
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr({ checkForUpdatesAsync: async () => fakeUpdateInfo('0.1.30-beta.26') }),
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
            fetchFn,
        });
        process.env['APPIMAGE'] = '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage';
        svc.init();
        await svc.checkForUpdates();
        await expect(svc.applyUpdate()).rejects.toThrow(/mismatch/i);
        expect(spawnMock).not.toHaveBeenCalled();
    });

    // Linux SERVICE-mode apply (Phase 2 / item 39): the early-return to
    // Velopack is now win32-only, so Linux service mode falls through to the
    // download->verify->spawn-helper path with a --service-restart directive
    // (the helper stops/swaps/starts the unit). user-service targets the home
    // $APPIMAGE (user manager); system-service targets the /opt staged copy and
    // passes --relabel (root, system manager). On the (non-systemd) test host
    // buildDetachedSpawn falls back to a bare exec, so we assert the helper argv.
    it.each([
        ['user-service' as const, 'user' as const],
        ['system-service' as const, 'system' as const],
    ])(
        'applyUpdate (linux %s): spawns helper with --service-restart; no waitExitThenApplyUpdate',
        async (installMode, scope) => {
            const { createHash } = await import('crypto');
            Config.getInstance().updateAppConfig({
                autoUpdate: false,
                installMode,
                channel: 'beta',
                githubOwner: 'bilbospocketses',
            });
            const appImageBytes = Buffer.from('NEW-APPIMAGE-CONTENT');
            const goodHash = createHash('sha256').update(appImageBytes).digest('hex');
            const sums = `${goodHash}  ./linux-final/WsScrcpyWeb-linux-beta.AppImage\n`;
            const fetchFn = vi.fn(async (url: string) =>
                url.endsWith('.AppImage') ? new Response(appImageBytes) : new Response(sums),
            ) as unknown as typeof fetch;
            const applyFn = vi.fn();
            const mgr = fakeMgr({
                checkForUpdatesAsync: async () => fakeUpdateInfo('0.1.30-beta.40'),
                waitExitThenApplyUpdate: applyFn,
            });
            const spawnMock = vi.mocked(child_process.spawn);
            spawnMock.mockClear();
            const stageMock = vi.mocked(stageSystemHelper);
            stageMock.mockClear();
            const svc = new UpdateService({
                platform: 'linux',
                installRoot: path.join('/fake', 'mount', 'usr'),
                existsSync: () => true,
                updateManagerFactory: () => mgr,
                setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
                clearIntervalFn: () => undefined,
                fetchFn,
            });
            process.env['APPIMAGE'] = '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage';
            svc.init();
            await svc.checkForUpdates();
            expect(svc.getStatus().status).toBe('ready');

            const result = await svc.applyUpdate();
            expect(result.redirectPort).toBeNull();
            // Linux service mode no longer routes to Velopack's (broken) apply.
            expect(applyFn).not.toHaveBeenCalled();
            expect(spawnMock).toHaveBeenCalledTimes(1);
            const [bin, argv] = spawnMock.mock.calls[0]!;
            const cmdline = [String(bin), ...(argv as string[]).map(String)].join(' ');
            if (scope === 'system') {
                // FD2: staged from the data-root copy, and the staged bin_t copy is what runs.
                expect(stageMock).toHaveBeenCalledWith(
                    expect.stringMatching(/control[\\/]operation-server[\\/]ws-scrcpy-web-launcher\.exe$/),
                );
                expect(cmdline).toContain(STAGED);
                expect(cmdline).not.toMatch(/operation-server[\\/]ws-scrcpy-web-launcher\.exe/);
            } else {
                // The user manager runs it as the user: no SELinux exec rule applies.
                expect(stageMock).not.toHaveBeenCalled();
                expect(cmdline).toMatch(/control[\\/]operation-server[\\/]ws-scrcpy-web-launcher\.exe/);
            }
            expect(cmdline).toContain('--linux-apply');
            expect(cmdline).toContain(`--service-restart ${scope}`);
            expect(cmdline).toContain('--unit WsScrcpyWeb');
            if (scope === 'system') {
                expect(cmdline).toContain('--target /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage');
                expect(cmdline).toContain('--relabel');
            } else {
                expect(cmdline).toContain('--target /home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage');
                expect(cmdline).not.toContain('--relabel');
            }
        },
    );

    // Linux MACHINE-WIDE-NO-SERVICE apply (Phase 3 / P3b): the user runs the
    // root-owned /opt AppImage directly (NOT a service), so $APPIMAGE lives under
    // /opt/ws-scrcpy-web/ while installMode is NOT a service mode. A `cp` over /opt
    // would ETXTBSY the running file and the per-user flock blocks a fresh /opt
    // instance until the old one exits — so applyUpdate (1) elevates a RENAME-based
    // swap via ONE pkexec (buildMachineWideUpdateScript), then (2) spawns a
    // relaunch-ONLY helper (NO --staged) that waits for our pid to exit (releasing
    // the flock) + relaunches /opt. The relaunch must NOT be elevated.
    it.each([['user' as const], ['system' as const], [null]])(
        'applyUpdate (linux machine-wide-no-service, installMode=%s): pkexec rename-swap + relaunch-only helper',
        async (installMode) => {
            const { createHash } = await import('crypto');
            Config.getInstance().updateAppConfig({
                autoUpdate: false,
                installMode,
                channel: 'beta',
                githubOwner: 'bilbospocketses',
            });
            const appImageBytes = Buffer.from('NEW-APPIMAGE-CONTENT');
            const goodHash = createHash('sha256').update(appImageBytes).digest('hex');
            const sums = `${goodHash}  ./linux-final/WsScrcpyWeb-linux-beta.AppImage\n`;
            const fetchFn = vi.fn(async (url: string) =>
                url.endsWith('.AppImage') ? new Response(appImageBytes) : new Response(sums),
            ) as unknown as typeof fetch;
            const applyFn = vi.fn();
            const mgr = fakeMgr({
                checkForUpdatesAsync: async () => fakeUpdateInfo('0.1.31-beta.2'),
                waitExitThenApplyUpdate: applyFn,
            });
            const pkexecMock = vi.fn<(shellCmd: string, label: string) => Promise<string>>(async () => '');
            const spawnMock = vi.mocked(child_process.spawn);
            spawnMock.mockClear();
            const svc = new UpdateService({
                platform: 'linux',
                installRoot: path.join('/fake', 'mount', 'usr'),
                existsSync: () => true,
                updateManagerFactory: () => mgr,
                setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
                clearIntervalFn: () => undefined,
                fetchFn,
                runPkexecFn: pkexecMock,
            });
            // The discriminator is the /opt $APPIMAGE path (not installMode); the
            // machine-wide install leaves installMode at whatever it was (user/system/null).
            process.env['APPIMAGE'] = '/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage';
            svc.init();
            await svc.checkForUpdates();
            expect(svc.getStatus().status).toBe('ready');

            const result = await svc.applyUpdate();
            expect(result.redirectPort).toBeNull();
            // Velopack's (broken) apply is never used.
            expect(applyFn).not.toHaveBeenCalled();

            // (1) the elevated RENAME-swap ran under ONE pkexec with the right label.
            expect(pkexecMock).toHaveBeenCalledTimes(1);
            const [script, label] = pkexecMock.mock.calls[0]!;
            expect(label).toBe('machine-wide-update');
            expect(script).toContain('mv -f');
            expect(script).toContain('/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage.bak'); // old → .bak
            expect(script).toContain('"/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage"'); // staged → /opt
            expect(script).toContain('.new'); // the staged download moved in
            expect(script).toContain("'0.1.31-beta.2' > /opt/ws-scrcpy-web/VERSION"); // new VERSION
            expect(script).not.toMatch(/\bcp\b/); // never cp (ETXTBSY)

            // (2) the relaunch-only helper is spawned (NOT under pkexec): no --staged,
            // no --service-restart — just --target /opt + --wait-pid <ourpid>.
            expect(spawnMock).toHaveBeenCalledTimes(1);
            const [bin, argv] = spawnMock.mock.calls[0]!;
            const cmdline = [String(bin), ...(argv as string[]).map(String)].join(' ');
            expect(cmdline).toMatch(/control[\\/]operation-server[\\/]ws-scrcpy-web-launcher\.exe/);
            expect(cmdline).toContain('--linux-apply');
            expect(cmdline).toContain('--target /opt/ws-scrcpy-web/WsScrcpyWeb.AppImage');
            expect(cmdline).toContain(`--wait-pid ${process.pid}`);
            expect(cmdline).not.toContain('--staged'); // relaunch-only: no swap by the helper
            expect(cmdline).not.toContain('--service-restart');
            expect(cmdline).not.toContain('--relabel');
        },
    );

    // Smoke 14.10: when the machine-wide update's pkexec does not run (the user
    // cancelled the prompt, or it failed), nothing was swapped. The error reaches
    // the caller unchanged, the update stays `ready` to try again, no helper is
    // spawned, and the hand-off markers and the staged download are gone again:
    // a lingering apply-update-pending makes the launcher's next exit skip the
    // tray reap (see removeApplyHandoffMarkers).
    it.each([
        ['declined', new PkexecDeclinedError('machine-wide-update')],
        ['failed', new Error('pkexec machine-wide-update failed: mv: cannot move')],
    ])('applyUpdate (linux machine-wide-no-service): a %s pkexec changes nothing', async (_label, thrown) => {
        // Nor does it stop adb or close a stream: the pre-apply cleanup waits for
        // the point of no return, which a cancelled prompt never reaches.
        using probe = hygieneProbe();
        const { createHash } = await import('crypto');
        Config.getInstance().updateAppConfig({
            autoUpdate: false,
            installMode: 'user',
            channel: 'beta',
            githubOwner: 'bilbospocketses',
        });
        const appImageBytes = Buffer.from('NEW-APPIMAGE-CONTENT');
        const goodHash = createHash('sha256').update(appImageBytes).digest('hex');
        const sums = `${goodHash}  ./linux-final/WsScrcpyWeb-linux-beta.AppImage\n`;
        const fetchFn = vi.fn(async (url: string) =>
            url.endsWith('.AppImage') ? new Response(appImageBytes) : new Response(sums),
        ) as unknown as typeof fetch;
        const mgr = fakeMgr({ checkForUpdatesAsync: async () => fakeUpdateInfo('0.1.31-beta.2') });
        const pkexecMock = vi.fn<(shellCmd: string, label: string) => Promise<string>>(async () => {
            throw thrown;
        });
        const spawnMock = vi.mocked(child_process.spawn);
        spawnMock.mockClear();
        const svc = new UpdateService({
            platform: 'linux',
            installRoot: path.join('/fake', 'mount', 'usr'),
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
            fetchFn,
            runPkexecFn: pkexecMock,
            reapOwnAdbFn: probe.reapOwnAdbFn,
        });
        process.env['APPIMAGE'] = '/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage';
        svc.init();
        await svc.checkForUpdates();
        expect(svc.getStatus().status).toBe('ready');

        await expect(svc.applyUpdate()).rejects.toBe(thrown);

        expect(pkexecMock).toHaveBeenCalledTimes(1);
        expect(spawnMock).not.toHaveBeenCalled();
        expect(svc.getStatus().status).toBe('ready');
        const cfg = Config.getInstance();
        expect(fs.existsSync(cfg.applyUpdatePendingMarkerPath)).toBe(false);
        expect(fs.existsSync(cfg.suppressBrowserOpenMarkerPath)).toBe(false);
        const staged = pkexecMock.mock.calls[0]![0].match(/install -o root -g root -m 0755 '([^']+)'/)?.[1];
        expect(staged).toMatch(/update-staging/);
        expect(fs.existsSync(staged!)).toBe(false);
        expect(probe.untouched()).toEqual({ streamsClosed: 0, killServer: 0, reaped: 0 });
    });

    // M3 + defect (b): a Linux apply whose download fails, or whose download does
    // not match SHA256SUMS, updates nothing. Before the fix it had already closed
    // every stream, stopped adb and written the launcher hand-off markers, and the
    // server then kept running without them -- with markers telling the next
    // launch an update was under way.
    it.each([
        ['the download fails', () => new Response('not found', { status: 404 }), /download failed: 404/],
        ['the download does not match SHA256SUMS', () => new Response(Buffer.from('CORRUPT')), /mismatch/i],
    ])(
        'applyUpdate (linux): when %s, adb, the streams and the hand-off markers are untouched',
        async (_label, appImageResponse, error) => {
            using probe = hygieneProbe();
            Config.getInstance().updateAppConfig({
                autoUpdate: false,
                installMode: 'user',
                channel: 'beta',
                githubOwner: 'bilbospocketses',
            });
            const sums = `${'0'.repeat(64)}  ./linux-final/WsScrcpyWeb-linux-beta.AppImage\n`;
            const fetchFn = vi.fn(async (url: string) =>
                url.endsWith('.AppImage') ? appImageResponse() : new Response(sums),
            ) as unknown as typeof fetch;
            const spawnMock = vi.mocked(child_process.spawn);
            spawnMock.mockClear();
            const svc = new UpdateService({
                platform: 'linux',
                installRoot: path.join('/fake', 'mount', 'usr'),
                existsSync: () => true,
                updateManagerFactory: () =>
                    fakeMgr({ checkForUpdatesAsync: async () => fakeUpdateInfo('0.1.30-beta.26') }),
                setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
                clearIntervalFn: () => undefined,
                fetchFn,
                reapOwnAdbFn: probe.reapOwnAdbFn,
            });
            process.env['APPIMAGE'] = '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage';
            svc.init();
            await svc.checkForUpdates();

            await expect(svc.applyUpdate()).rejects.toThrow(error);

            expect(spawnMock).not.toHaveBeenCalled();
            expect(svc.getStatus().status).toBe('ready');
            const cfg = Config.getInstance();
            // Read from this test's own data root, never the machine's.
            expect(path.relative(tmpDirs.at(-1)!, cfg.applyUpdatePendingMarkerPath).startsWith('..')).toBe(false);
            expect(fs.existsSync(cfg.applyUpdatePendingMarkerPath)).toBe(false);
            expect(fs.existsSync(cfg.suppressBrowserOpenMarkerPath)).toBe(false);
            expect(probe.untouched()).toEqual({ streamsClosed: 0, killServer: 0, reaped: 0 });
        },
    );

    // The point of no return, in order: download + SHA-256 check, then (machine-
    // wide only) the elevated swap, then the stream close + adb stop and the
    // hand-off markers, then the helper that takes over.
    it.each([
        ['local', '/home/u/Downloads/WsScrcpyWeb-linux-beta.AppImage'],
        ['machine-wide-no-service', '/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage'],
    ])(
        'applyUpdate (linux %s): cleans up only after the download, the check and any elevation',
        async (_label, appImage) => {
            const order: string[] = [];
            using probe = hygieneProbe(order);
            const { createHash } = await import('crypto');
            Config.getInstance().updateAppConfig({
                autoUpdate: false,
                installMode: 'user',
                channel: 'beta',
                githubOwner: 'bilbospocketses',
            });
            const cfg = Config.getInstance();
            const markers = (): string =>
                fs.existsSync(cfg.applyUpdatePendingMarkerPath) || fs.existsSync(cfg.suppressBrowserOpenMarkerPath)
                    ? 'markers'
                    : 'no markers';
            const appImageBytes = Buffer.from('NEW-APPIMAGE-CONTENT');
            const goodHash = createHash('sha256').update(appImageBytes).digest('hex');
            const sums = `${goodHash}  ./linux-final/WsScrcpyWeb-linux-beta.AppImage\n`;
            const fetchFn = vi.fn(async (url: string) => {
                order.push(url.endsWith('.AppImage') ? 'download' : 'SHA256SUMS');
                return url.endsWith('.AppImage') ? new Response(appImageBytes) : new Response(sums);
            }) as unknown as typeof fetch;
            const pkexecMock = vi.fn(async () => {
                order.push(`pkexec (${markers()})`);
                return '';
            });
            const spawnMock = vi.mocked(child_process.spawn);
            spawnMock.mockClear();
            spawnMock.mockImplementationOnce(((...args: Parameters<typeof child_process.spawn>) => {
                order.push(`spawn helper (${markers()})`);
                return (spawnMock.getMockImplementation() as (...a: unknown[]) => child_process.ChildProcess)(...args);
            }) as typeof child_process.spawn);
            const svc = new UpdateService({
                platform: 'linux',
                installRoot: path.join('/fake', 'mount', 'usr'),
                existsSync: () => true,
                updateManagerFactory: () =>
                    fakeMgr({ checkForUpdatesAsync: async () => fakeUpdateInfo('0.1.31-beta.2') }),
                setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
                clearIntervalFn: () => undefined,
                fetchFn,
                runPkexecFn: pkexecMock,
                reapOwnAdbFn: probe.reapOwnAdbFn,
            });
            process.env['APPIMAGE'] = appImage;
            svc.init();
            await svc.checkForUpdates();

            await svc.applyUpdate();

            const elevated = appImage.startsWith('/opt/') ? ['pkexec (no markers)'] : [];
            expect(order).toEqual([
                'download',
                'SHA256SUMS',
                ...elevated,
                'close stream',
                'kill-server',
                'reap',
                'spawn helper (markers)',
            ]);
        },
    );

    // ── Windows: the apply downloads the package first ──────────────────
    //
    // With auto-download off the check only reports the update; neither Windows
    // hand-off downloads it (see velopackPackages). Until 2026-10-08 the install
    // failed every time: in service mode after closing every stream, in local
    // mode with the app shut down for good.

    const WINDOWS_MODES: ['user' | 'user-service'][] = [['user'], ['user-service']];

    /** A Windows install offering v0.2.0; `mgr` overrides the fake manager. */
    function windowsApplyService(
        installMode: 'user' | 'user-service',
        autoUpdate: boolean,
        mgr: Partial<UpdateManagerLike>,
        extra: UpdateServiceOptions = {},
    ): UpdateService {
        Config.getInstance().updateAppConfig({
            autoUpdate,
            installMode,
            channel: 'stable',
            githubOwner: 'bilbospocketses',
        });
        return new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => fakeMgr({ checkForUpdatesAsync: async () => fakeUpdateInfo('0.2.0'), ...mgr }),
            ...quietTimers,
            ...extra,
        });
    }

    /**
     * Push 'spawn operation-server' to `order` at every spawn until disposed
     * (`using`). Not mockImplementationOnce: an apply that never spawns would
     * leave it queued for the next test's spawn.
     */
    function recordHandoff(order: string[]) {
        const spawnMock = vi.mocked(child_process.spawn);
        const base = spawnMock.getMockImplementation()!;
        spawnMock.mockClear();
        spawnMock.mockImplementation(((...args: Parameters<typeof child_process.spawn>) => {
            order.push('spawn operation-server');
            return base(...args);
        }) as typeof child_process.spawn);
        return {
            spawnMock,
            [Symbol.dispose](): void {
                spawnMock.mockImplementation(base);
            },
        };
    }

    it.each(WINDOWS_MODES)(
        'applyUpdate (win32 %s, auto-download off): downloads the update before the hand-off, showing progress',
        async (installMode) => {
            const order: string[] = [];
            using probe = hygieneProbe(order);
            using handoff = recordHandoff(order);
            const { spawnMock } = handoff;
            const download = deferred<void>();
            const downloaded: UpdateInfo[] = [];
            const handedOff: UpdateInfo[] = [];
            const svc = windowsApplyService(
                installMode,
                false,
                {
                    downloadUpdateAsync: async (u, cb) => {
                        order.push(`download v${u.TargetFullRelease.Version}`);
                        downloaded.push(u);
                        cb?.(40);
                        await download.promise;
                    },
                    waitExitThenApplyUpdate: (u) => {
                        order.push('waitExitThenApplyUpdate');
                        handedOff.push(u);
                    },
                },
                { reapOwnAdbFn: probe.reapOwnAdbFn },
            );
            svc.init();
            await settled(svc);
            expect(svc.getStatus().status).toBe('ready');
            // The check reported the update and downloaded nothing.
            expect(order).toEqual([]);

            const applying = svc.applyUpdate();
            await vi.waitFor(() => expect(order).toEqual(['download v0.2.0']));
            // Held mid-download: progress shows, and nothing has been stopped yet.
            expect(svc.getStatus()).toMatchObject({ status: 'downloading', progress: 40 });
            expect(probe.untouched()).toEqual({ streamsClosed: 0, killServer: 0, reaped: 0 });
            expect(spawnMock).not.toHaveBeenCalled();

            download.resolve();
            await applying;

            const handoffStep = installMode === 'user' ? 'spawn operation-server' : 'waitExitThenApplyUpdate';
            expect(order).toEqual(['download v0.2.0', 'close stream', 'kill-server', 'reap', handoffStep]);
            // The update the check offered is the one downloaded and the one installed.
            const offered = svc.getStatus().pendingUpdate;
            expect(downloaded).toHaveLength(1);
            expect(downloaded[0]!.TargetFullRelease).toEqual(offered!.TargetFullRelease);
            if (installMode === 'user-service') expect(handedOff).toEqual([downloaded[0]]);
            expect(svc.getStatus()).toMatchObject({ status: 'ready', progress: 100 });
        },
    );

    it.each(WINDOWS_MODES)(
        'applyUpdate (win32 %s): a failed download stops the apply before anything is touched, and a retry goes ahead',
        async (installMode) => {
            using probe = hygieneProbe();
            const order: string[] = [];
            using handoff = recordHandoff(order);
            const { spawnMock } = handoff;
            let fail = true;
            const applyFn = vi.fn();
            const downloaded: UpdateInfo[] = [];
            // A new UpdateInfo per check, so which check's answer a download uses is visible.
            const checkFn = vi.fn(async () => fakeUpdateInfo('0.2.0'));
            const forget = vi.spyOn(GithubReleaseFeedResolver.prototype, 'forget');
            try {
                const svc = windowsApplyService(
                    installMode,
                    false,
                    {
                        checkForUpdatesAsync: checkFn,
                        downloadUpdateAsync: async (u) => {
                            downloaded.push(u);
                            if (fail) throw new Error('Network error: Http error: http status: 503');
                        },
                        waitExitThenApplyUpdate: applyFn,
                    },
                    { reapOwnAdbFn: probe.reapOwnAdbFn },
                );
                svc.init();
                await settled(svc);
                expect(svc.getStatus().status).toBe('ready');
                const firstOffer = svc.getStatus().pendingUpdate;
                checkFn.mockClear();
                forget.mockClear();

                await expect(svc.applyUpdate()).rejects.toThrow(
                    'update download failed: Network error: Http error: http status: 503',
                );

                expect(spawnMock).not.toHaveBeenCalled();
                expect(applyFn).not.toHaveBeenCalled();
                expect(probe.untouched()).toEqual({ streamsClosed: 0, killServer: 0, reaped: 0 });
                expect(liveStreams.isStopping()).toBe(false);
                const cfg = Config.getInstance();
                expect(fs.existsSync(cfg.applyUpdatePendingMarkerPath)).toBe(false);
                expect(fs.existsSync(cfg.suppressBrowserOpenMarkerPath)).toBe(false);
                expect(fs.existsSync(cfg.applyUpdateVerifyManifestPath)).toBe(false);
                // The release is looked up afresh and checked again at once, so the
                // retry does not reuse the pairing whose download just failed.
                expect(forget).toHaveBeenCalledTimes(1);
                await vi.waitFor(() => expect(checkFn).toHaveBeenCalledTimes(1));
                await settled(svc);
                // Still on offer, as after a failed Linux download, with the reason
                // beside it for any page that asks; the check did not wipe it.
                expect(svc.getStatus()).toMatchObject({
                    status: 'ready',
                    availableVersion: '0.2.0',
                    errorMessage: undefined,
                    lastApplyError: 'update download failed: Network error: Http error: http status: 503',
                });
                const freshOffer = svc.getStatus().pendingUpdate;
                expect(freshOffer).not.toBe(firstOffer);

                // Not stuck as "in progress": the retry downloads the fresh offer and installs.
                fail = false;
                await svc.applyUpdate();
                expect(downloaded.at(-1)).toBe(freshOffer);
                if (installMode === 'user') expect(spawnMock).toHaveBeenCalledTimes(1);
                else expect(applyFn).toHaveBeenCalledTimes(1);
                // An install that starts clears the last one's failure.
                expect(svc.getStatus().lastApplyError).toBeUndefined();
            } finally {
                forget.mockRestore();
            }
        },
    );

    it('applyUpdate (win32): a failed install is forgotten once a check offers another version', async () => {
        let offered = '0.2.0';
        const svc = windowsApplyService('user-service', false, {
            checkForUpdatesAsync: async () => fakeUpdateInfo(offered),
            downloadUpdateAsync: async () => {
                throw new Error('Network error');
            },
        });
        svc.init();
        await settled(svc);
        await expect(svc.applyUpdate()).rejects.toThrow('update download failed');
        await settled(svc);
        expect(svc.getStatus().lastApplyError).toBe('update download failed: Network error');

        // The same version again keeps it; another one is a different install.
        await svc.checkForUpdates();
        expect(svc.getStatus().lastApplyError).toBe('update download failed: Network error');
        offered = '0.3.0';
        await svc.checkForUpdates();
        expect(svc.getStatus()).toMatchObject({
            status: 'ready',
            availableVersion: '0.3.0',
            lastApplyError: undefined,
        });
    });

    // A Velopack download that stops reporting progress (a half-open connection,
    // a laptop that slept) used to hold the updater until a restart.
    it.each(WINDOWS_MODES)(
        'applyUpdate (win32 %s): a download that stalls is given up on, and the updater is not wedged',
        async (installMode) => {
            using probe = hygieneProbe();
            const order: string[] = [];
            using handoff = recordHandoff(order);
            const { spawnMock } = handoff;
            const applyFn = vi.fn();
            let hang = true;
            // The abandoned call: it reports progress after it was given up on,
            // then finishes long after.
            const abandoned = deferred<void>();
            let lateProgress: ((perc: number) => void) | undefined;
            const checkFn = vi.fn(async () => fakeUpdateInfo('0.2.0'));
            const svc = windowsApplyService(
                installMode,
                false,
                {
                    checkForUpdatesAsync: checkFn,
                    downloadUpdateAsync: async (_u, cb) => {
                        if (!hang) {
                            cb?.(100);
                            return;
                        }
                        cb?.(10);
                        lateProgress = cb;
                        await abandoned.promise;
                    },
                    waitExitThenApplyUpdate: applyFn,
                },
                { reapOwnAdbFn: probe.reapOwnAdbFn, downloadStallTimeoutMs: 50 },
            );
            svc.init();
            await settled(svc);
            expect(svc.getStatus().status).toBe('ready');
            checkFn.mockClear();

            await expect(svc.applyUpdate()).rejects.toThrow(
                'update download failed: update download stalled (no progress for 0.05 s)',
            );
            expect(spawnMock).not.toHaveBeenCalled();
            expect(applyFn).not.toHaveBeenCalled();
            expect(probe.untouched()).toEqual({ streamsClosed: 0, killServer: 0, reaped: 0 });
            // Not wedged: the check after the failure runs instead of being skipped.
            await vi.waitFor(() => expect(checkFn).toHaveBeenCalledTimes(1));
            await settled(svc);
            expect(svc.getStatus()).toMatchObject({
                status: 'ready',
                lastApplyError: 'update download failed: update download stalled (no progress for 0.05 s)',
            });
            // The abandoned call's progress no longer lands.
            const before = svc.getStatus().progress;
            lateProgress!(70);
            expect(svc.getStatus().progress).toBe(before);

            // A retry starts its own download rather than joining the abandoned one.
            hang = false;
            await svc.applyUpdate();
            if (installMode === 'user') expect(spawnMock).toHaveBeenCalledTimes(1);
            else expect(applyFn).toHaveBeenCalledTimes(1);
            abandoned.resolve();
        },
    );

    it('a download that keeps reporting progress is not given up on, however long it takes', async () => {
        const svc = windowsApplyService(
            'user-service',
            false,
            {
                downloadUpdateAsync: async (_u, cb) => {
                    // 8 x 30 ms = 240 ms in all, never 50 ms without progress.
                    for (let p = 5; p <= 40; p += 5) {
                        await new Promise((r) => setTimeout(r, 30));
                        cb?.(p);
                    }
                },
            },
            { reapOwnAdbFn: async () => 0, downloadStallTimeoutMs: 50 },
        );
        svc.init();
        await settled(svc);

        await svc.applyUpdate();
        expect(svc.getStatus().lastApplyError).toBeUndefined();
    });

    it('a check whose auto-download stalls ends in error, and the next check runs', async () => {
        Config.getInstance().updateAppConfig({ autoUpdate: true, channel: 'stable', githubOwner: 'bilbospocketses' });
        let hang = true;
        const abandoned = deferred<void>();
        const checkFn = vi.fn(async () => fakeUpdateInfo('0.2.0'));
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () =>
                fakeMgr({
                    checkForUpdatesAsync: checkFn,
                    downloadUpdateAsync: async () => {
                        if (hang) await abandoned.promise;
                    },
                }),
            downloadStallTimeoutMs: 50,
            ...quietTimers,
        });
        svc.init();
        await settled(svc);
        expect(svc.getStatus()).toMatchObject({
            status: 'error',
            errorMessage: 'update download stalled (no progress for 0.05 s)',
        });

        // Before the watchdog this check joined the hung one forever.
        hang = false;
        await svc.checkForUpdates();
        expect(checkFn).toHaveBeenCalledTimes(2);
        expect(svc.getStatus()).toMatchObject({ status: 'ready', progress: 100 });
        abandoned.resolve();
    });

    it.each(WINDOWS_MODES)(
        'applyUpdate (win32 %s): a channel change during the download stops the apply before anything is touched',
        async (installMode) => {
            using probe = hygieneProbe();
            const order: string[] = [];
            using handoff = recordHandoff(order);
            const { spawnMock } = handoff;
            const download = deferred<void>();
            let downloading = false;
            const applyFn = vi.fn();
            const checkFn = vi.fn(async () => fakeUpdateInfo('0.2.0'));
            const svc = windowsApplyService(
                installMode,
                false,
                {
                    checkForUpdatesAsync: checkFn,
                    downloadUpdateAsync: async () => {
                        downloading = true;
                        await download.promise;
                    },
                    waitExitThenApplyUpdate: applyFn,
                },
                { reapOwnAdbFn: probe.reapOwnAdbFn },
            );
            svc.init();
            await settled(svc);
            expect(svc.getStatus().status).toBe('ready');
            checkFn.mockClear();

            const applying = svc.applyUpdate();
            await vi.waitFor(() => expect(downloading).toBe(true));
            await svc.reconfigure('beta', 'bilbospocketses');
            expect(svc.getStatus()).toMatchObject({ status: 'idle', pendingUpdate: undefined });

            // The download finishes, but for a release the user switched away from.
            download.resolve();
            await expect(applying).rejects.toThrow('update changed during download');

            expect(spawnMock).not.toHaveBeenCalled();
            expect(applyFn).not.toHaveBeenCalled();
            expect(probe.untouched()).toEqual({ streamsClosed: 0, killServer: 0, reaped: 0 });
            expect(liveStreams.isStopping()).toBe(false);
            expect(fs.existsSync(Config.getInstance().applyUpdatePendingMarkerPath)).toBe(false);
            // The new channel is checked as soon as the apply has failed.
            await vi.waitFor(() => expect(checkFn).toHaveBeenCalledTimes(1));
            await settled(svc);
            expect(svc.getStatus().status).toBe('ready');
        },
    );

    // With auto-download on the check has already downloaded the package. The
    // apply still asks Velopack, which owns the packages folder and skips a
    // package already there (manager.rs:414-415) -- a stat, not a re-download
    // or a re-hash -- rather than trusting a flag kept in memory that a deleted
    // or cleaned-up package would make wrong. This fake skips the same way and
    // counts what it actually fetches.
    it.each(WINDOWS_MODES)(
        'applyUpdate (win32 %s, auto-download on): the package the check downloaded is not fetched again',
        async (installMode) => {
            const order: string[] = [];
            using handoff = recordHandoff(order);
            const { spawnMock } = handoff;
            const asked: UpdateInfo[] = [];
            const fetched: string[] = [];
            const applyFn = vi.fn();
            const svc = windowsApplyService(
                installMode,
                true,
                {
                    downloadUpdateAsync: async (u, cb) => {
                        asked.push(u);
                        if (velopackPackages.onDisk.has(u.TargetFullRelease.FileName)) return;
                        fetched.push(u.TargetFullRelease.Version);
                        cb?.(100);
                    },
                    waitExitThenApplyUpdate: applyFn,
                },
                { reapOwnAdbFn: async () => 0 },
            );
            svc.init();
            await settled(svc);
            expect(svc.getStatus()).toMatchObject({ status: 'ready', progress: 100 });
            expect(fetched).toEqual(['0.2.0']);

            await svc.applyUpdate();

            expect(fetched).toEqual(['0.2.0']);
            // Asked twice for the one update the check offered: by the check, then by the apply.
            expect(asked).toHaveLength(2);
            expect(asked[1]).toBe(asked[0]);
            if (installMode === 'user') expect(spawnMock).toHaveBeenCalledTimes(1);
            else expect(applyFn).toHaveBeenCalledTimes(1);
            expect(svc.getStatus()).toMatchObject({ status: 'ready', progress: 100 });
        },
    );

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
            .fn<(feed: unknown, opts: UpdateOptions) => UpdateManagerLike>()
            .mockImplementation((feed) => ((feed as { url: string }).url.includes('/forky/') ? newMgr : oldMgr));

        const svc = new UpdateService({
            // Pin platform so ExplicitChannel stays 'beta' (Linux would prefix
            // it to 'linux-beta' — covered by the platform-aware tests above).
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: factory,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await settled(svc);
        await svc.reconfigure('beta', 'forky');
        const lastCall = factory.mock.calls.at(-1)!;
        expect(lastCall[0]).toEqual({
            kind: 'release',
            tag: 'v9.9.9',
            url: 'https://github.com/forky/ws-scrcpy-web/releases/download/v9.9.9/',
        });
        expect(lastCall[1].ExplicitChannel).toBe('beta');
        expect(newCheckFn).toHaveBeenCalled();
    });

    it('reconfigure: factory throws → state=error, old mgr kept, the next check tries again', async () => {
        const oldCheckFn = vi.fn(async () => null as UpdateInfo | null);
        const oldMgr = fakeMgr({
            checkForUpdatesAsync: oldCheckFn,
            getCurrentVersion: () => '0.1.0',
        });
        const factory = vi
            .fn<(feed: unknown, opts: UpdateOptions) => UpdateManagerLike>()
            .mockImplementation((feed) => {
                if ((feed as { url: string }).url.includes('/forky/')) throw new Error('bad channel name');
                return oldMgr;
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
        await settled(svc);
        oldCheckFn.mockClear();
        const callsBefore = factory.mock.calls.length;
        await svc.reconfigure('beta', 'forky');
        const sAfterReconfigure = svc.getStatus();
        expect(sAfterReconfigure.status).toBe('error');
        expect(sAfterReconfigure.errorMessage).toMatch(/reconfigure failed/);
        expect(sAfterReconfigure.errorMessage).toMatch(/bad channel name/);
        // The failed build did not replace the manager, and the old one was not
        // used to check the new owner's feed.
        expect((svc as any).mgr).toBe(oldMgr);
        expect(oldCheckFn).not.toHaveBeenCalled();
        // A later check builds for the configured owner again rather than
        // silently checking the old feed.
        await svc.checkForUpdates();
        expect(factory.mock.calls.length).toBeGreaterThan(callsBefore + 1);
        expect(svc.getStatus().status).toBe('error');
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

    it('restartTimer: fires checkForUpdates after intervalMinutes', async () => {
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
        // Drain init()'s immediate void check, then clear so we observe only
        // the timer callback.
        await settled(svc);
        checkFn.mockClear();
        scheduled?.();
        await settled(svc);
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
