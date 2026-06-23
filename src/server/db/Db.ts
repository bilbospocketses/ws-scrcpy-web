import type { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { AppSettingsStore } from './AppSettingsStore';
import { DB_FILENAME } from './constants';
import { DeviceStore } from './DeviceStore';
import { openDatabase } from './openDatabase';
import { UserSettingsStore } from './UserSettingsStore';
import { UserStore } from './UserStore';

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

    /** Open (or recover) <dataRoot>/wsscrcpy.db and expose the repos. */
    static getInstance(dataRoot: string): Db {
        if (!this.instance) {
            const dbPath = path.join(dataRoot, DB_FILENAME);
            const handle = openDatabase(dbPath);
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
        // VACUUM INTO writes a clean snapshot but fails if the target exists, so
        // clear any prior snapshot first.
        try {
            fs.rmSync(toPath, { force: true });
        } catch {
            /* best effort */
        }
        this.handle.exec(`VACUUM INTO '${toPath.replace(/'/g, "''")}'`);
    }
}

/**
 * THE one resolver for the Db directory: the directory that holds config.json, so
 * the DB is always a sibling of config.json — one file, no split-brain, and it
 * follows a CONFIG_PATH override (tests + custom deployments) automatically. In
 * production that directory IS <dataRoot> (config.json lives at
 * <dataRoot>/config.json); on a null-dataRoot dev host it is the repo root
 * (matching the pre-existing config.json location). Pass
 * `Config.getInstance().getConfigFilePath()`.
 */
export function dbDir(configFilePath: string): string {
    return path.dirname(configFilePath);
}
