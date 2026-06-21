import type { DatabaseSync } from 'node:sqlite';
import * as path from 'path';
import { openDatabase } from './openDatabase';
import { importLegacyIfNeeded } from './import/importLegacy';
import { UserStore } from './UserStore';
import { UserSettingsStore } from './UserSettingsStore';
import { AppSettingsStore } from './AppSettingsStore';
import { DeviceStore } from './DeviceStore';
import { DB_FILENAME } from './constants';

export class Db {
    private static instance?: Db | undefined;

    public readonly users: UserStore;
    public readonly userSettings: UserSettingsStore;
    public readonly appSettings: AppSettingsStore;
    public readonly devices: DeviceStore;

    private constructor(
        private readonly handle: DatabaseSync,
        public readonly dbPath: string,
    ) {
        this.users = new UserStore(handle);
        this.userSettings = new UserSettingsStore(handle);
        this.appSettings = new AppSettingsStore(handle);
        this.devices = new DeviceStore(handle);
    }

    /**
     * Open (or recover) <dataRoot>/wsscrcpy.db and run the one-time legacy import.
     * `opts` lets callers point the import at the ACTUAL legacy file locations:
     * `configPath` defaults to <dataRoot>/config.json and `deviceLabelsPath` to
     * <dataRoot>/device-labels.json, but the real device-labels.json is
     * bundle-relative (DeviceLabelStore), so Config passes its true path. The
     * defaults keep the unit test hermetic.
     */
    static getInstance(dataRoot: string, opts?: { configPath?: string; deviceLabelsPath?: string }): Db {
        if (!this.instance) {
            const dbPath = path.join(dataRoot, DB_FILENAME);
            const handle = openDatabase(dbPath);
            importLegacyIfNeeded(handle, {
                configPath: opts?.configPath ?? path.join(dataRoot, 'config.json'),
                deviceLabelsPath: opts?.deviceLabelsPath ?? path.join(dataRoot, 'device-labels.json'),
            });
            this.instance = new Db(handle, dbPath);
        }
        return this.instance;
    }

    static _resetForTest(): void {
        this.instance?.handle.close();
        this.instance = undefined;
    }

    get sqlite(): DatabaseSync {
        return this.handle;
    }

    backup(toPath: string): void {
        // VACUUM INTO writes a clean snapshot; the path must not already exist.
        this.handle.exec(`VACUUM INTO '${toPath.replace(/'/g, "''")}'`);
    }
}

/**
 * THE one resolver for the Db directory. Every `Db.getInstance(...)` call across
 * all phases MUST pass `dbDir(Config.getInstance())` — never an ad-hoc
 * `dataRoot ?? dependenciesPath`. Mirrors `resolveDataRoot` precedence; on a null
 * dataRoot (non-Windows dev) it falls back to the parent of the dependencies path
 * (matching `Config.restartMarkerPath`'s fallback), so the DB sits beside the
 * other writable state. Typed structurally (not against `Config`) to keep the db
 * layer decoupled from the server config module.
 */
export function dbDir(config: { dataRoot: string | null; dependenciesPath: string }): string {
    return config.dataRoot ?? path.dirname(config.dependenciesPath);
}
