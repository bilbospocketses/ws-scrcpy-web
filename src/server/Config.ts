import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import type { ServerItem } from '../types/Configuration';
import { EnvName } from './EnvName';

const DEFAULT_PORT = 8000;
const DEFAULT_ADB_PATH = 'adb';
const DEFAULT_SCAN_CONCURRENCY = 64;
const DEFAULT_SCAN_TCP_TIMEOUT_MS = 300;
const DEFAULT_SCAN_ADB_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_SCAN_PROGRESS_INTERVAL = 10;

/**
 * Minimal flat config supported by config.json:
 *   { "port": 8000, "adbPath": "adb" }
 *
 * The full ServerItem array form is also accepted for advanced SSL setups:
 *   { "server": [{ "secure": true, "port": 443, "options": { ... } }] }
 */
export interface FlatConfig {
    port?: number;
    adbPath?: string;
    dependenciesPath?: string;
    scanConcurrency?: number;
    scanTcpTimeoutMs?: number;
    scanAdbConnectTimeoutMs?: number;
    scanProgressInterval?: number;
    server?: ServerItem[];
}

/**
 * Pure resolver: produces the absolute dependencies-folder path the app should
 * manage. Priority: DEPS_PATH env → config.json → dev fallback → hard-fail.
 * Dev fallback only triggers when a package.json is a sibling of the entry
 * script's parent directory (the unambiguous "we are in a dev checkout" tell).
 */
export function resolveDependenciesPath(
    env: NodeJS.ProcessEnv,
    fileConfig: FlatConfig,
    entryScript: string,
    exists: (p: string) => boolean = fs.existsSync,
): string {
    if (env['DEPS_PATH']) return env['DEPS_PATH'];
    if (fileConfig.dependenciesPath) return fileConfig.dependenciesPath;
    const entryDir = path.dirname(entryScript);
    const devCandidate = path.resolve(entryDir, '..', 'dependencies');
    const devTell = path.resolve(entryDir, '..', 'package.json');
    if (exists(devTell)) return devCandidate;
    throw new Error(
        'DEPS_PATH is not set and no dependencies path is configured. ' +
        'Set the DEPS_PATH environment variable (the launcher script does this automatically) ' +
        'or add "dependenciesPath" to config.json. ' +
        'Expected location example: <installFolder>/dependencies/',
    );
}

export class Config {
    private static instance?: Config;

    private static loadFile(configPath: string): FlatConfig {
        const isAbsolute = configPath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(configPath);
        const absolutePath = isAbsolute ? configPath : path.resolve(process.cwd(), configPath);
        if (!fs.existsSync(absolutePath)) {
            throw Error(`Config file not found: "${absolutePath}"`);
        }
        const raw = fs.readFileSync(absolutePath, 'utf-8');
        return JSON.parse(raw) as FlatConfig;
    }

    private static buildServers(fileConfig: FlatConfig): ServerItem[] {
        // Env var PORT takes highest priority
        const envPort = process.env['PORT'];
        const port = envPort ? Number.parseInt(envPort, 10) : (fileConfig.port ?? DEFAULT_PORT);

        if (fileConfig.server && fileConfig.server.length > 0) {
            // Advanced multi-server config: still honour PORT env override on first server
            const servers = fileConfig.server.map((item) => Config.parseServerItem(item));
            if (envPort) {
                servers[0].port = port;
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
            const configPath = process.env[EnvName.CONFIG_PATH];
            const fileConfig: FlatConfig = configPath ? Config.loadFile(configPath) : {};
            const servers = Config.buildServers(fileConfig);

            // ADB_PATH env var overrides file config, which overrides default
            const adbPath = process.env['ADB_PATH'] ?? fileConfig.adbPath ?? DEFAULT_ADB_PATH;

            const dependenciesPath = resolveDependenciesPath(
                process.env,
                fileConfig,
                process.argv[1] ?? '.',
            );

            const scanConcurrency = Number.parseInt(process.env['SCAN_CONCURRENCY'] ?? '', 10) || fileConfig.scanConcurrency || DEFAULT_SCAN_CONCURRENCY;
            const scanTcpTimeoutMs = Number.parseInt(process.env['SCAN_TCP_TIMEOUT_MS'] ?? '', 10) || fileConfig.scanTcpTimeoutMs || DEFAULT_SCAN_TCP_TIMEOUT_MS;
            const scanAdbConnectTimeoutMs = Number.parseInt(process.env['SCAN_ADB_CONNECT_TIMEOUT_MS'] ?? '', 10) || fileConfig.scanAdbConnectTimeoutMs || DEFAULT_SCAN_ADB_CONNECT_TIMEOUT_MS;
            const scanProgressInterval = Number.parseInt(process.env['SCAN_PROGRESS_INTERVAL'] ?? '', 10) || fileConfig.scanProgressInterval || DEFAULT_SCAN_PROGRESS_INTERVAL;

            this.instance = new Config(servers, adbPath, dependenciesPath, scanConcurrency, scanTcpTimeoutMs, scanAdbConnectTimeoutMs, scanProgressInterval);
        }
        return this.instance;
    }

    constructor(
        private readonly _servers: ServerItem[],
        private readonly _adbPath: string,
        private readonly _dependenciesPath: string,
        private readonly _scanConcurrency: number,
        private readonly _scanTcpTimeoutMs: number,
        private readonly _scanAdbConnectTimeoutMs: number,
        private readonly _scanProgressInterval: number,
    ) {}

    public get servers(): ServerItem[] {
        return this._servers;
    }

    public get adbPath(): string {
        return this._adbPath;
    }

    public get dependenciesPath(): string {
        return this._dependenciesPath;
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
}
