import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { HttpSource, type UpdateInfo, UpdateManager, type UpdateOptions, type VelopackLocatorConfig } from 'velopack';
import { defaultChannelForVersion, type UpdateChannel } from '../common/ConfigEvents';
import { WS_SCRCPY_SERVICE_NAME } from '../common/ServiceEvents';
import type { UpdateState } from '../common/UpdateEvents';
import { AdbClient } from './AdbClient';
import { getAppVersion } from './appVersion';
import { Config } from './Config';
import { CHANNEL_PINNED_KEY } from './db/constants';
import { Logger } from './Logger';
import {
    downloadVerifiedAsset,
    linuxAppImageAssetName,
    RELEASE_URL_BASE_ENV,
    releaseAssetUrl,
} from './linuxUpdateAssets';
import { liveStreams } from './liveStreams';
import {
    buildMachineWideUpdateScript,
    PkexecDeclinedError,
    runPkexec,
    STAGED_SYSTEM_DIR,
} from './service/SystemdClient';
import { stageSystemHelper } from './service/systemHelper';
import { buildDetachedSpawn } from './service/systemTools';
import { GithubReleaseFeedResolver, type ReleaseFeedResolver, releaseFeedUrl } from './updateFeedResolver';
import { reapOwnAdbOnWindows } from './util/reapOwnAdb';

const log = Logger.for('UpdateService');

/**
 * How long one Velopack check (`checkForUpdatesAsync`) may run before the update
 * check gives up on it. Velopack's HttpSource is built with no HttpOptions, and
 * velopack 1.2.161's `TimeoutMilliseconds` defaults to 0, "never times out"
 * (`lib/types.d.ts`): after a laptop sleep or on a half-open connection the
 * call can wait forever, and since checks are serialised (runCheck) every
 * later check would join it. The release lookup before it is already bounded
 * (fetchWithRetry). The download is not given a deadline (it is ~60 MB), but
 * one that stops making progress is given up on ({@link DOWNLOAD_STALL_TIMEOUT_MS}).
 */
export const VELOPACK_CHECK_TIMEOUT_MS = 60_000;

/**
 * How long a Velopack download (`downloadUpdateAsync`) may go without reporting
 * progress before it is given up on as stalled. It has no deadline of its own
 * (see {@link VELOPACK_CHECK_TIMEOUT_MS}), and a hung one wedged the updater
 * until a restart: the apply never answered and stayed in progress, so every
 * check was skipped and every apply refused; and a check's own download, being
 * joined by every later check, blocked them all the same way.
 *
 * Velopack reports progress in 5 % steps (velopack 1.2.161 `download.rs:71-74`),
 * about 3 MB of the ~60 MB package, so 120 s without one is under 25 KB/s; the
 * window also covers connecting, which reports nothing. A package already on
 * disk returns at once. If deltas are ever published this must be revisited:
 * a delta downloads without progress, and applying the deltas reports none
 * (`manager.rs:498-532`); today's releases are full packages only.
 */
export const DOWNLOAD_STALL_TIMEOUT_MS = 120_000;

/** An apply stopped because the download it starts with failed; the update stays on offer. */
class ApplyDownloadError extends Error {}

/**
 * Minimal subset of {@link UpdateManager} that UpdateService actually uses.
 * Lets unit tests inject a fake without dragging in the velopack native addon.
 */
export interface UpdateManagerLike {
    getCurrentVersion(): string;
    checkForUpdatesAsync(): Promise<UpdateInfo | null>;
    downloadUpdateAsync(update: UpdateInfo, progress?: (perc: number) => void): Promise<void>;
    waitExitThenApplyUpdate(update: UpdateInfo, silent?: boolean, restart?: boolean, restartArgs?: string[]): void;
}

/**
 * Where Velopack reads the feed from.
 *
 *  - `release`: ONE GitHub release's download folder, the newest release that
 *    carries the selected channel's feed -- on the beta channel, the beta OR
 *    the stable feed (see feedChannels and updateFeedResolver.ts). Handed to
 *    Velopack as an explicit HttpSource -- a github.com URL given as a plain
 *    string would be turned into a GithubSource (velopack 1.2.161
 *    `sources/mod.rs:64-69`), which reads only the 10 newest releases.
 *    Velopack's HTTP client follows GitHub's redirect from the release
 *    download URL to release-assets.githubusercontent.com (measured
 *    2026-10-04: an HttpSource on the v0.1.30-beta.166 folder offered
 *    0.1.30-beta.166 to a beta.160 manifest).
 *  - `override`: `VELOPACK_FEED_URL` (or the test override), handed over as-is
 *    so Velopack picks the source from it: a `file:///` sandbox feed, a local
 *    mirror, the qa-harness feed.
 */
export type UpdateFeed = { kind: 'release'; tag: string; url: string } | { kind: 'override'; url: string };

export type UpdateManagerFactory = (
    feed: UpdateFeed,
    opts: UpdateOptions,
    locator?: VelopackLocatorConfig,
) => UpdateManagerLike;

export interface UpdateServiceOptions {
    /** Override the install-root path used for sq.version detection. Default: dirname(process.execPath). */
    installRoot?: string;
    /** Override the UpdateManager constructor for tests. Default: real velopack import. */
    updateManagerFactory?: UpdateManagerFactory;
    /** Override the feed URL for tests; VELOPACK_FEED_URL wins over it. Either one skips release resolution. */
    feedUrlOverride?: string;
    /** Override how the selected channel's newest release is found. Default: GitHub's releases API. */
    releaseFeedResolver?: ReleaseFeedResolver;
    /** Override fs.existsSync for tests. */
    existsSync?: (p: string) => boolean;
    /** Override timer scheduling for tests. */
    setIntervalFn?: (cb: () => void, ms: number) => NodeJS.Timeout;
    /** Override timer cancellation for tests. */
    clearIntervalFn?: (handle: NodeJS.Timeout) => void;
    /**
     * Override the host platform for tests. Default: `process.platform`.
     * Lets the Windows/Linux locator branches be exercised on any host — the
     * original Linux locator bug (doubled `usr/usr/bin`) slipped through
     * because tests only ever ran the host-platform branch.
     */
    platform?: NodeJS.Platform;
    /** Override global fetch for tests (AppImage download + SHA256SUMS). Default: global fetch. */
    fetchFn?: typeof fetch;
    /**
     * Override the pkexec runner for tests — used by the machine-wide-no-service
     * apply to elevate the rename-swap of the root-owned /opt binary under a
     * single graphical prompt. Default: the real {@link runPkexec} (SystemdClient).
     */
    runPkexecFn?: (shellCmd: string, label: string) => Promise<string>;
    /**
     * Override the pre-apply own-adb reaper for tests. Receives `Config.adbPath`,
     * returns how many processes it killed. Default: {@link reapOwnAdbOnWindows}.
     */
    reapOwnAdbFn?: (adbPath: string) => Promise<number>;
    /** Override {@link VELOPACK_CHECK_TIMEOUT_MS} for tests. */
    velopackCheckTimeoutMs?: number;
    /** Override {@link DOWNLOAD_STALL_TIMEOUT_MS} for tests. */
    downloadStallTimeoutMs?: number;
}

export interface UpdateServiceState {
    isInstalled: boolean;
    currentVersion: string;
    status: UpdateState;
    progress?: number | undefined;
    availableVersion?: string | undefined;
    errorMessage?: string | undefined;
    /**
     * Why the last install of the update on offer failed, kept beside `ready`
     * so a page loaded later, or one whose apply request got no answer (a proxy
     * timing out the long Windows download), can still say why. Cleared when an
     * install starts, when the channel changes, and when a check offers another
     * version or none; a check offering the same version keeps it, so the check
     * a failed install starts cannot wipe it before anyone has read it.
     */
    lastApplyError?: string | undefined;
    lastCheckedAt?: Date | undefined;
    /** Internal: the UpdateInfo we got from checkForUpdatesAsync, kept until apply. */
    pendingUpdate?: UpdateInfo | undefined;
    /**
     * Internal: the channel whose feed `pendingUpdate` came from. On the beta
     * channel that can be `stable` (see {@link UpdateService.feedChannels}), and
     * the Linux apply downloads that channel's AppImage.
     */
    pendingChannel?: UpdateChannel | undefined;
}

const defaultUpdateManagerFactory: UpdateManagerFactory = (feed, opts, locator) =>
    new UpdateManager(feed.kind === 'release' ? new HttpSource(feed.url) : feed.url, opts, locator);

function feedKey(feed: UpdateFeed, explicitChannel: string): string {
    return `${feed.kind}\n${feed.url}\n${explicitChannel}`;
}

/**
 * Backend-owned state machine for SP3 P5 update flow. Singleton-style — one
 * instance owned by `src/server/index.ts`. All velopack-related construction
 * is injectable via {@link UpdateServiceOptions} so tests don't touch the
 * native addon.
 *
 * Dev-mode detection (per contracts decision 1):
 *   sq.version file presence + UpdateManager construction success. If either
 *   signal is absent, we report `isInstalled=false` and refuse to do anything
 *   that would touch the real updater.
 *
 * Auto-update semantics (decision 2): `autoUpdate=true` gates auto-DOWNLOAD
 * only. Apply is always user-clicked.
 */
export class UpdateService {
    private mgr: UpdateManagerLike | null = null;
    /** The feed + channel `mgr` was built for; a check rebuilds `mgr` when they change. */
    private mgrKey: string | null = null;
    /** The channel and owner checks run against, set by init() and reconfigure(). */
    private channel: UpdateChannel = 'stable';
    private githubOwner = '';
    /** Bumped by reconfigure(), so a check or download still running for the old channel discards its answer. */
    private generation = 0;
    /** The Velopack download in flight, if any, and the generation it was started for. */
    private download: { generation: number; done: Promise<void> } | null = null;
    /**
     * The update check in flight, if any, and the generation it was started
     * for. A second check in the same generation joins it (see runCheck).
     */
    private check: { generation: number; done: Promise<UpdateServiceState> } | null = null;
    /**
     * The manager whose check produced `state.pendingUpdate`. Set and cleared
     * with it (setPending / clearPending), never apart: a download or apply
     * asks the release folder this manager reads for the package `pendingUpdate`
     * names, and `mgr` may already have been rebuilt for a newer release.
     */
    private pendingMgr: UpdateManagerLike | null = null;
    private readonly resolver: ReleaseFeedResolver;
    private state: UpdateServiceState;
    private timer: NodeJS.Timeout | null = null;
    /**
     * True once the current applyUpdate has reached its point of no return,
     * whose hygiene closes the streams as a stop. A throw after that cancels
     * the stop; a throw before it has nothing to cancel.
     */
    private streamsStoppedForApply = false;
    /**
     * True while an applyUpdate is running. A second apply is refused: two at
     * once would race the swap and reset each other's streamsStoppedForApply.
     * Update checks are skipped while it is set (runCheck). Cleared when an apply fails (it may be retried); a successful apply ends
     * in process exit, so it stays set.
     */
    private applyInFlight = false;
    /** The version `state.lastApplyError` is about; set and cleared with it. */
    private lastApplyErrorVersion: string | undefined;
    private readonly installRoot: string;
    private readonly platform: NodeJS.Platform;
    private readonly locator: VelopackLocatorConfig | undefined;
    private readonly factory: UpdateManagerFactory;
    private readonly feedUrlOverride: string | undefined;
    private readonly existsSync: (p: string) => boolean;
    private readonly setIntervalFn: (cb: () => void, ms: number) => NodeJS.Timeout;
    private readonly clearIntervalFn: (handle: NodeJS.Timeout) => void;
    private readonly fetchFn: typeof fetch;
    private readonly runPkexecFn: (shellCmd: string, label: string) => Promise<string>;
    private readonly reapOwnAdbFn: (adbPath: string) => Promise<number>;
    private readonly velopackCheckTimeoutMs: number;
    private readonly downloadStallTimeoutMs: number;

    constructor(opts: UpdateServiceOptions = {}) {
        this.platform = opts.platform ?? process.platform;
        // v0.1.15: anchor installRoot at the webpack bundle's location, not
        // at process.execPath. Our launcher resolves the Node binary to
        // <base>/current/seed/node/node.exe (first run) or
        // <base>/dependencies/node/node.exe (after dep-manager installs Node),
        // so path.dirname(process.execPath) lands inside seed/ or dependencies/
        // — never the Velopack install root where sq.version actually lives.
        // Webpack bundles this file into <base>/current/dist/index.js, so
        // __dirname resolves to <base>/current/dist/; two levels up is <base>/,
        // the install root that Velopack populates with sq.version, current/,
        // and dependencies/. Same pattern as the v0.1.10 scrcpy-server seed
        // path fix in DependencyManager.ts.
        this.installRoot = opts.installRoot ?? path.resolve(__dirname, '..', '..');
        // Velopack locator strategy is platform-split:
        //
        //   Windows — hand Velopack an explicit VelopackLocatorConfig. Phase 2
        //   of the Program Files migration: once the PerMachine MSI moved the
        //   install to C:\Program Files\WsScrcpyWeb\, Velopack's env-var-driven
        //   auto-locate stopped finding the install root reliably, so we
        //   compute the Squirrel-style `<installRoot>/current/` swap layout
        //   ourselves. Computed once — installRoot is immutable for the
        //   service's lifetime.
        //
        //   Linux (AppImage) — hand-build the locator too, anchored on
        //   installRoot. We do NOT delegate to Velopack's auto_locate_app_manifest:
        //   on Linux (lib-rust/src/locator.rs) auto_locate finds the install by
        //   searching `std::env::current_exe()` for "/usr/bin/" — but our server
        //   runs inside the app's own Node binary, which lives at
        //   <dataRoot>/dependencies/node/node, NOT under the AppImage mount's
        //   /usr/bin/. So current_exe() has no "/usr/bin/" segment, auto_locate
        //   returns "Could not locate '/usr/bin/'", UpdateManager construction
        //   throws, the init() catch nulls mgr, and every check silently no-ops.
        //   ($APPIMAGE is read by auto_locate only AFTER that search, to set
        //   RootAppDir — it is NOT used to find the install root, contrary to the
        //   beta.21 assumption.)
        //
        //   installRoot = resolve(__dirname,'..','..'). The bundle is at
        //   <mount>/usr/bin/dist, so on Linux installRoot = <mount>/usr and the
        //   Velopack contents dir is installRoot/bin = <mount>/usr/bin — the same
        //   shape the Windows branch uses (installRoot/current). __dirname is part
        //   of the read-only AppImage payload, so it is reliably under the mount
        //   (unlike current_exe()). RootAppDir is the $APPIMAGE file path, matching
        //   Velopack's own Linux locator output.
        //
        //   Lineage: beta.7 (#216) masked the throw with a `mgr===null` guard;
        //   beta.19 (#230) hand-built from resolve(__dirname,'..','..') but then
        //   re-appended usr/bin → DOUBLED <mount>/usr/usr/bin; beta.21 (#237)
        //   delegated to auto_locate (this comment's predecessor) which fails for
        //   the current_exe() reason above. The contents dir is simply
        //   installRoot/bin — no re-appended usr, no auto_locate.
        if (this.platform === 'win32') {
            this.locator = {
                RootAppDir: this.installRoot,
                UpdateExePath: path.join(this.installRoot, 'Update.exe'),
                PackagesDir: path.join(this.installRoot, 'packages'),
                // sq.version is Velopack's per-version manifest file, written
                // inside the swappable `current/` dir. v0.1.17's marker check
                // moved to `<installRoot>/Update.exe` (which Velopack actually
                // creates on Windows install); the in-current sq.version
                // continues to be the manifest file Velopack expects to find
                // for runtime version reporting.
                ManifestPath: path.join(this.installRoot, 'current', 'sq.version'),
                CurrentBinaryDir: path.join(this.installRoot, 'current'),
                IsPortable: false,
            };
        } else {
            // Linux AppImage: hand-built locator anchored on installRoot/bin
            // (= <mount>/usr/bin). See the strategy comment above for why we do
            // NOT use Velopack's auto_locate here.
            const contentsDir = path.join(this.installRoot, 'bin');
            const appImage = process.env['APPIMAGE'];
            this.locator = {
                // RootAppDir is the .AppImage FILE path, per Velopack's Linux
                // auto_locate (locator.rs). Fall back to installRoot only if
                // APPIMAGE is somehow unset (init() requires it for prod mode).
                RootAppDir: appImage && appImage.length > 0 ? appImage : this.installRoot,
                UpdateExePath: path.join(contentsDir, 'UpdateNix'),
                // Velopack's Linux packages dir: /var/tmp/velopack/<id>/packages
                // (id = WsScrcpyWeb). Used at download time, not checked at
                // construction. Hardcoded forward-slash — a Linux-only path.
                PackagesDir: '/var/tmp/velopack/WsScrcpyWeb/packages',
                ManifestPath: path.join(contentsDir, 'sq.version'),
                CurrentBinaryDir: contentsDir,
                IsPortable: true,
            };
        }
        this.factory = opts.updateManagerFactory ?? defaultUpdateManagerFactory;
        this.feedUrlOverride = opts.feedUrlOverride;
        // Not handed `opts.fetchFn`: that one is the apply path's asset
        // download; this one talks to api.github.com.
        this.resolver = opts.releaseFeedResolver ?? new GithubReleaseFeedResolver();
        this.existsSync = opts.existsSync ?? fs.existsSync;
        this.setIntervalFn = opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
        this.clearIntervalFn = opts.clearIntervalFn ?? ((handle) => clearInterval(handle));
        this.fetchFn = opts.fetchFn ?? fetch;
        this.runPkexecFn = opts.runPkexecFn ?? runPkexec;
        this.reapOwnAdbFn = opts.reapOwnAdbFn ?? ((adbPath) => reapOwnAdbOnWindows(adbPath));
        this.velopackCheckTimeoutMs = opts.velopackCheckTimeoutMs ?? VELOPACK_CHECK_TIMEOUT_MS;
        this.downloadStallTimeoutMs = opts.downloadStallTimeoutMs ?? DOWNLOAD_STALL_TIMEOUT_MS;
        this.state = { isInstalled: false, currentVersion: '', status: 'idle' };
    }

    /**
     * The feed override, if any: env `VELOPACK_FEED_URL` > opts override. With
     * one set, no release is resolved -- the update-flow sandbox
     * (scripts/test-update-flow.ps1) and the qa-harness pin their own feed this
     * way.
     */
    private overrideFeed(): UpdateFeed | null {
        const url = process.env['VELOPACK_FEED_URL'] || this.feedUrlOverride;
        return url ? { kind: 'override', url } : null;
    }

    /**
     * The feed the manager is first built with, before any check has resolved
     * the channel's newest release: the running version's own release. Velopack
     * needs a source to construct the manager that reports the current version,
     * but no check ever reads this one -- every check resolves first and
     * rebuilds the manager when the answer differs. A running build that IS
     * its channel's newest keeps this manager, since the resolution lands on
     * the same release.
     *
     * History: v0.1.18 to v0.1.30-beta.166 handed Velopack the bare repo URL,
     * which it reads as a GithubSource limited to the 10 newest releases (see
     * updateFeedResolver.ts); before v0.1.18 it was
     * `https://github.com/<owner>/<repo>/releases/latest/download/`.
     */
    private ownReleaseFeed(githubOwner: string): UpdateFeed {
        const tag = `v${getAppVersion()}`;
        return { kind: 'release', tag, url: releaseFeedUrl(githubOwner, tag) };
    }

    /**
     * The feeds a check on `channel` reads, in order of preference: the beta
     * channel is a superset of stable (user decision 2026-10-07), so a beta
     * check reads both and takes the higher version -- a stable release with
     * an equal core outranks its betas (`compareVersions`). On a tie the beta
     * feed wins, so nothing changes for a beta install until a stable release
     * is genuinely newer. The stable channel never reads the beta feed.
     *
     * The configured channel stays `beta` whichever feed wins (nothing here
     * writes config), so every check considers both again -- and so does the
     * stable version a beta install updates to: applying it records `beta`
     * first when the install has no stored channel ({@link keepChannelAcrossApply}).
     */
    private feedChannels(channel: UpdateChannel): UpdateChannel[] {
        return channel === 'beta' ? ['beta', 'stable'] : ['stable'];
    }

    /** `channel` is the one whose feed Velopack reads -- on a beta install, possibly `stable`. */
    private buildManager(feed: UpdateFeed, channel: UpdateChannel): UpdateManagerLike {
        return this.factory(
            feed,
            {
                ExplicitChannel: this.resolveExplicitChannel(channel),
                AllowVersionDowngrade: false,
                MaximumDeltasBeforeFallback: 10,
            },
            this.locator,
        );
    }

    /**
     * The feed channel the app should query. Linux publishes per-platform
     * channels (linux-beta / linux-stable) so its releases.<channel>.json feed
     * doesn't collide with the Windows beta/stable feeds on the same GitHub
     * release — so a Linux app must query 'linux-<channel>'. Windows queries the
     * raw channel. (macOS isn't shipped; it would query the raw channel here.)
     * MUST match the channel package-linux.mjs packs the AppImage with.
     */
    private resolveExplicitChannel(channel: UpdateChannel): string {
        return this.platform === 'linux' ? `linux-${channel}` : channel;
    }

    /**
     * Initial setup: detect install mode, build mgr if installed, schedule
     * background timer + fire one immediate check. Synchronous-ish; the
     * immediate check is fire-and-forget via void.
     */
    public init(): void {
        // Every path below replaces `this.state` wholesale, which drops the
        // pending update; its manager goes with it (see pendingMgr), and so does
        // any failed install of it (lastApplyError).
        this.pendingMgr = null;
        this.lastApplyErrorVersion = undefined;
        // v0.1.17: detect Velopack install via Update.exe (Windows) instead
        // of sq.version. sq.version is Squirrel.Windows naming (Velopack's
        // predecessor); Velopack drops Update.exe at the install root next
        // to current/. The pre-v0.1.17 sq.version check failed silently on
        // every production install (the file was never created) — combined
        // with the v0.1.15 installRoot fix this is the second of two
        // wrong assumptions that put the updater in permanent dev mode.
        //
        // Detect production mode: Update.exe on Windows, APPIMAGE env on Linux.
        let markerExists: boolean;
        if (this.platform === 'win32') {
            const markerPath = path.join(this.installRoot, 'Update.exe');
            markerExists = this.existsSync(markerPath);
            if (!markerExists) {
                log.info(`dev mode (Update.exe not found at ${markerPath})`);
            }
        } else {
            markerExists = !!(process.env['APPIMAGE'] && process.env['APPIMAGE'].length > 0);
            if (!markerExists) {
                log.info('dev mode (APPIMAGE env var not set)');
            }
        }

        if (!markerExists) {
            this.state = { isInstalled: false, currentVersion: getAppVersion(), status: 'idle' };
            return;
        }

        // Linux: a successful relaunch means the previous version's rollback
        // backup is safe to drop. Best-effort; ignore failures.
        if (this.platform !== 'win32') {
            const appImage = process.env['APPIMAGE'];
            if (appImage) {
                void fs.promises.rm(`${appImage}.bak`, { force: true }).catch(() => undefined);
            }
        }

        try {
            const cfg = Config.getInstance().getAppConfig();
            this.channel = cfg.channel;
            this.githubOwner = cfg.githubOwner;
            const feed = this.overrideFeed() ?? this.ownReleaseFeed(cfg.githubOwner);
            this.mgr = this.buildManager(feed, cfg.channel);
            this.mgrKey = feedKey(feed, this.resolveExplicitChannel(cfg.channel));
            const currentVersion = this.mgr.getCurrentVersion();
            this.state = { isInstalled: true, currentVersion, status: 'idle' };
            log.info(`initialized for v${currentVersion} on ${cfg.channel} channel`);

            this.restartTimer(cfg.updateCheckIntervalMinutes, cfg.autoUpdate);
            // Fire one immediate check on startup — fire-and-forget.
            void this.checkForUpdates();
        } catch (err) {
            // Marker present but mgr construction threw — corrupted install or SDK bug.
            log.warn(
                `Production marker present but UpdateManager construction failed: ${(err as Error).message}. ` +
                    'Falling back to installed-without-updates state.',
            );
            this.mgr = null;
            this.state = { isInstalled: true, currentVersion: getAppVersion(), status: 'idle' };
        }
    }

    /**
     * Switch to a new channel/owner and check at once. The check resolves the
     * new channel's newest release and builds a manager for it. On factory
     * failure, keeps the old mgr (if any) and surfaces the error in state —
     * caller's PATCH still returns 200 per decision 7 — and the next check
     * tries the build again.
     */
    public async reconfigure(channel: UpdateChannel, githubOwner: string): Promise<void> {
        if (!this.state.isInstalled) {
            return;
        }
        if (!this.mgr) {
            // init() couldn't construct UpdateManager — corrupted install,
            // SDK init failure, etc. Config is persisted by the caller;
            // reconfigure can't help here. Pre-v0.1.30 this also masked a
            // deterministic Linux throw caused by handing Velopack the
            // Windows-shape locator; the platform-branched locator
            // constructed above removes that failure mode, so this guard
            // is now defensive only.
            return;
        }
        this.generation++;
        this.channel = channel;
        this.githubOwner = githubOwner;
        this.clearPending();
        this.clearApplyError();
        this.state.availableVersion = undefined;
        this.state.errorMessage = undefined;
        this.state.status = 'idle';
        await this.runCheck('reconfigure failed');
    }

    /** Manual + auto-triggered check. Updates this.state. */
    public async checkForUpdates(): Promise<UpdateServiceState> {
        return this.runCheck('update source setup failed');
    }

    /**
     * One update check at a time per generation. A check asked for while one is
     * already running for the current generation (the startup check, the
     * interval timer, a manual check from the API) joins it, as a second
     * download joins the first (downloadIfNeeded).
     *
     * Two checks used to run side by side, each resolving the newest release
     * and swapping `mgr` for it across awaits. When the two resolved different
     * releases (one published between them, or the beta channel's winning feed
     * moving), the later-landing answer paired its UpdateInfo with the other
     * check's manager, and the Windows download 404'd: Velopack's HttpSource
     * joins the package name onto the manager's release folder.
     *
     * A check for an OLDER generation is not joined: reconfigure() bumps the
     * generation and must get a check of the new channel, and the old check
     * discards its own answer when it lands.
     *
     * Joining means a check that never ends would block every later one, so the
     * Velopack step has a deadline ({@link VELOPACK_CHECK_TIMEOUT_MS}).
     */
    private runCheck(buildFailurePrefix: string): Promise<UpdateServiceState> {
        if (this.applyInFlight) {
            // The apply works from the update, manager and channel it captured,
            // and a check now could set 'checking' over 'ready', replace or clear
            // the pending update, or start a Velopack download into the packages
            // folder the Windows hand-off is about to read. A failed apply clears
            // applyInFlight, so checks resume, and checks at once if a
            // reconfigure() was skipped here; a successful one ends in exit.
            log.info('update check skipped: an update is being applied');
            return Promise.resolve(this.state);
        }
        const generation = this.generation;
        if (this.check && this.check.generation === generation) {
            return this.check.done;
        }
        const done: Promise<UpdateServiceState> = this.performCheck(buildFailurePrefix, generation).finally(() => {
            if (this.check?.done === done) this.check = null;
        });
        this.check = { generation, done };
        return done;
    }

    /**
     * One update check: find the feed, (re)build the manager if the feed or
     * channel changed, ask Velopack. `buildFailurePrefix` labels a failed
     * manager build, so a reconfigure that cannot build says so. Never rejects.
     * Only {@link runCheck} calls it.
     */
    private async performCheck(buildFailurePrefix: string, generation: number): Promise<UpdateServiceState> {
        if (!this.mgr) {
            this.state.status = 'idle';
            return this.state;
        }

        const channel = this.channel;
        this.state.status = 'checking';
        this.state.errorMessage = undefined;
        let resolved = false;
        try {
            // One resolution per check, covering every feed the channel reads
            // (feedChannels) in a single walk of the listing. The resolver
            // caches each page by ETag, so an unchanged listing is answered
            // with 304s.
            let feed = this.overrideFeed();
            // The channel whose feed Velopack reads. An override feed is read
            // as the configured channel, as before.
            let feedChannel: UpdateChannel = channel;
            if (feed === null) {
                const candidates = this.feedChannels(channel);
                const release = await this.resolver.resolve(
                    this.githubOwner,
                    candidates.map((c) => this.resolveExplicitChannel(c)),
                );
                resolved = true;
                if (release) {
                    const won = candidates.find((c) => this.resolveExplicitChannel(c) === release.channel);
                    if (won === undefined) {
                        throw new Error(`release lookup answered feed ${release.channel}, which was not asked for`);
                    }
                    feedChannel = won;
                    feed = { kind: 'release', tag: release.tag, url: release.url };
                }
            }
            if (generation !== this.generation) return this.state; // reconfigured meanwhile
            if (feed === null) {
                // No release carries this channel's feed (today: stable, before
                // the first stable ships). Nothing to install -- not an error.
                this.state.lastCheckedAt = new Date();
                this.state.status = 'idle';
                this.state.availableVersion = undefined;
                this.clearPending();
                this.clearApplyError();
                return this.state;
            }

            // The key carries the feed's ExplicitChannel, so a beta install whose
            // newest candidate moves from the beta feed to the stable feed (or
            // back) rebuilds the manager.
            const key = feedKey(feed, this.resolveExplicitChannel(feedChannel));
            if (key !== this.mgrKey) {
                let built: UpdateManagerLike;
                try {
                    built = this.buildManager(feed, feedChannel);
                } catch (err) {
                    throw new Error(`${buildFailurePrefix}: ${(err as Error).message}`);
                }
                // Only swap once construction succeeded — keep the old mgr otherwise.
                this.mgr = built;
                this.mgrKey = key;
                if (feed.kind === 'release') {
                    log.info(
                        feedChannel === channel
                            ? `reading the ${channel} channel from release ${feed.tag}`
                            : `reading the ${channel} channel from ${feedChannel} release ${feed.tag}, ` +
                                  `newer than any ${channel} release`,
                    );
                }
            }

            // The manager this check asks is the one its answer is kept with.
            const mgr = this.mgr;
            const info = await this.velopackCheck(mgr);
            if (generation !== this.generation) return this.state;
            this.state.lastCheckedAt = new Date();
            if (info === null) {
                this.state.status = 'idle';
                this.state.availableVersion = undefined;
                this.clearPending();
                this.clearApplyError();
                return this.state;
            }

            // A failed install is kept only while the version it was about is
            // still the one on offer (see lastApplyError).
            if (info.TargetFullRelease.Version !== this.lastApplyErrorVersion) this.clearApplyError();
            this.state.availableVersion = info.TargetFullRelease.Version;
            this.setPending(info, feedChannel, mgr);

            const cfg = Config.getInstance().getAppConfig();
            // On Linux our apply downloads the published AppImage directly, so the
            // Velopack nupkg is never used — never pre-download it (saves ~60 MB per
            // check). On Windows, keep the autoUpdate pre-download. autoUpdate=false
            // also lands in the else. Availability is surfaced via status='ready';
            // on Windows the apply then downloads the package itself first
            // (downloadBeforeApply).
            if (cfg.autoUpdate && this.platform !== 'linux') {
                await this.downloadIfNeeded();
            } else {
                this.state.status = 'ready';
            }
        } catch (err) {
            if (generation !== this.generation) return this.state;
            // A resolved release that then failed (deleted, or its feed gone)
            // must not be re-served from cache: walk the listing next time.
            if (resolved) this.resolver.forget?.();
            this.state.status = 'error';
            this.state.errorMessage = (err as Error).message ?? 'check failed';
            log.warn(`check failed: ${this.state.errorMessage}`);
        }
        return this.state;
    }

    /**
     * `mgr.checkForUpdatesAsync()`, given up on after {@link VELOPACK_CHECK_TIMEOUT_MS}
     * with an error, so the check ends as `error` and the next one runs. The
     * abandoned call cannot be cancelled; whatever it answers later is dropped,
     * because only the race's result is read and the race has already settled.
     */
    private async velopackCheck(mgr: UpdateManagerLike): Promise<UpdateInfo | null> {
        const ms = this.velopackCheckTimeoutMs;
        let timer: NodeJS.Timeout | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(`update check timed out after ${ms / 1000} s`)), ms);
            // A hung call must not keep a stopping server alive for the rest of the minute.
            timer.unref?.();
        });
        try {
            return await Promise.race([mgr.checkForUpdatesAsync(), deadline]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Download the pending update. Updates progress.
     *
     * One download at a time, and only the current channel's result counts:
     *
     *  - A download already running for the SAME generation is joined, not
     *    duplicated.
     *  - A download still running for an OLDER generation (the channel or owner
     *    changed under it) is waited out first, then this generation's package
     *    is downloaded. It cannot be cancelled, and starting a second one beside
     *    it would fail: Velopack's download takes an exclusive lock on the
     *    packages folder (velopack 1.2.161 `manager.rs:406`). Waiting, rather
     *    than skipping the pre-download, leaves the new channel's package on
     *    disk for apply the same as any other auto-download.
     *  - A download whose generation was overtaken while it ran discards its
     *    result: it writes no progress, no `ready`, no `error` into the new
     *    channel's state.
     */
    public async downloadIfNeeded(): Promise<void> {
        const generation = this.generation;
        if (!this.pendingMgr || !this.state.pendingUpdate) return;

        while (this.download && this.download.generation !== generation) {
            // A waiter whose own channel was itself superseded must not touch the
            // state: a newer generation's download may already be reporting progress.
            if (generation !== this.generation) return;
            this.state.status = 'downloading';
            this.state.progress = 0;
            log.info('waiting for the previous channel download to finish before starting this one');
            await this.download.done;
        }
        if (generation !== this.generation || !this.pendingMgr || !this.state.pendingUpdate) return;
        if (this.download) {
            this.state.status = 'downloading';
            await this.download.done;
            return;
        }

        this.state.status = 'downloading';
        this.state.progress = 0;
        // The manager that produced the pending update, not `mgr`: a check may
        // have rebuilt `mgr` for another release since.
        const mgr = this.pendingMgr;
        const done: Promise<void> = this.runDownload(mgr, this.state.pendingUpdate, generation).finally(() => {
            if (this.download?.done === done) this.download = null;
        });
        this.download = { generation, done };
        await done;
    }

    /** Keep a check's answer with the manager and feed channel that produced it. */
    private setPending(info: UpdateInfo, channel: UpdateChannel, mgr: UpdateManagerLike): void {
        this.state.pendingUpdate = info;
        this.state.pendingChannel = channel;
        this.pendingMgr = mgr;
    }

    private clearPending(): void {
        this.state.pendingUpdate = undefined;
        this.state.pendingChannel = undefined;
        this.pendingMgr = null;
    }

    private clearApplyError(): void {
        this.state.lastApplyError = undefined;
        this.lastApplyErrorVersion = undefined;
    }

    /**
     * One Velopack download; never rejects. See {@link downloadIfNeeded}.
     *
     * Given up on as `error` once {@link DOWNLOAD_STALL_TIMEOUT_MS} passes with
     * no progress, for the check's download and the apply's alike: both wait on
     * it, and a hung one held the updater until a restart. The Velopack call
     * cannot be cancelled. Once given up on it is cut loose: its later progress
     * is ignored, and settling this promise drops it from `download`, so no
     * later download joins or waits on it. While it still runs it holds
     * Velopack's exclusive update lock (velopack 1.2.161 `manager.rs:406`,
     * `try_get_exclusive_lock`), so a new download fails at once with Velopack's
     * own error, an ordinary failure, until it ends.
     */
    private async runDownload(mgr: UpdateManagerLike, update: UpdateInfo, generation: number): Promise<void> {
        const ms = this.downloadStallTimeoutMs;
        // Set when this attempt is over, so the abandoned call's progress cannot land.
        let over = false;
        let timer: NodeJS.Timeout | undefined;
        let rearm = (): void => undefined;
        const stalled = new Promise<never>((_resolve, reject) => {
            rearm = () => {
                clearTimeout(timer);
                timer = setTimeout(() => {
                    over = true;
                    reject(new Error(`update download stalled (no progress for ${ms / 1000} s)`));
                }, ms);
                // A stalled download must not keep a stopping server alive.
                timer.unref?.();
            };
            rearm();
        });
        try {
            await Promise.race([
                mgr.downloadUpdateAsync(update, (perc: number) => {
                    if (over) return;
                    rearm();
                    if (generation !== this.generation) return;
                    this.state.progress = Math.min(100, Math.max(0, Math.round(perc)));
                }),
                stalled,
            ]);
            if (generation !== this.generation) {
                log.info(
                    `discarding the finished download of v${update.TargetFullRelease.Version}: the channel changed`,
                );
                return;
            }
            this.state.progress = 100;
            this.state.status = 'ready';
        } catch (err) {
            if (generation !== this.generation) {
                log.info(`discarding a failed download for the previous channel: ${(err as Error).message}`);
                return;
            }
            this.state.status = 'error';
            this.state.errorMessage = (err as Error).message ?? 'download failed';
            log.warn(`download failed: ${this.state.errorMessage}`);
        } finally {
            over = true;
            clearTimeout(timer);
        }
    }

    /**
     * Apply the pending update. Schedules Velopack to swap+restart on exit.
     * Caller (UpdatesApi.handleApply) is responsible for the deferred process.exit.
     *
     * v0.1.23-beta.13: now async — runs pre-apply hygiene (adb daemon kill +
     * Windows reap of the app's own adb binary + small settle delay) before Velopack's wait-then-apply
     * call. Without this, the long-lived `adb start-server` daemon's cwd-lock
     * on `<installRoot>\current\` (inherited from the launcher's working
     * directory at spawn time) blocks Velopack's rename-current-to-backup
     * step. Velopack's 10×1s retry was insufficient and apply gave up with
     * "Unable to start the update, because one or more running processes
     * prevented it." Diagnosed via Sysinternals handle.exe on the v0.1.23-beta.11
     * → beta.12 VM test (2026-04-29) — adb.exe held a persistent file handle
     * on `current\` across multiple apply attempts.
     *
     * Since 2026-10-06 that hygiene, and the hand-off markers, run at each path's
     * point of no return ({@link enterPointOfNoReturn}), not at the top: an apply
     * that stops before it (a declined pkexec, a failed download, a bad
     * checksum) leaves adb, the open streams and the markers as they were.
     *
     * Every path downloads before that point: Linux its AppImage, Windows the
     * Velopack package ({@link downloadBeforeApply}), so on Windows this can run
     * as long as a download.
     */
    public async applyUpdate(): Promise<{ redirectPort: number | null }> {
        // First: a running Windows apply shows `downloading` while it downloads,
        // and a second apply is refused for being one, not for that status.
        if (this.applyInFlight) {
            throw new Error('apply already in progress');
        }
        if (!this.pendingMgr || !this.state.pendingUpdate || this.state.status !== 'ready') {
            throw new Error(`apply not allowed in current state: ${this.state.status}`);
        }
        log.info(`applying update v${this.state.availableVersion}`);
        this.applyInFlight = true;
        // The manager, update and channel one check produced together.
        //
        // `pendingMgr` rather than `mgr` is the second safeguard; today no user
        // path reaches a `ready` state in which the two differ. `ready` is set
        // only by the check that just paired the update with the manager it
        // asked, or by that check's own download. A later check sets
        // `checking` before it can rebuild `mgr`, and ends idle (pending
        // cleared), ready (paired anew) or error (apply refused); a channel
        // change clears the pending update; and no check runs during an apply.
        // Only a direct downloadIfNeeded() during a check, which no route calls,
        // could produce it.
        const mgr = this.pendingMgr;
        const pendingUpdate = this.state.pendingUpdate;
        // The feed the pending update came from; set with it by every check. The
        // configured channel only covers a state no check produced.
        const pendingChannel = this.state.pendingChannel ?? this.channel;
        // A reconfigure() during the apply bumps this, and its check is skipped
        // (runCheck); a failed apply then checks the new channel itself.
        const generation = this.generation;
        const version = pendingUpdate.TargetFullRelease.Version;
        this.streamsStoppedForApply = false;
        // This attempt's outcome replaces the last one's.
        this.clearApplyError();
        try {
            // Windows hands the swap to Velopack or the operation-server, and
            // both read the package from the packages folder; neither downloads.
            // Linux downloads its AppImage inside applyByPath.
            if (this.platform === 'win32') {
                await this.downloadBeforeApply(mgr, pendingUpdate, generation);
                // After the download, so a failed one leaves nothing recorded;
                // before every Windows point of no return: the new version must
                // boot on the channel this one is configured with. Linux records
                // it after its own download (applyByPath).
                this.keepChannelAcrossApply(version);
            }
            return await this.applyByPath(mgr, pendingUpdate, pendingChannel);
        } catch (err) {
            this.applyInFlight = false;
            // A throw means no exit follows (UpdatesApi answers 403 or 500 and the
            // server keeps running). If the point of no return had already closed
            // the streams as a stop, new streams must be accepted again. A throw
            // before it (a declined pkexec, a failed download, a bad checksum)
            // stopped nothing, so there is nothing to cancel. See liveStreams.ts.
            if (this.streamsStoppedForApply) liveStreams.cancelStop();
            const sameUpdate = this.generation === generation;
            // Kept in the status beside `ready`, so the reason can be shown even
            // to a page that never got this apply's answer. Not for a declined
            // password prompt (the user's own choice, answered 403 uac-declined)
            // nor after a channel change (the update it was about is gone).
            if (sameUpdate && !(err instanceof PkexecDeclinedError)) {
                this.state.lastApplyError = (err as Error).message;
                this.lastApplyErrorVersion = version;
            }
            const downloadFailed = err instanceof ApplyDownloadError;
            // As a failed check does: the release may have been deleted or
            // replaced, so the next lookup must not be answered from cache.
            if (downloadFailed) this.resolver.forget?.();
            // Check again at once:
            //  - after a failed download, so a retry installs from a fresh
            //    pairing of update, manager and release instead of the one that
            //    just failed. It offers the same version, so lastApplyError
            //    survives it (performCheck);
            //  - after a channel change: reconfigure() cleared the pending update
            //    and set idle, but its check was skipped, so without this the new
            //    channel would wait for the next interval tick.
            // One call covers both. Never rejects (runCheck).
            if (!sameUpdate || downloadFailed) void this.checkForUpdates();
            throw err;
        }
    }

    /**
     * Make the configured channel survive the update to `targetVersion`.
     *
     * The channel a version boots with (Config.ts `resolveChannel`) is the
     * `app_settings` row when it is pinned (`CHANNEL_PINNED_KEY`) or says
     * `beta`; an unpinned `stable` row gives the version's own default
     * (`defaultChannelForVersion`) without consulting config.json. With no row
     * it is config.json's `channel` when that says `beta`, else the version's
     * default. Every channel write goes through `Config.updateAppConfig` -- the
     * Updates tab's Save, PATCH /api/config, PATCH /api/updates/config, and
     * this method -- which stores the row and its pin in one savepoint, and
     * `Config.saveToDisk` never writes `channel` into config.json (the Windows
     * MSI's skeleton value is dropped by the first save). So a beta install
     * whose user never touched the radio is on beta only by its version's
     * default -- and the beta channel also offers stable releases
     * (feedChannels), so taking one would boot it on stable, never to be
     * offered a beta again (review 2026-10-07, finding 1).
     *
     * Written only when the target's default differs from the configured
     * channel and the row does not already say it WITH the pin: a beta install
     * taking a beta release, or a stable install taking a stable one, writes
     * nothing, as before. A row that already matches but carries no pin (a
     * `beta` this method wrote before the pin existed) is written again, so the
     * pin lands beside it. The channel is read from Config now, not from
     * `this.channel`, so this writes the value the user has at this moment and
     * cannot undo a later radio change; the read and the write are one
     * synchronous step.
     *
     * A failed write -- of the row or of its pin -- refuses the apply, and the
     * savepoint leaves neither stored. Going ahead would silently move the
     * install to the other channel; refusing happens before anything has been
     * touched (no swap, no stopped streams), so the update stays `ready` and can
     * be retried.
     *
     * Called after each path's download and before its first irreversible step
     * (the machine-wide pkexec swap, each point of no return), so a download that
     * fails records nothing: before 2026-10-08 it ran first, and a failed
     * download still left the channel row written.
     */
    private keepChannelAcrossApply(targetVersion: string): void {
        const config = Config.getInstance();
        const channel = config.getAppConfig().channel;
        if (defaultChannelForVersion(targetVersion) === channel) return;
        try {
            const settings = config.db.appSettings;
            if (settings.get('channel') === channel && settings.get(CHANNEL_PINNED_KEY) === true) return;
            config.updateAppConfig({ channel });
        } catch (err) {
            const msg = `could not record the ${channel} channel before installing v${targetVersion}: ${(err as Error).message}`;
            log.error(`applyUpdate: ${msg}`);
            throw new Error(`apply: ${msg}`);
        }
        log.info(`applyUpdate: recorded the ${channel} channel so v${targetVersion} keeps it`);
    }

    /**
     * Windows: put the pending update's package in the packages folder before
     * anything irreversible, the way the Linux apply downloads its AppImage
     * first. Neither Windows hand-off downloads: Velopack's
     * `waitExitThenApplyUpdate` fails with "File does not exist" (velopack
     * 1.2.161 `manager.rs:602-634`), and the operation-server fails with
     * "nupkg named by manifest not found" (`operation_server.rs`
     * find_and_extract_nupkg) after the app has gone down. With
     * autoUpdate off the check never downloads, so before 2026-10-08 every
     * install on that setting failed (service mode after closing every stream,
     * local mode with the app shut down for good).
     *
     * With autoUpdate on, the check has already downloaded it, and this costs a
     * stat: Velopack skips a package already on disk (`manager.rs:414-415`),
     * without re-hashing it. The status shows `downloading` with progress
     * meanwhile; no check can overwrite that, since checks are skipped while an
     * apply runs (runCheck).
     *
     * downloadIfNeeded never rejects, so its outcome is read from the state. A
     * reconfigure() during the download changes the generation and clears the
     * pending update: the apply stops, rather than install a release the user
     * has just switched away from. A failed download leaves the update `ready`,
     * as a failed Linux download does, so the install can simply be retried;
     * the reason goes back to the caller in the error and stays in the status
     * as `lastApplyError`, and applyUpdate checks again at once. A download that
     * stops making progress fails the same way (runDownload).
     */
    private async downloadBeforeApply(
        mgr: UpdateManagerLike,
        pendingUpdate: UpdateInfo,
        generation: number,
    ): Promise<void> {
        await this.downloadIfNeeded();
        if (this.generation !== generation || this.state.pendingUpdate !== pendingUpdate || this.pendingMgr !== mgr) {
            throw new Error('update changed during download; nothing was installed');
        }
        if (this.state.status !== 'ready') {
            const reason = this.state.errorMessage ?? `the download ended in state ${this.state.status}`;
            this.state.status = 'ready';
            this.state.errorMessage = undefined;
            log.warn(`applyUpdate: download of v${pendingUpdate.TargetFullRelease.Version} failed: ${reason}`);
            throw new ApplyDownloadError(`update download failed: ${reason}`);
        }
    }

    /**
     * Everything `applyUpdate` does after its state check. Each path calls
     * {@link enterPointOfNoReturn} at its own point of no return.
     */
    private async applyByPath(
        mgr: UpdateManagerLike,
        pendingUpdate: UpdateInfo,
        pendingChannel: UpdateChannel,
    ): Promise<{ redirectPort: number | null }> {
        const installMode = Config.getInstance().getAppConfig().installMode;
        const isServiceMode = installMode === 'user-service' || installMode === 'system-service';

        // Windows service mode keeps Velopack's apply (the operation-server
        // handoff below). Linux service mode falls through to the download-based
        // apply (item 39) — branched by installMode in the Linux block.
        if (isServiceMode && this.platform === 'win32') {
            await this.enterPointOfNoReturn();
            try {
                mgr.waitExitThenApplyUpdate(pendingUpdate, true, false);
            } catch (err) {
                // The hand-off is not happening, so the markers written for it
                // must not outlive this attempt (as on the local-mode and pkexec
                // paths; see removeApplyHandoffMarkers).
                await this.removeApplyHandoffMarkers();
                throw err;
            }
            return { redirectPort: null };
        }

        // Linux local mode: Velopack 1.0.1's UpdateNix apply fails on our AppImage
        // (it re-derives a locator from `--root <appimage>` and fails the
        // UpdateExePath check — see docs/specs/2026-06-01-linux-appimage-self-update-design.md).
        // Replace it: download the published AppImage, verify its SHA-256 against the
        // release SHA256SUMS, then hand off to the out-of-mount helper to swap
        // $APPIMAGE + relaunch. (Service mode returned above, so this is local-only.)
        if (this.platform !== 'win32') {
            const config = Config.getInstance();
            const appCfg = config.getAppConfig();
            // The captured update's version, not the live state's: they are one
            // release only as long as nothing has rewritten the state.
            const version = pendingUpdate.TargetFullRelease.Version;
            if (!version) {
                throw new Error('apply: no available version resolved');
            }
            // The AppImage of the release the check resolved: a beta install
            // offered a newer stable release downloads WsScrcpyWeb-linux-stable,
            // the only AppImage that release publishes.
            const assetName = linuxAppImageAssetName(pendingChannel);
            // Item 169: WS_SCRCPY_RELEASE_URL_BASE moves both downloads off github.com
            // (a test / mirror seam). The SHA-256 check below runs either way.
            const baseOverride = process.env[RELEASE_URL_BASE_ENV]?.trim() || undefined;
            if (baseOverride) {
                log.info(`applyUpdate(linux): release assets from ${RELEASE_URL_BASE_ENV}=${baseOverride}`);
            }
            const appImageUrl = releaseAssetUrl(appCfg.githubOwner, version, assetName, baseOverride);
            const sumsUrl = releaseAssetUrl(appCfg.githubOwner, version, 'SHA256SUMS', baseOverride);

            const dataRoot = config.dataRoot ?? path.dirname(config.dependenciesPath);
            const stagingDir = path.join(dataRoot, 'control', 'update-staging');
            await fs.promises.mkdir(stagingDir, { recursive: true });
            const stagedPath = path.join(stagingDir, `${assetName}.new`);

            log.info(`applyUpdate(linux): downloading ${appImageUrl}`);
            await downloadVerifiedAsset({
                url: appImageUrl,
                sumsUrl,
                assetName,
                destPath: stagedPath,
                fetchFn: this.fetchFn,
            });
            // Downloaded and verified, and before the first irreversible step
            // (the machine-wide pkexec swap, else the point of no return), as on
            // Windows: a failed download records nothing. A refusal drops the
            // download, as a declined pkexec does below.
            try {
                this.keepChannelAcrossApply(version);
            } catch (err) {
                await fs.promises.rm(stagedPath, { force: true }).catch(() => undefined);
                throw err;
            }

            const homeAppImage = process.env['APPIMAGE'] ?? '';
            // The launcher stages this helper copy (named *.exe even on Linux) to
            // dataRoot on every boot — outside the AppImage mount, so it survives exit.
            const helperPath = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
            // installMode + the $APPIMAGE path select the apply shape. The helper
            // always OUTLIVES this AppImage's teardown — buildDetachedSpawn wraps it
            // in its own `systemd-run --collect` transient unit (separate cgroup; #27),
            // falling back to `setsid` then bare on non-systemd hosts:
            //  - local ('user'/'system', home $APPIMAGE): swap $APPIMAGE, wait for
            //    our pid, bare relaunch.
            //  - machine-wide-no-service (non-service installMode, /opt $APPIMAGE):
            //    elevate a RENAME-swap of the root-owned /opt binary via ONE pkexec
            //    (cp would ETXTBSY the running file), then a relaunch-ONLY helper
            //    (no --staged) waits for our pid (flock release) + relaunches /opt.
            //    The relaunch is NOT elevated (pkexec would come back as root).
            //  - user-service:  the helper stops/swaps/starts the --user unit;
            //    target = home $APPIMAGE (user manager).
            //  - system-service: the helper (root) stops/swaps/relabels/starts the
            //    system unit; target = the /opt staged copy; system-manager
            //    systemd-run (no --user). No pkexec — root self-update, headless.
            const STAGED_SYSTEM_TARGET = '/opt/ws-scrcpy-web/WsScrcpyWeb.AppImage';
            // Machine-wide-no-service discriminator: $APPIMAGE under the root-owned
            // /opt tree while installMode is NOT a service mode (the machine-wide
            // install leaves installMode at user/system/null — the /opt path is the
            // real signal, not installMode).
            const isMachineWide = !isServiceMode && homeAppImage.startsWith(`${STAGED_SYSTEM_DIR}/`);
            let target: string;
            let helperArgs: string[];
            let spawnSystem = false;
            if (installMode === 'system-service') {
                target = STAGED_SYSTEM_TARGET;
                helperArgs = [
                    '--linux-apply',
                    '--staged',
                    stagedPath,
                    '--target',
                    target,
                    '--service-restart',
                    'system',
                    '--unit',
                    WS_SCRCPY_SERVICE_NAME,
                    '--relabel',
                ];
                spawnSystem = true;
            } else if (installMode === 'user-service') {
                target = homeAppImage;
                helperArgs = [
                    '--linux-apply',
                    '--staged',
                    stagedPath,
                    '--target',
                    target,
                    '--service-restart',
                    'user',
                    '--unit',
                    WS_SCRCPY_SERVICE_NAME,
                ];
            } else if (isMachineWide) {
                // (1) elevate ONLY the swap (root-owned /opt). One pkexec prompt does
                //     the ETXTBSY-safe rename-swap of the /opt binary + VERSION write.
                try {
                    await this.runPkexecFn(
                        buildMachineWideUpdateScript({ stagedAppImage: stagedPath, version }),
                        'machine-wide-update',
                    );
                } catch (err) {
                    // Declined (PkexecDeclinedError → 403 uac-declined) or failed:
                    // nothing was swapped, so drop the download and leave the update
                    // `ready` for another try (smoke 14.10). No hand-off marker has
                    // been written and adb and the streams are untouched: both wait
                    // for the point of no return below.
                    await fs.promises.rm(stagedPath, { force: true }).catch(() => undefined);
                    throw err;
                }
                // (2) relaunch-ONLY helper (no --staged): the swap already happened
                //     above, so the helper just waits for our pid to exit (releasing
                //     the per-user flock) then relaunches the freshly-swapped /opt.
                target = homeAppImage;
                helperArgs = ['--linux-apply', '--target', target, '--wait-pid', String(process.pid)];
            } else {
                target = homeAppImage;
                helperArgs = [
                    '--linux-apply',
                    '--staged',
                    stagedPath,
                    '--target',
                    target,
                    '--wait-pid',
                    String(process.pid),
                ];
            }
            // A SYSTEM unit runs the helper as init_t, which may not exec the
            // var_lib_t data-root copy (FD2: the root self-update died 203/EXEC
            // and left the service down); stage a bin_t copy under /opt first.
            const spawnHelper = spawnSystem ? stageSystemHelper(helperPath) : helperPath;
            const plan = buildDetachedSpawn(spawnHelper, helperArgs, {
                unit: `wsscrcpy-apply-${Date.now()}`,
                system: spawnSystem,
                // The root service's own data root (/var/lib/ws-scrcpy-web): a
                // system transient unit has none, and the helper panics without one.
                dataRoot,
            });
            // Downloaded, verified and (machine-wide) swapped: nothing left can fail
            // and leave this server running, so the cleanup and the markers go now.
            await this.enterPointOfNoReturn();
            if (plan.viaSystemd) {
                // systemd-run registers the transient unit then exits promptly.
                // AWAIT it so the unit is registered before THIS process exits —
                // otherwise Node's exit can reap the systemd-run child (it's in
                // Node's cgroup) before registration completes and the helper unit
                // never starts. (The Rust relaunch waits the same way via .status.)
                await new Promise<void>((resolve) => {
                    const c = spawn(plan.cmd, plan.args, { stdio: 'ignore' });
                    c.once('exit', () => resolve());
                    c.once('error', () => resolve());
                });
                log.info(`applyUpdate(linux): registered apply helper via ${plan.cmd} (systemd) to swap ${target}`);
            } else {
                const child = spawn(plan.cmd, plan.args, { detached: true, stdio: 'ignore' });
                child.unref();
                log.info(
                    `applyUpdate(linux): spawned apply helper via ${plan.cmd} (pid ${child.pid}) to swap ${target}`,
                );
            }
            return { redirectPort: null };
        }

        const cfg = Config.getInstance();
        const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
        const helperPath = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
        const installRoot = path.resolve(__dirname, '..', '..');

        try {
            // §49: hand the operation-server the Velopack-authenticated
            // version + filename + SHA-256 so it can verify the nupkg (which
            // lives in the user-writable packages/ dir) before extracting it.
            await this.writeApplyVerifyManifest(pendingUpdate);
            await this.enterPointOfNoReturn();
            const child = spawn(helperPath, ['--operation-server'], {
                cwd: dataRoot,
                detached: true,
                stdio: 'ignore',
                env: {
                    ...process.env,
                    WS_SCRCPY_INSTALL_ROOT: installRoot,
                },
            });
            child.unref();
            log.info(`applyUpdate: spawned operation-server (pid ${child.pid})`);
        } catch (err) {
            log.error(`applyUpdate: failed to prepare or spawn operation-server: ${(err as Error).message}`);
            if (!this.streamsStoppedForApply) {
                // Failed before the point of no return (the verify manifest): no
                // stream was closed, adb runs and no marker was written. Report it
                // and keep running, as a failed Linux download does. Returning here
                // instead would let UpdatesApi exit with the streams still open.
                throw err;
            }
            // The hand-off is not happening, so the markers written for it must
            // not outlive this attempt: a lingering apply-update-pending makes the
            // launcher's NEXT graceful exit skip the tray reap (qa-harness Arc 3,
            // 2026-09-09), and a lingering suppress-browser-open swallows the next
            // launch's tab.
            await this.removeApplyHandoffMarkers();
            return { redirectPort: null };
        }

        const port = await this.pollOperationServerPort();
        if (port !== null) {
            log.info(`applyUpdate: operation-server ready on port ${port}`);
        } else {
            log.warn('applyUpdate: operation-server port file not found within timeout');
        }

        return { redirectPort: port };
    }

    /**
     * The point of no return of every apply path: close the streams and stop adb
     * (preApplyHygiene), then write the two launcher hand-off markers. Called
     * immediately before the step that hands the swap over -- AFTER the Linux
     * download, its SHA-256 check and the machine-wide pkexec swap. Before
     * 2026-10-06 this ran at the top of applyUpdate, so a cancelled password
     * prompt, a failed download or a bad checksum left the server running with
     * adb stopped and every stream closed, and left markers telling the next
     * start an update was under way.
     */
    private async enterPointOfNoReturn(): Promise<void> {
        // Set before the hygiene: it closes the streams as a stop
        // (liveStreams.closeAllForShutdown), and a throw part-way through must
        // still have applyUpdate cancel that stop.
        this.streamsStoppedForApply = true;
        await this.preApplyHygiene();
        await this.writeApplyUpdatePendingMarker();
        // D4: every applyUpdate brings the app down and the user's EXISTING tab is
        // carried through (reconnect / redirect / reload), so the relaunched server
        // must not auto-open a new tab. This consume-once marker tells it to skip
        // the open — needed on Windows local mode (no WS_SCRCPY_NO_BROWSER on the
        // Velopack relaunch); harmless elsewhere (Linux/service already suppress).
        await this.writeSuppressBrowserOpenMarker();
    }

    /**
     * Best-effort removal of the two hand-off markers when an apply does not
     * go ahead after they were written. Who consumes them when it DOES go
     * ahead: the server itself takes suppress-browser-open at startup; the
     * service-mode post-stop bat deletes apply-update-pending; and since
     * 2026-09-09 the launcher that comes up after the swap consumes
     * apply-update-pending at startup (launcher/src/supervisor.rs) -- in local
     * mode nothing had, and the updated app's next plain stop-exit left the tray
     * running (measured by qa-harness Arc 3).
     */
    private async removeApplyHandoffMarkers(): Promise<void> {
        const cfg = Config.getInstance();
        for (const p of [cfg.applyUpdatePendingMarkerPath, cfg.suppressBrowserOpenMarkerPath]) {
            try {
                await fs.promises.rm(p, { force: true });
            } catch (err) {
                log.warn(`applyUpdate: could not remove hand-off marker ${p}: ${(err as Error).message}`);
            }
        }
    }

    /**
     * Write the apply-update-pending marker that signals the launcher's
     * post-stop handler to restart the service after Velopack finishes its
     * swap. Best-effort: log + continue on failure. If the marker doesn't
     * get written, the post-stop handler sees no marker and no-ops (the
     * user has to manually restart the service), which is a worse-but-not-
     * fatal degradation. The Velopack apply itself still proceeds.
     *
     * The marker path (`<dataRoot>/control/apply-update-pending`) is mirrored on
     * the Rust side by `launcher/src/elevated_runner.rs::write_post_stop_bat`
     * (the Windows post-stop bat that reads it) and
     * `launcher/src/linux_apply.rs::apply_marker_path` (Linux);
     * `Config.applyUpdatePendingMarkerPath` is the single source of truth on the
     * Node side. Content is intentionally empty — the readers only check for
     * presence, not content.
     */
    private async writeApplyUpdatePendingMarker(): Promise<void> {
        const markerPath = Config.getInstance().applyUpdatePendingMarkerPath;
        try {
            await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
            await fs.promises.writeFile(markerPath, '', 'utf8');
            log.info(`applyUpdate: wrote apply-update-pending marker at ${markerPath}`);
        } catch (err) {
            log.warn(
                `applyUpdate: failed to write apply-update-pending marker at ${markerPath}: ${(err as Error).message} ` +
                    '— service will not auto-restart after Velopack swap; user must restart manually.',
            );
        }
    }

    /**
     * §49: write the verification manifest the operation-server reads before
     * extracting the downloaded nupkg. Carries Velopack's authenticated
     * version + filename + SHA-256 (from `UpdateInfo.TargetFullRelease`), so the
     * launcher (`operation_server.rs::find_and_extract_nupkg`) can re-verify the
     * package — which Velopack downloaded into the user-writable `packages/`
     * dir — before extracting + executing it. Windows local-mode only: service
     * mode uses Velopack's own verified apply, and Linux verifies against the
     * release SHA256SUMS. Throws on write failure so the caller skips spawning
     * an operation-server that would only fail-closed. `pendingUpdate` is the one
     * applyUpdate captured, the package Velopack downloaded.
     */
    private async writeApplyVerifyManifest(pendingUpdate: UpdateInfo): Promise<void> {
        const asset = pendingUpdate.TargetFullRelease;
        if (!asset) {
            throw new Error('apply: no pending update asset to build the verify manifest from');
        }
        if (!asset.SHA256) {
            log.warn(
                'applyUpdate: UpdateInfo has no SHA256 for the full package — the operation-server ' +
                    'will fail-closed and refuse to extract. Check the Velopack release feed.',
            );
        }
        const manifestPath = Config.getInstance().applyUpdateVerifyManifestPath;
        const body = JSON.stringify({
            version: asset.Version,
            fileName: asset.FileName,
            sha256: asset.SHA256,
        });
        await fs.promises.mkdir(path.dirname(manifestPath), { recursive: true });
        await fs.promises.writeFile(manifestPath, body, 'utf8');
        log.info(`applyUpdate: wrote apply-update-verify manifest at ${manifestPath}`);
    }

    /**
     * Write the consume-once `suppress-browser-open` marker (see
     * Config.suppressBrowserOpenMarkerPath). Best-effort: a failure at worst
     * yields one redundant browser tab on the post-update relaunch.
     */
    private async writeSuppressBrowserOpenMarker(): Promise<void> {
        const markerPath = Config.getInstance().suppressBrowserOpenMarkerPath;
        try {
            await fs.promises.mkdir(path.dirname(markerPath), { recursive: true });
            await fs.promises.writeFile(markerPath, '', 'utf8');
            log.info(`applyUpdate: wrote suppress-browser-open marker at ${markerPath}`);
        } catch (err) {
            log.warn(
                `applyUpdate: failed to write suppress-browser-open marker at ${markerPath}: ${(err as Error).message}`,
            );
        }
    }

    private async pollOperationServerPort(timeoutMs = 5000, intervalMs = 100): Promise<number | null> {
        const portFilePath = Config.getInstance().operationServerPortFilePath;
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const content = await fs.promises.readFile(portFilePath, 'utf8');
                const port = parseInt(content.trim(), 10);
                if (!Number.isNaN(port) && port > 0 && port <= 65535) {
                    return port;
                }
            } catch {
                // file doesn't exist yet
            }
            await new Promise((resolve) => setTimeout(resolve, intervalMs));
        }
        return null;
    }

    /**
     * Best-effort cleanup before the swap, run from {@link enterPointOfNoReturn}
     * immediately before the apply hands the swap over. All steps are
     * failure-tolerant — apply must proceed even if hygiene partially fails;
     * worst case we're back to v0.1.23-beta.12 behavior (apply still attempted,
     * Velopack's own retry loop catches what it can).
     *
     *  0. Close the open streams with 1001 (`liveStreams`), before step 1
     *     can end them as failures.
     *  1. `adb kill-server` via the bundled adb client. Clean shutdown of
     *     the daemon process; releases its CWD handle on the install dir.
     *  2. Windows-only belt-and-braces reap of the app's OWN adb binary
     *     (`Config.adbPath`), matched by executable path, each match killed
     *     with its tree (`util/reapOwnAdb.ts`). Catches the daemon if it
     *     didn't go down via kill-server (stuck transport, in-flight forward,
     *     etc.). This was `taskkill /F /IM adb.exe /T`, which also killed every
     *     other tool's adb (Android Studio's included) on every update; only
     *     the app's own daemon can hold a handle on `current\`, so only it is
     *     touched. Never throws.
     *  3. 250 ms settle delay. Empirical buffer for Windows to fully release
     *     handles after the daemon process exits — kernel ProcessExit can
     *     lag actual section/handle release by tens of milliseconds.
     */
    private async preApplyHygiene(): Promise<void> {
        const adbPath = Config.getInstance().adbPath;
        // Before kill-server, which kills each open stream's scrcpy-server: an
        // update is a deliberate stop, so its viewers get 1001, not "stream
        // failed". See liveStreams.ts.
        liveStreams.closeAllForShutdown();
        try {
            const adb = new AdbClient(adbPath);
            await adb.killServer();
            log.info('preApply: adb kill-server ok');
        } catch (err) {
            log.warn(`preApply: adb kill-server failed (continuing): ${(err as Error).message}`);
        }

        // Called on every platform -- the default reaper is a no-op off Windows
        // -- but only logged where it runs.
        const reaped = await this.reapOwnAdbFn(adbPath);
        if (process.platform === 'win32') {
            log.info(`preApply: reaped ${reaped} own adb process(es) (${adbPath})`);
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }

    /**
     * Restart the background timer with the given interval. Always clears any
     * existing timer first. No-op when not installed or interval is 0/negative.
     * Note: timer fires a check regardless of `autoUpdate` — the autoUpdate
     * flag gates auto-DOWNLOAD inside checkForUpdates, not the check itself.
     */
    public restartTimer(intervalMinutes: number, _autoUpdate: boolean): void {
        if (this.timer) {
            this.clearIntervalFn(this.timer);
            this.timer = null;
        }
        if (!this.state.isInstalled) return;
        if (intervalMinutes <= 0) return;
        const ms = intervalMinutes * 60 * 1000;
        this.timer = this.setIntervalFn(() => {
            void this.checkForUpdates();
        }, ms);
    }

    /** Snapshot state for the API response. Returns a shallow copy. */
    public getStatus(): UpdateServiceState {
        return { ...this.state };
    }
}
