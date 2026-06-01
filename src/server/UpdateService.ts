// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { execFile, spawn } from 'child_process';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import { promisify } from 'util';
import {
    UpdateManager,
    type UpdateInfo,
    type UpdateOptions,
    type VelopackLocatorConfig,
} from 'velopack';
import { getAppVersion } from './appVersion';
import type { UpdateChannel } from '../common/ConfigEvents';
import type { UpdateState } from '../common/UpdateEvents';
import { AdbClient } from './AdbClient';
import { Config } from './Config';
import { Logger } from './Logger';
import { linuxAppImageAssetName, releaseAssetUrl, parseSha256Sums } from './linuxUpdateAssets';
import { verifySha256 } from './verifySha256';
import { downloadToFile, fetchText } from './downloadToFile';

const execFileAsync = promisify(execFile);

const log = Logger.for('UpdateService');

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

export type UpdateManagerFactory = (
    feedUrl: string,
    opts: UpdateOptions,
    locator?: VelopackLocatorConfig,
) => UpdateManagerLike;

export interface UpdateServiceOptions {
    /** Override the install-root path used for sq.version detection. Default: dirname(process.execPath). */
    installRoot?: string;
    /** Override the UpdateManager constructor for tests. Default: real velopack import. */
    updateManagerFactory?: UpdateManagerFactory;
    /** Override the feed URL builder for tests / VELOPACK_FEED_URL env override. */
    feedUrlOverride?: string;
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
}

export interface UpdateServiceState {
    isInstalled: boolean;
    currentVersion: string;
    status: UpdateState;
    progress?: number | undefined;
    availableVersion?: string | undefined;
    errorMessage?: string | undefined;
    lastCheckedAt?: Date | undefined;
    /** Internal: the UpdateInfo we got from checkForUpdatesAsync, kept until apply. */
    pendingUpdate?: UpdateInfo | undefined;
}

const defaultUpdateManagerFactory: UpdateManagerFactory = (feedUrl, opts, locator) =>
    new UpdateManager(feedUrl, opts, locator);

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
    private state: UpdateServiceState;
    private timer: NodeJS.Timeout | null = null;
    private readonly installRoot: string;
    private readonly platform: NodeJS.Platform;
    private readonly locator: VelopackLocatorConfig | undefined;
    private readonly factory: UpdateManagerFactory;
    private readonly feedUrlOverride: string | undefined;
    private readonly existsSync: (p: string) => boolean;
    private readonly setIntervalFn: (cb: () => void, ms: number) => NodeJS.Timeout;
    private readonly clearIntervalFn: (handle: NodeJS.Timeout) => void;
    private readonly fetchFn: typeof fetch;

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
        //   runs inside the Node binary, which (Local-Dependencies-Only) lives at
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
        this.existsSync = opts.existsSync ?? fs.existsSync;
        this.setIntervalFn = opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
        this.clearIntervalFn = opts.clearIntervalFn ?? ((handle) => clearInterval(handle));
        this.fetchFn = opts.fetchFn ?? fetch;
        this.state = { isInstalled: false, currentVersion: '', status: 'idle' };
    }

    /** Build feed URL — env override > opts override > default github repo URL. */
    private buildFeedUrl(githubOwner: string): string {
        const envOverride = process.env['VELOPACK_FEED_URL'];
        if (envOverride) return envOverride;
        if (this.feedUrlOverride) return this.feedUrlOverride;
        // v0.1.18: use the bare GitHub repo URL. Velopack's GitHub source
        // detects this form and queries the GitHub API
        // (api.github.com/repos/<owner>/<repo>/releases) to enumerate
        // releases for the configured channel — no redirect chain, no
        // static-URL probing.
        //
        // Pre-v0.1.18 this was `https://github.com/<owner>/<repo>/releases/latest/download/`.
        // The trailing `/releases/latest/download/` form is GitHub's
        // browser-friendly redirect alias for asset URLs, but Velopack
        // doesn't recognize it as a GitHub source — it falls through
        // to its static-URL HTTP client, which can't navigate the
        // 302→302→release-assets.githubusercontent.com chain GitHub
        // serves and returns "404" for the asset fetch.
        return `https://github.com/${githubOwner}/ws-scrcpy-web`;
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
            const feedUrl = this.buildFeedUrl(cfg.githubOwner);
            this.mgr = this.factory(
                feedUrl,
                {
                    ExplicitChannel: this.resolveExplicitChannel(cfg.channel),
                    AllowVersionDowngrade: false,
                    MaximumDeltasBeforeFallback: 10,
                },
                this.locator,
            );
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
                    `Falling back to installed-without-updates state.`,
            );
            this.mgr = null;
            this.state = { isInstalled: true, currentVersion: getAppVersion(), status: 'idle' };
        }
    }

    /**
     * Re-create the internal mgr with new channel/owner. Triggers an immediate
     * check. On factory failure, keeps the old mgr (if any) and surfaces the
     * error in state — caller's PATCH still returns 200 per decision 7.
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
        const feedUrl = this.buildFeedUrl(githubOwner);
        try {
            const newMgr = this.factory(
                feedUrl,
                {
                    ExplicitChannel: this.resolveExplicitChannel(channel),
                    AllowVersionDowngrade: false,
                    MaximumDeltasBeforeFallback: 10,
                },
                this.locator,
            );
            // Only swap if construction succeeded — keep the old mgr otherwise.
            this.mgr = newMgr;
            this.state.pendingUpdate = undefined;
            this.state.availableVersion = undefined;
            this.state.errorMessage = undefined;
            this.state.status = 'idle';
            await this.checkForUpdates();
        } catch (err) {
            this.state.status = 'error';
            this.state.errorMessage = `reconfigure failed: ${(err as Error).message}`;
            log.warn(`reconfigure failed (keeping previous mgr): ${this.state.errorMessage}`);
        }
    }

    /** Manual + auto-triggered check. Updates this.state. */
    public async checkForUpdates(): Promise<UpdateServiceState> {
        if (!this.mgr) {
            this.state.status = 'idle';
            return this.state;
        }

        this.state.status = 'checking';
        this.state.errorMessage = undefined;
        try {
            const info = await this.mgr.checkForUpdatesAsync();
            this.state.lastCheckedAt = new Date();
            if (info === null) {
                this.state.status = 'idle';
                this.state.availableVersion = undefined;
                this.state.pendingUpdate = undefined;
                return this.state;
            }

            this.state.availableVersion = info.TargetFullRelease.Version;
            this.state.pendingUpdate = info;

            const cfg = Config.getInstance().getAppConfig();
            // On Linux our apply downloads the published AppImage directly, so the
            // Velopack nupkg is never used — never pre-download it (saves ~60 MB per
            // check). On Windows, keep the autoUpdate pre-download. autoUpdate=false
            // also lands in the else. Availability is surfaced via status='ready'.
            if (cfg.autoUpdate && this.platform !== 'linux') {
                await this.downloadIfNeeded();
            } else {
                this.state.status = 'ready';
            }
        } catch (err) {
            this.state.status = 'error';
            this.state.errorMessage = (err as Error).message ?? 'check failed';
            log.warn(`check failed: ${this.state.errorMessage}`);
        }
        return this.state;
    }

    /** Download the pending update. Updates progress. Idempotent during 'downloading'. */
    public async downloadIfNeeded(): Promise<void> {
        if (!this.mgr || !this.state.pendingUpdate) return;
        if (this.state.status === 'downloading') return;

        this.state.status = 'downloading';
        this.state.progress = 0;
        try {
            await this.mgr.downloadUpdateAsync(this.state.pendingUpdate, (perc: number) => {
                this.state.progress = Math.min(100, Math.max(0, Math.round(perc)));
            });
            this.state.progress = 100;
            this.state.status = 'ready';
        } catch (err) {
            this.state.status = 'error';
            this.state.errorMessage = (err as Error).message ?? 'download failed';
            log.warn(`download failed: ${this.state.errorMessage}`);
        }
    }

    /**
     * Apply the pending update. Schedules Velopack to swap+restart on exit.
     * Caller (UpdatesApi.handleApply) is responsible for the deferred process.exit.
     *
     * v0.1.23-beta.13: now async — runs pre-apply hygiene (adb daemon kill +
     * Windows taskkill + small settle delay) before Velopack's wait-then-apply
     * call. Without this, the long-lived `adb start-server` daemon's cwd-lock
     * on `<installRoot>\current\` (inherited from the launcher's working
     * directory at spawn time) blocks Velopack's rename-current-to-backup
     * step. Velopack's 10×1s retry was insufficient and apply gave up with
     * "Unable to start the update, because one or more running processes
     * prevented it." Diagnosed via Sysinternals handle.exe on the v0.1.23-beta.11
     * → beta.12 VM test (2026-04-29) — adb.exe held a persistent file handle
     * on `current\` across multiple apply attempts.
     */
    public async applyUpdate(): Promise<{ redirectPort: number | null }> {
        if (!this.mgr || !this.state.pendingUpdate || this.state.status !== 'ready') {
            throw new Error(`apply not allowed in current state: ${this.state.status}`);
        }
        log.info(`applying update v${this.state.availableVersion}`);
        await this.preApplyHygiene();

        const installMode = Config.getInstance().getAppConfig().installMode;
        const isServiceMode = installMode === 'user-service' || installMode === 'system-service';

        await this.writeApplyUpdatePendingMarker();

        if (isServiceMode) {
            this.mgr.waitExitThenApplyUpdate(this.state.pendingUpdate, true, false);
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
            const version = this.state.availableVersion;
            if (!version) {
                throw new Error('apply: no available version resolved');
            }
            const assetName = linuxAppImageAssetName(appCfg.channel);
            const appImageUrl = releaseAssetUrl(appCfg.githubOwner, version, assetName);
            const sumsUrl = releaseAssetUrl(appCfg.githubOwner, version, 'SHA256SUMS');

            const dataRoot = config.dataRoot ?? path.dirname(config.dependenciesPath);
            const stagingDir = path.join(dataRoot, 'control', 'update-staging');
            await fs.promises.mkdir(stagingDir, { recursive: true });
            const stagedPath = path.join(stagingDir, `${assetName}.new`);

            log.info(`applyUpdate(linux): downloading ${appImageUrl}`);
            await downloadToFile(appImageUrl, stagedPath, this.fetchFn);
            const sumsText = await fetchText(sumsUrl, this.fetchFn);
            const expected = parseSha256Sums(sumsText, assetName);
            if (!expected) {
                await fs.promises.rm(stagedPath, { force: true });
                throw new Error(`apply: SHA256SUMS has no entry for ${assetName}`);
            }
            const ok = await verifySha256(stagedPath, expected);
            if (!ok) {
                await fs.promises.rm(stagedPath, { force: true });
                throw new Error(`apply: SHA-256 mismatch for ${assetName} — aborting`);
            }

            const appImagePath = process.env['APPIMAGE'] ?? '';
            // The launcher stages this helper copy (named *.exe even on Linux) to
            // dataRoot on every boot — outside the AppImage mount, so it survives exit.
            const helperPath = path.join(dataRoot, 'control', 'operation-server', 'ws-scrcpy-web-launcher.exe');
            const child = spawn(
                helperPath,
                ['--linux-apply', '--staged', stagedPath, '--target', appImagePath, '--wait-pid', String(process.pid)],
                { detached: true, stdio: 'ignore' },
            );
            child.unref();
            log.info(`applyUpdate(linux): spawned helper pid ${child.pid} to swap ${appImagePath}`);
            return { redirectPort: null };
        }

        const cfg = Config.getInstance();
        const dataRoot = cfg.dataRoot ?? path.dirname(cfg.dependenciesPath);
        const helperPath = path.join(
            dataRoot,
            'control', 'operation-server', 'ws-scrcpy-web-launcher.exe',
        );
        const installRoot = path.resolve(__dirname, '..', '..');

        try {
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
            log.error(`applyUpdate: failed to spawn operation-server: ${(err as Error).message}`);
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
     * Write the apply-update-pending marker that signals the launcher's
     * post-stop handler to restart the service after Velopack finishes its
     * swap. Best-effort: log + continue on failure. If the marker doesn't
     * get written, the post-stop handler sees no marker and no-ops (the
     * user has to manually restart the service), which is a worse-but-not-
     * fatal degradation. The Velopack apply itself still proceeds.
     *
     * Path matches `launcher/src/post_stop_handler.rs::marker_path` and
     * `Config.applyUpdatePendingMarkerPath` (single source of truth on the
     * Node side). Content is intentionally empty — the post-stop handler
     * only checks for presence, not content.
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
                    `— service will not auto-restart after Velopack swap; user must restart manually.`,
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
                if (!isNaN(port) && port > 0 && port <= 65535) {
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
     * Best-effort cleanup before Velopack's swap. All steps are
     * failure-tolerant — apply must proceed even if hygiene partially fails;
     * worst case we're back to v0.1.23-beta.12 behavior (apply still attempted,
     * Velopack's own retry loop catches what it can).
     *
     *  1. `adb kill-server` via the bundled adb client. Clean shutdown of
     *     the daemon process; releases its CWD handle on the install dir.
     *  2. Windows-only `taskkill /F /IM adb.exe /T` belt-and-braces. Catches
     *     any adb process that didn't go down via kill-server (stuck transport,
     *     in-flight forward, etc.). Non-zero exit (no matching processes) is
     *     not an error.
     *  3. 250 ms settle delay. Empirical buffer for Windows to fully release
     *     handles after the daemon process exits — kernel ProcessExit can
     *     lag actual section/handle release by tens of milliseconds.
     */
    private async preApplyHygiene(): Promise<void> {
        try {
            const adb = new AdbClient(Config.getInstance().adbPath);
            await adb.killServer();
            log.info('preApply: adb kill-server ok');
        } catch (err) {
            log.warn(`preApply: adb kill-server failed (continuing): ${(err as Error).message}`);
        }

        if (process.platform === 'win32') {
            try {
                await execFileAsync('C:\\Windows\\System32\\taskkill.exe', ['/F', '/IM', 'adb.exe', '/T'], { timeout: 5_000 });
                log.info('preApply: taskkill /F /IM adb.exe ok');
            } catch {
                // taskkill exits non-zero when no matching process; treat as success.
                log.info('preApply: taskkill /F /IM adb.exe (no matching processes — ok)');
            }
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
