// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as fs from 'fs';
// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as path from 'path';
import { UpdateManager, type UpdateInfo, type UpdateOptions } from 'velopack';
import type { UpdateChannel } from '../common/ConfigEvents';
import type { UpdateState } from '../common/UpdateEvents';
import { Config } from './Config';
import { Logger } from './Logger';

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

export type UpdateManagerFactory = (feedUrl: string, opts: UpdateOptions) => UpdateManagerLike;

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
}

export interface UpdateServiceState {
    isInstalled: boolean;
    currentVersion: string;
    status: UpdateState;
    progress?: number;
    availableVersion?: string;
    errorMessage?: string;
    lastCheckedAt?: Date;
    /** Internal: the UpdateInfo we got from checkForUpdatesAsync, kept until apply. */
    pendingUpdate?: UpdateInfo;
}

const defaultUpdateManagerFactory: UpdateManagerFactory = (feedUrl, opts) =>
    new UpdateManager(feedUrl, opts);

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
    private readonly factory: UpdateManagerFactory;
    private readonly feedUrlOverride: string | undefined;
    private readonly existsSync: (p: string) => boolean;
    private readonly setIntervalFn: (cb: () => void, ms: number) => NodeJS.Timeout;
    private readonly clearIntervalFn: (handle: NodeJS.Timeout) => void;

    constructor(opts: UpdateServiceOptions = {}) {
        this.installRoot = opts.installRoot ?? path.dirname(process.execPath);
        this.factory = opts.updateManagerFactory ?? defaultUpdateManagerFactory;
        this.feedUrlOverride = opts.feedUrlOverride;
        this.existsSync = opts.existsSync ?? fs.existsSync;
        this.setIntervalFn = opts.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
        this.clearIntervalFn = opts.clearIntervalFn ?? ((handle) => clearInterval(handle));
        this.state = { isInstalled: false, currentVersion: '', status: 'idle' };
    }

    /** Build feed URL — env override > opts override > default github releases URL. */
    private buildFeedUrl(githubOwner: string): string {
        const envOverride = process.env['VELOPACK_FEED_URL'];
        if (envOverride) return envOverride;
        if (this.feedUrlOverride) return this.feedUrlOverride;
        return `https://github.com/${githubOwner}/ws-scrcpy-web/releases/latest/download/`;
    }

    /**
     * Initial setup: detect install mode, build mgr if installed, schedule
     * background timer + fire one immediate check. Synchronous-ish; the
     * immediate check is fire-and-forget via void.
     */
    public init(): void {
        const sqVersionPath = path.join(this.installRoot, 'sq.version');
        const sqExists = this.existsSync(sqVersionPath);

        if (!sqExists) {
            this.state = { isInstalled: false, currentVersion: '', status: 'idle' };
            log.info(`dev mode (sq.version not found at ${sqVersionPath})`);
            return;
        }

        try {
            const cfg = Config.getInstance().getAppConfig();
            const feedUrl = this.buildFeedUrl(cfg.githubOwner);
            this.mgr = this.factory(feedUrl, {
                ExplicitChannel: cfg.channel,
                AllowVersionDowngrade: false,
                MaximumDeltasBeforeFallback: 10,
            });
            const currentVersion = this.mgr.getCurrentVersion();
            this.state = { isInstalled: true, currentVersion, status: 'idle' };
            log.info(`initialized for v${currentVersion} on ${cfg.channel} channel`);

            this.restartTimer(cfg.updateCheckIntervalMinutes, cfg.autoUpdate);
            // Fire one immediate check on startup — fire-and-forget.
            void this.checkForUpdates();
        } catch (err) {
            // sq.version present but mgr construction threw — corrupted install or SDK bug.
            log.warn(
                `sq.version exists but UpdateManager construction failed: ${(err as Error).message}. ` +
                    `Treating as dev mode.`,
            );
            this.mgr = null;
            this.state = { isInstalled: false, currentVersion: '', status: 'idle' };
        }
    }

    /**
     * Re-create the internal mgr with new channel/owner. Triggers an immediate
     * check. On factory failure, keeps the old mgr (if any) and surfaces the
     * error in state — caller's PATCH still returns 200 per decision 7.
     */
    public async reconfigure(channel: UpdateChannel, githubOwner: string): Promise<void> {
        if (!this.state.isInstalled) {
            // Dev mode — config persisted by caller, but no UpdateManager to swap.
            return;
        }
        const feedUrl = this.buildFeedUrl(githubOwner);
        try {
            const newMgr = this.factory(feedUrl, {
                ExplicitChannel: channel,
                AllowVersionDowngrade: false,
                MaximumDeltasBeforeFallback: 10,
            });
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
            if (cfg.autoUpdate) {
                await this.downloadIfNeeded();
            } else {
                // autoUpdate disabled: surface "available" via status='ready' but no download yet.
                // waitExitThenApplyUpdate handles undownloaded updates internally on Apply.
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
     */
    public applyUpdate(): void {
        if (!this.mgr || !this.state.pendingUpdate || this.state.status !== 'ready') {
            throw new Error(`apply not allowed in current state: ${this.state.status}`);
        }
        log.info(`applying update v${this.state.availableVersion}`);
        // silent=true (no UI from Velopack updater), restart=true (Velopack relaunches us).
        this.mgr.waitExitThenApplyUpdate(this.state.pendingUpdate, true, true);
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
