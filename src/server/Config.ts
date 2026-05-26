import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import {
    APP_CONFIG_DEFAULTS,
    type AppConfig,
    type FirstRunStatus,
    type InstallMode,
    VALID_CHANNELS,
    VALID_INSTALL_MODES,
} from '../common/ConfigEvents';
import type { ServerItem } from '../types/Configuration';
import { EnvName } from './EnvName';

const DEFAULT_SCAN_CONCURRENCY = 64;
const DEFAULT_SCAN_TCP_TIMEOUT_MS = 300;
const DEFAULT_SCAN_ADB_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_SCAN_PROGRESS_INTERVAL = 10;

/**
 * Minimal flat config supported by config.json:
 *   { "webPort": 8000, "adbPath": "adb" }
 *
 * Legacy `port` is still accepted and mapped to `webPort` in memory (migration
 * is non-destructive: the file is not rewritten unless another save happens).
 *
 * The full ServerItem array form is also accepted for advanced SSL setups:
 *   { "server": [{ "secure": true, "port": 443, "options": { ... } }] }
 */
export interface FlatConfig {
    // Legacy / pre-existing
    port?: number;
    adbPath?: string;
    dependenciesPath?: string;
    scanConcurrency?: number;
    scanTcpTimeoutMs?: number;
    scanAdbConnectTimeoutMs?: number;
    scanProgressInterval?: number;
    server?: ServerItem[];

    // SP3 lifecycle fields
    webPort?: number;
    installMode?: InstallMode | null;
    firstRunComplete?: boolean;
    serviceFirstRunSeen?: boolean;
    autoUpdate?: boolean;
    updateCheckIntervalMinutes?: number;
    channel?: 'stable' | 'beta';
    githubOwner?: string;
}

/**
 * Pure resolver: produces the absolute dependencies-folder path the app should
 * manage. Priority: DEPS_PATH env → config.json → platform-specific fallback.
 *
 * On Windows, fallback is <dataRoot>/dependencies/ (default
 * %PROGRAMDATA%\WsScrcpyWeb\dependencies\) — matching launcher/src/paths.rs:65-68
 * so dev mode running `node dist/index.js` from the repo reads the same
 * dependencies folder an MSI install does. There is no dev-tell gate on
 * Windows; ProgramData IS the dependencies home regardless of dev vs install.
 *
 * On non-Windows, fallback is <entryDir>/../dependencies/ gated on a
 * package.json sibling "dev tell" — the same behavior as pre-Phase-1.
 * paths.rs:62 collapses data_root onto install_root for Linux, so there's
 * no migration target yet; a v0.5.0 follow-up tracks the Linux design.
 */
export function resolveDependenciesPath(
    env: NodeJS.ProcessEnv,
    fileConfig: FlatConfig,
    entryScript: string,
    exists: (p: string) => boolean = fs.existsSync,
    platform: NodeJS.Platform = process.platform,
): string {
    if (env['DEPS_PATH']) return env['DEPS_PATH'];
    if (fileConfig.dependenciesPath) return fileConfig.dependenciesPath;

    if (platform === 'win32') {
        const dataRoot = resolveDataRoot(env, platform);
        if (dataRoot) return path.win32.join(dataRoot, 'dependencies');
        // resolveDataRoot returns non-null on Windows by contract; this is
        // a defensive fallthrough for tests that mock resolveDataRoot.
    }

    const entryDir = path.dirname(entryScript);
    const devCandidate = path.resolve(entryDir, '..', 'dependencies');
    const devTell = path.resolve(entryDir, '..', 'package.json');
    if (exists(devTell)) return devCandidate;

    throw new Error(
        'DEPS_PATH is not set and no dependencies path is configured. ' +
        'On Windows, dependencies are expected at <dataRoot>/dependencies ' +
        '(default %PROGRAMDATA%\\WsScrcpyWeb\\dependencies). ' +
        'On Linux, set DEPS_PATH or place a `dependencies/` folder next to ' +
        'a `package.json` sibling of the entry script.',
    );
}

/**
 * Pure resolver: produces the absolute path the server should use when
 * spawning adb. Per the "Local Dependencies Only" architecture, this MUST
 * resolve to the app's local dependencies folder. There is no system-PATH
 * fallback and no host env-var resolution — if adb isn't there, the app
 * fetches it via `DependencyManager`. Until autoInstall populates it,
 * adb-dependent operations (scan, device probe, etc.) will fail visibly
 * via `AdbExecError('spawn', ...)` and surface as `scan.error` — they will
 * not silently fall through to whatever adb the OS happens to expose.
 *
 * Priority chain:
 *   1. `fileConfig.adbPath` — user-explicit override in config.json. The
 *      user is responsible for pointing this at a real local binary; we
 *      do not validate. Useful for shared-deps install layouts.
 *   2. `<dependenciesPath>/adb/adb.exe` (Windows) or `<dependenciesPath>/adb/adb`
 *      (POSIX) — the canonical local binary. **Returned unconditionally**:
 *      the file may not yet exist on first run before `autoInstallMissing`
 *      completes. AdbClient will throw `AdbExecError('spawn', ...)` cleanly
 *      in that window and the scanner's catch will surface the reason.
 */
export function resolveAdbPath(
    fileConfig: FlatConfig,
    dependenciesPath: string,
    platform: NodeJS.Platform = process.platform,
): { path: string; source: 'config' | 'bundled' } {
    if (fileConfig.adbPath) return { path: fileConfig.adbPath, source: 'config' };
    const exeName = platform === 'win32' ? 'adb.exe' : 'adb';
    // Use the target-platform's path joiner so cross-platform tests don't
    // produce host-platform-shaped paths (e.g. backslashes on a Win host
    // when computing a Linux install layout).
    const joiner = platform === 'win32' ? path.win32 : path.posix;
    return { path: joiner.join(dependenciesPath, 'adb', exeName), source: 'bundled' };
}

/**
 * Pure resolver for the writable-state root (Phase 1 of the Program Files
 * migration plan). On Windows this is `<PROGRAMDATA>\WsScrcpyWeb` — a
 * machine-wide, all-users-writable location distinct from the install root
 * (where Velopack manages binaries). Returns `null` on non-Windows; the
 * AppImage layout is unchanged for now.
 *
 * Defaulting `PROGRAMDATA` to `C:\ProgramData` matches Microsoft's
 * documented value for the system ProgramData folder when the env var is
 * unexpectedly missing — an extremely rare edge but worth covering rather
 * than crashing.
 */
export function resolveDataRoot(
    env: NodeJS.ProcessEnv,
    platform: NodeJS.Platform = process.platform,
): string | null {
    if (platform !== 'win32') return null;
    const programData = env['PROGRAMDATA'] && env['PROGRAMDATA'].length > 0
        ? env['PROGRAMDATA']
        : 'C:\\ProgramData';
    return path.win32.join(programData, 'WsScrcpyWeb');
}

/**
 * Resolve the path used for reading/writing config.json when no override is
 * supplied via EnvName.CONFIG_PATH. Order:
 *   1. <dataRoot>/config.json when `dataRoot` is provided (production path
 *      after Phase 1 — the writable state root that the launcher and the
 *      Node server agree on).
 *   2. <repoRoot>/config.json — dev fallback when no dataRoot is supplied.
 *      Computed as the parent of the entry script's directory, matching the
 *      pre-Phase-1 behavior where config.json sat next to dist/.
 */
export function resolveConfigPath(
    entryScript: string,
    exists: (p: string) => boolean = fs.existsSync,
    dataRoot: string | null = null,
): string {
    if (dataRoot) {
        return path.join(dataRoot, 'config.json');
    }
    const entryDir = path.dirname(entryScript);
    const repoRoot = path.resolve(entryDir, '..');
    if (exists(path.join(repoRoot, 'package.json'))) {
        return path.join(repoRoot, 'config.json');
    }
    return path.join(repoRoot, 'config.json');
}

function isInteger(n: unknown): n is number {
    return typeof n === 'number' && Number.isInteger(n);
}

/**
 * Validate a single AppConfig field. Returns either the accepted value
 * (possibly coerced) or a string error message describing the failure.
 */
type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function validateField<K extends keyof AppConfig>(key: K, value: unknown): ValidationResult<AppConfig[K]> {
    switch (key) {
        case 'webPort': {
            if (!isInteger(value) || (value as number) < 1024 || (value as number) > 65535) {
                return { ok: false, error: 'webPort must be an integer between 1024 and 65535' };
            }
            return { ok: true, value: value as AppConfig[K] };
        }
        case 'updateCheckIntervalMinutes': {
            if (!isInteger(value) || (value as number) < 5 || (value as number) > 1440) {
                return { ok: false, error: 'updateCheckIntervalMinutes must be an integer between 5 and 1440' };
            }
            return { ok: true, value: value as AppConfig[K] };
        }
        case 'channel': {
            if (typeof value !== 'string' || !VALID_CHANNELS.includes(value as 'stable' | 'beta')) {
                return { ok: false, error: `channel must be one of: ${VALID_CHANNELS.join(', ')}` };
            }
            return { ok: true, value: value as AppConfig[K] };
        }
        case 'installMode': {
            if (value === null) return { ok: true, value: null as AppConfig[K] };
            if (typeof value !== 'string' || !VALID_INSTALL_MODES.includes(value as InstallMode)) {
                return { ok: false, error: `installMode must be null or one of: ${VALID_INSTALL_MODES.join(', ')}` };
            }
            return { ok: true, value: value as AppConfig[K] };
        }
        case 'firstRunComplete':
        case 'autoUpdate':
        case 'serviceFirstRunSeen': {
            if (typeof value !== 'boolean') {
                return { ok: false, error: `${key} must be a boolean` };
            }
            return { ok: true, value: value as AppConfig[K] };
        }
        case 'githubOwner': {
            if (typeof value !== 'string' || value.length === 0) {
                return { ok: false, error: 'githubOwner must be a non-empty string' };
            }
            return { ok: true, value: value as AppConfig[K] };
        }
        default:
            return { ok: true, value: value as AppConfig[K] };
    }
}

/**
 * Reduce a (possibly malformed) FlatConfig into a sanitized AppConfig.
 * Validation failures on specific fields fall back to defaults with a warning;
 * this matches Contract 1's "do not throw on load" semantics.
 */
function sanitizeAppConfig(raw: FlatConfig, warn: (msg: string) => void): AppConfig {
    const out: AppConfig = { ...APP_CONFIG_DEFAULTS };

    // Migrate legacy `port` → `webPort` (in memory only; do not rewrite file).
    const candidateWebPort = raw.webPort ?? raw.port;
    if (candidateWebPort !== undefined) {
        const r = validateField('webPort', candidateWebPort);
        if (r.ok) out.webPort = r.value;
        else warn(`config.json: ${r.error}; using default ${APP_CONFIG_DEFAULTS.webPort}`);
    }

    if (raw.installMode !== undefined) {
        const r = validateField('installMode', raw.installMode);
        if (r.ok) out.installMode = r.value;
        else warn(`config.json: ${r.error}; using default null`);
    }
    if (raw.firstRunComplete !== undefined) {
        const r = validateField('firstRunComplete', raw.firstRunComplete);
        if (r.ok) out.firstRunComplete = r.value;
        else warn(`config.json: ${r.error}; using default false`);
    }
    if ((raw as { serviceFirstRunSeen?: unknown }).serviceFirstRunSeen !== undefined) {
        const r = validateField(
            'serviceFirstRunSeen',
            (raw as { serviceFirstRunSeen?: unknown }).serviceFirstRunSeen,
        );
        if (r.ok) out.serviceFirstRunSeen = r.value;
        else warn(`config.json: ${r.error}; using default false`);
    }
    if (raw.autoUpdate !== undefined) {
        const r = validateField('autoUpdate', raw.autoUpdate);
        if (r.ok) out.autoUpdate = r.value;
        else warn(`config.json: ${r.error}; using default true`);
    }
    if (raw.updateCheckIntervalMinutes !== undefined) {
        const r = validateField('updateCheckIntervalMinutes', raw.updateCheckIntervalMinutes);
        if (r.ok) out.updateCheckIntervalMinutes = r.value;
        else warn(`config.json: ${r.error}; using default 60`);
    }
    if (raw.channel !== undefined) {
        const r = validateField('channel', raw.channel);
        if (r.ok) out.channel = r.value;
        else warn(`config.json: ${r.error}; using default stable`);
    }
    if (raw.githubOwner !== undefined) {
        const r = validateField('githubOwner', raw.githubOwner);
        if (r.ok) out.githubOwner = r.value;
        else warn(`config.json: ${r.error}; using default ${APP_CONFIG_DEFAULTS.githubOwner}`);
    }

    // Pass-through scan / paths fields (not validated for SP3 — pre-existing tuning fields).
    if (raw.dependenciesPath !== undefined) out.dependenciesPath = raw.dependenciesPath;
    if (raw.adbPath !== undefined) out.adbPath = raw.adbPath;
    if (raw.scanConcurrency !== undefined) out.scanConcurrency = raw.scanConcurrency;
    if (raw.scanTcpTimeoutMs !== undefined) out.scanTcpTimeoutMs = raw.scanTcpTimeoutMs;
    if (raw.scanAdbConnectTimeoutMs !== undefined) out.scanAdbConnectTimeoutMs = raw.scanAdbConnectTimeoutMs;
    if (raw.scanProgressInterval !== undefined) out.scanProgressInterval = raw.scanProgressInterval;

    return out;
}

export class Config {
    private static instance?: Config | undefined;

    private _appConfig: AppConfig;
    private _configFilePath: string;
    private _firstRunStatus: FirstRunStatus;

    private static loadFile(configPath: string): FlatConfig {
        const isAbsolute = configPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(configPath);
        const absolutePath = isAbsolute ? configPath : path.resolve(process.cwd(), configPath);
        if (!fs.existsSync(absolutePath)) {
            throw Error(`Config file not found: "${absolutePath}"`);
        }
        const raw = fs.readFileSync(absolutePath, 'utf-8');
        return JSON.parse(raw) as FlatConfig;
    }

    private static tryLoadFile(configPath: string, warn: (msg: string) => void): FlatConfig {
        if (!fs.existsSync(configPath)) return {};
        try {
            const raw = fs.readFileSync(configPath, 'utf-8');
            return JSON.parse(raw) as FlatConfig;
        } catch (err) {
            warn(`config.json at ${configPath} could not be parsed (${(err as Error).message}); using defaults`);
            return {};
        }
    }

    private static buildServers(fileConfig: FlatConfig, webPort: number): ServerItem[] {
        // Env var PORT takes highest priority
        const envPort = process.env['PORT'];
        const port = envPort ? Number.parseInt(envPort, 10) : webPort;

        if (fileConfig.server && fileConfig.server.length > 0) {
            // Advanced multi-server config: still honour PORT env override on first server
            const servers = fileConfig.server.map((item) => Config.parseServerItem(item));
            if (envPort) {
                servers[0]!.port = port;
            }
            return servers;
        }

        // Simple flat config: single HTTP server
        return [{ secure: false, port }];
    }

    private static parseServerItem(config: Partial<ServerItem> = {}): ServerItem {
        const secure = config.secure || false;
        const port = config.port || (secure ? 443 : 80);
        const options = config.options;
        const redirectToSecure = config.redirectToSecure || false;
        if (secure && !options) {
            throw Error('Must provide "options" for secure server configuration');
        }
        if (options?.certPath) {
            if (options.cert) {
                throw Error(`Can't use "cert" and "certPath" together`);
            }
            options.cert = fs.readFileSync(options.certPath, 'utf-8');
        }
        if (options?.keyPath) {
            if (options.key) {
                throw Error(`Can't use "key" and "keyPath" together`);
            }
            options.key = fs.readFileSync(options.keyPath, 'utf-8');
        }
        const serverItem: ServerItem = { secure, port, redirectToSecure };
        if (typeof options !== 'undefined') {
            serverItem.options = options;
        }
        return serverItem;
    }

    public static getInstance(): Config {
        if (!this.instance) {
            const envConfigPath = process.env[EnvName.CONFIG_PATH];
            const warn = (msg: string) => console.warn(`[Config] ${msg}`);

            // Phase 1: writable state lives at <dataRoot> (ProgramData on
            // Windows). Compute it once here and thread it through both the
            // config-path and dependencies-path resolvers below.
            const dataRoot = resolveDataRoot(process.env);

            // Resolve the config file path. EnvName.CONFIG_PATH override wins;
            // otherwise prefer <dataRoot>/config.json on Windows, falling back
            // to the dev-mode entry-script-relative resolution on non-Windows.
            const configFilePath = envConfigPath
                ? path.isAbsolute(envConfigPath)
                    ? envConfigPath
                    : path.resolve(process.cwd(), envConfigPath)
                : resolveConfigPath(process.argv[1] ?? '.', fs.existsSync, dataRoot);

            // Load file if it exists; otherwise empty defaults. We do NOT throw
            // when the file is absent (Contract 1: defaults applied on read).
            let fileConfig: FlatConfig;
            if (envConfigPath) {
                // Explicit override: existing behavior was to throw if missing —
                // preserve that for callers that depend on it.
                fileConfig = Config.loadFile(envConfigPath);
            } else {
                fileConfig = Config.tryLoadFile(configFilePath, warn);
            }

            const appConfig = sanitizeAppConfig(fileConfig, warn);
            const servers = Config.buildServers(fileConfig, appConfig.webPort);

            const dependenciesPath = resolveDependenciesPath(
                process.env,
                fileConfig,
                process.argv[1] ?? '.',
            );

            // ADB resolution must come AFTER dependenciesPath. Always returns a path
            // inside <dependenciesPath>/adb/ unless config.json explicitly overrides.
            // No system-PATH fallback by design.
            const adbResolution = resolveAdbPath(fileConfig, dependenciesPath);
            const adbPath = adbResolution.path;
            console.info(`[Config] adbPath=${adbPath} (source=${adbResolution.source})`);

            const scanConcurrency = Number.parseInt(process.env['SCAN_CONCURRENCY'] ?? '', 10) || fileConfig.scanConcurrency || DEFAULT_SCAN_CONCURRENCY;
            const scanTcpTimeoutMs = Number.parseInt(process.env['SCAN_TCP_TIMEOUT_MS'] ?? '', 10) || fileConfig.scanTcpTimeoutMs || DEFAULT_SCAN_TCP_TIMEOUT_MS;
            const scanAdbConnectTimeoutMs = Number.parseInt(process.env['SCAN_ADB_CONNECT_TIMEOUT_MS'] ?? '', 10) || fileConfig.scanAdbConnectTimeoutMs || DEFAULT_SCAN_ADB_CONNECT_TIMEOUT_MS;
            const scanProgressInterval = Number.parseInt(process.env['SCAN_PROGRESS_INTERVAL'] ?? '', 10) || fileConfig.scanProgressInterval || DEFAULT_SCAN_PROGRESS_INTERVAL;

            this.instance = new Config(
                servers,
                adbPath,
                dependenciesPath,
                scanConcurrency,
                scanTcpTimeoutMs,
                scanAdbConnectTimeoutMs,
                scanProgressInterval,
                appConfig,
                configFilePath,
                dataRoot,
            );
        }
        return this.instance;
    }

    /** Test-only: clear the cached singleton. */
    public static _resetForTest(): void {
        this.instance = undefined;
    }

    constructor(
        private readonly _servers: ServerItem[],
        private readonly _adbPath: string,
        private readonly _dependenciesPath: string,
        private readonly _scanConcurrency: number,
        private readonly _scanTcpTimeoutMs: number,
        private readonly _scanAdbConnectTimeoutMs: number,
        private readonly _scanProgressInterval: number,
        appConfig: AppConfig,
        configFilePath: string,
        private readonly _dataRoot: string | null = null,
    ) {
        this._appConfig = appConfig;
        this._configFilePath = configFilePath;
        this._firstRunStatus = {
            firstRunComplete: appConfig.firstRunComplete,
            portWasAutoShifted: false,
            webPort: appConfig.webPort,
        };
    }

    public get servers(): ServerItem[] {
        return this._servers;
    }

    public get adbPath(): string {
        return this._adbPath;
    }

    public get dependenciesPath(): string {
        return this._dependenciesPath;
    }

    /**
     * Writable-state root computed by `resolveDataRoot`. On Windows this is
     * `<PROGRAMDATA>\WsScrcpyWeb` (Phase 1 migration target). On non-Windows
     * this is `null` until the Linux Phase-1-equivalent design lands
     * (`todo_ws_scrcpy_web.md` §19).
     */
    public get dataRoot(): string | null {
        return this._dataRoot;
    }

    /**
     * Canonical path for the `.restart` marker file the supervisor (launcher
     * in install, scripts/dev-supervisor.mjs in dev) reads to decide whether
     * to restart Node after exit. Matches `launcher/src/paths.rs:70` —
     * `<dataRoot>/.restart` on Windows. On non-Windows (and any host with a
     * null dataRoot) we fall back to `<parent-of-depsPath>/.restart`, which
     * matches the launcher's `paths.rs:62` "collapse data_root onto
     * install_root" rule (deps live at install_root/dependencies, so the
     * marker sits next to that directory).
     *
     * Pre-Phase-1 the server wrote to `<depsPath>/.restart` while the
     * launcher read from `<install_root>/.restart` — the marker mechanism
     * was silently dead code because the two paths never matched. The
     * getter is the single source of truth for that path now; both
     * `DependencyManager.requestRestart` and `ConfigApi`'s port-change
     * handler consume it via `Config.getInstance().restartMarkerPath`.
     */
    public get restartMarkerPath(): string {
        if (this._dataRoot !== null) {
            return path.join(this._dataRoot, '.restart');
        }
        return path.join(path.dirname(this._dependenciesPath), '.restart');
    }

    /**
     * Canonical path for the `apply-update-pending` marker. UpdateService.applyUpdate
     * writes this file before triggering process.exit; the launcher's post-stop
     * handler (registered as Servy's --postStopPath) reads it after every supervised
     * launcher exit to decide whether the exit was a user-initiated stop (marker
     * absent → no-op) or a Velopack apply (marker present → sleep + sc start).
     *
     * Matches `launcher/src/post_stop_handler.rs::marker_path` —
     * `<dataRoot>/control/apply-update-pending`. Lives under the `control/` subdir
     * alongside the existing uninstall-handoff marker (see `common/src/control_marker.rs`).
     */
    public get applyUpdatePendingMarkerPath(): string {
        const base = this._dataRoot !== null
            ? this._dataRoot
            : path.dirname(this._dependenciesPath);
        return path.join(base, 'control', 'apply-update-pending');
    }

    public get operationServerPortFilePath(): string {
        const base = this._dataRoot !== null
            ? this._dataRoot
            : path.dirname(this._dependenciesPath);
        return path.join(base, 'control', 'operation-server-port');
    }

    public get uninstallPendingMarkerPath(): string {
        const base = this._dataRoot !== null
            ? this._dataRoot
            : path.dirname(this._dependenciesPath);
        return path.join(base, 'control', 'uninstall-pending');
    }

    public get scanConcurrency(): number { return this._scanConcurrency; }
    public get scanTcpTimeoutMs(): number { return this._scanTcpTimeoutMs; }
    public get scanAdbConnectTimeoutMs(): number { return this._scanAdbConnectTimeoutMs; }
    public get scanProgressInterval(): number { return this._scanProgressInterval; }

    /** Always true in the simplified config — local goog tracker always runs. */
    public get runLocalGoogTracker(): boolean {
        return true;
    }

    /** Always true in the simplified config — local tracker is always announced. */
    public get announceLocalGoogTracker(): boolean {
        return true;
    }

    /** No remote host list in the simplified config. */
    public getHostList(): [] {
        return [];
    }

    /** Returns the resolved AppConfig (with defaults filled in). */
    public getAppConfig(): AppConfig {
        return { ...this._appConfig };
    }

    /** Path on disk where config.json lives (or will live on first save). */
    public getConfigFilePath(): string {
        return this._configFilePath;
    }

    /**
     * Apply a partial AppConfig. Validates each provided field; on failure throws
     * a ConfigValidationError that ConfigApi turns into a 400 response. On success,
     * writes config.json synchronously and returns the merged config.
     */
    public updateAppConfig(partial: Partial<AppConfig>): { config: AppConfig; restartRequired: boolean } {
        const merged: AppConfig = { ...this._appConfig };
        for (const key of Object.keys(partial) as (keyof AppConfig)[]) {
            const value = partial[key];
            if (value === undefined) continue;
            const r = validateField(key, value);
            if (!r.ok) {
                throw new ConfigValidationError(r.error, key as string);
            }
            // biome-ignore lint/suspicious/noExplicitAny: index assignment with verified-typed value
            (merged as any)[key] = r.value;
        }
        const restartRequired = merged.webPort !== this._appConfig.webPort;
        this._appConfig = merged;
        this._firstRunStatus = {
            ...this._firstRunStatus,
            firstRunComplete: merged.firstRunComplete,
        };
        this.saveToDisk();
        return { config: { ...merged }, restartRequired };
    }

    /**
     * Persist the current AppConfig to disk. Sync writes; pretty-printed JSON
     * with 2-space indent and trailing newline (Contract 1).
     */
    public saveToDisk(): void {
        const out = JSON.stringify(this._appConfig, null, 2) + '\n';
        const dir = path.dirname(this._configFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this._configFilePath, out, 'utf-8');
    }

    public getFirstRunStatus(): FirstRunStatus {
        return { ...this._firstRunStatus };
    }

    /**
     * Called by server startup once the actual bound port is known. If the
     * resolver had to shift away from `webPort`, this flips the flag and
     * persists the new port to disk.
     */
    public setActualWebPort(actualPort: number): void {
        const shifted = actualPort !== this._appConfig.webPort;
        if (shifted) {
            this._appConfig = { ...this._appConfig, webPort: actualPort };
            this.saveToDisk();
        }
        this._firstRunStatus = {
            firstRunComplete: this._appConfig.firstRunComplete,
            portWasAutoShifted: shifted,
            webPort: actualPort,
        };
    }
}

export class ConfigValidationError extends Error {
    constructor(message: string, public readonly field: string) {
        super(message);
        this.name = 'ConfigValidationError';
    }
}
