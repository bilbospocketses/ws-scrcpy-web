import * as child_process from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { UpdateInfo, UpdateOptions, VelopackAsset } from 'velopack';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../Config';
import { EnvName } from '../EnvName';
import { stageSystemHelper } from '../service/systemHelper';
import { type UpdateManagerLike, UpdateService } from '../UpdateService';
import { betas, type FakeGithubApi, fakeGithubApi, release } from './helpers/fakeGithubReleases';

// FD2: the system-service apply must spawn a bin_t copy under /opt, not the
// var_lib_t data-root helper. The stager itself is unit-tested beside it; here
// it returns its real destination so the spawn's argv shows which was used.
const STAGED = '/opt/ws-scrcpy-web/control/ws-scrcpy-web-launcher';
vi.mock('../service/systemHelper', () => ({ stageSystemHelper: vi.fn(() => STAGED) }));

// Mock child_process.spawn so local-mode applyUpdate doesn't try to exec
// the real operation-server helper binary (which doesn't exist in test), and
// execFile so the win32 pre-apply hygiene (`adb kill-server`, then
// `taskkill /F /IM adb.exe /T`) never runs for real: unmocked, `npm test` on a
// Windows box killed every adb.exe on the machine. Each call answers success.
vi.mock('child_process', async (importOriginal) => {
    const real = await importOriginal<typeof child_process>();
    return {
        ...real,
        execFile: vi.fn((...args: unknown[]) => {
            const callback = args.find((a) => typeof a === 'function') as
                | ((err: Error | null, stdout: string, stderr: string) => void)
                | undefined;
            queueMicrotask(() => callback?.(null, '', ''));
            return { pid: 0 };
        }),
        spawn: vi.fn(() => {
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

    // Every update check resolves the selected channel's newest release through
    // api.github.com first. Global fetch is the fake for EVERY test, so nothing
    // here reaches the network; by default one release carries every feed.
    let api: FakeGithubApi;

    beforeEach(() => {
        api = fakeGithubApi([release('v9.9.9', ['beta', 'stable', 'linux-beta', 'linux-stable'])]);
        vi.stubGlobal('fetch', api.fetchFn);
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
        vi.unstubAllGlobals();
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
        api.set([...betas(15, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
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
        api.set([...betas(15, 30), release('v0.1.30', ['stable', 'linux-stable'])]);
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
        expect(feed).toMatchObject({ kind: 'release', tag: 'v0.1.30' });
        expect(opts.ExplicitChannel).toBe('stable');
    });

    it('the resolved release is cached across checks and refreshed when a newer one appears', async () => {
        api.set([...betas(3, 30), release('v0.1.30', ['stable'])]);
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

        api.set([...betas(1, 31), ...betas(3, 30), release('v0.1.30', ['stable'])]);
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
        let answerBeta: ((r: { tag: string; url: string }) => void) | undefined;
        const resolver = {
            resolve: vi.fn((_owner: string, channel: string) =>
                hold && channel === 'beta'
                    ? new Promise<{ tag: string; url: string }>((resolve) => {
                          answerBeta = resolve;
                      })
                    : Promise.resolve({ tag: `v-${channel}`, url: `https://feeds.example/${channel}/` }),
            ),
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

        answerBeta!({ tag: 'v-beta-late', url: 'https://feeds.example/beta-late/' });
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

    // The win32 pre-apply hygiene runs `taskkill /F /IM adb.exe /T` through
    // child_process.execFile. Unmocked, `npm test` on a Windows box killed EVERY
    // adb.exe on the machine, a developer's and other tools' included (found
    // 2026-10-06 while fixing item 170). execFile is module-mocked above; this
    // proves the hygiene goes through the mock, so no real process is touched.
    it('applyUpdate (win32): pre-apply hygiene goes through the mocked execFile, never a real taskkill', async () => {
        Config.getInstance().updateAppConfig({ autoUpdate: false });
        const execFileMock = vi.mocked(child_process.execFile);
        execFileMock.mockClear();
        const mgr = fakeMgr({
            checkForUpdatesAsync: async () => fakeUpdateInfo('0.2.0'),
            waitExitThenApplyUpdate: vi.fn(),
        });
        const svc = new UpdateService({
            platform: 'win32',
            installRoot: '/fake',
            existsSync: () => true,
            updateManagerFactory: () => mgr,
            setIntervalFn: () => 0 as unknown as NodeJS.Timeout,
            clearIntervalFn: () => undefined,
        });
        svc.init();
        await svc.checkForUpdates();
        await svc.applyUpdate();
        const taskkill = execFileMock.mock.calls.find(([file]) => /taskkill\.exe$/i.test(String(file)));
        expect(taskkill?.[1]).toEqual(['/F', '/IM', 'adb.exe', '/T']);
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
