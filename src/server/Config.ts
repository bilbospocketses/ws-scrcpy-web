import * as process from 'process';
import * as fs from 'fs';
import * as path from 'path';
import { ServerItem } from '../types/Configuration';
import { EnvName } from './EnvName';

const DEFAULT_PORT = 8000;
const DEFAULT_ADB_PATH = 'adb';

/**
 * Minimal flat config supported by config.json:
 *   { "port": 8000, "adbPath": "adb" }
 *
 * The full ServerItem array form is also accepted for advanced SSL setups:
 *   { "server": [{ "secure": true, "port": 443, "options": { ... } }] }
 */
interface FlatConfig {
    port?: number;
    adbPath?: string;
    server?: ServerItem[];
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
        const port = envPort ? parseInt(envPort, 10) : (fileConfig.port ?? DEFAULT_PORT);

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

            this.instance = new Config(servers, adbPath);
        }
        return this.instance;
    }

    constructor(
        private readonly _servers: ServerItem[],
        private readonly _adbPath: string,
    ) {}

    public get servers(): ServerItem[] {
        return this._servers;
    }

    public get adbPath(): string {
        return this._adbPath;
    }

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
