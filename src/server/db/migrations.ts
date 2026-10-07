import type { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../Logger';
import { renameSyncWithRetry } from '../util/atomicFile';
import { migration001 } from './migrations/001_initial';
import { migration002 } from './migrations/002_pending_settings';
import { migration003 } from './migrations/003_device_mac';

export interface Migration {
    version: number;
    up(db: DatabaseSync): void;
}

export const MIGRATIONS: Migration[] = [migration001, migration002, migration003];

/**
 * The stored schema is newer than this build knows. That is a downgrade, not
 * corruption: openDatabase rethrows it instead of recovering, because its
 * recovery would move the user's intact database aside and restore or create
 * an older one in its place.
 */
export class DatabaseNewerThanBuildError extends Error {
    constructor(
        public readonly storedVersion: number,
        public readonly supportedVersion: number,
        backupName: string | undefined,
    ) {
        super(
            `wsscrcpy.db was written by a newer version of ws-scrcpy-web (schema v${storedVersion}; ` +
                `this build supports v${supportedVersion}). Install that version again` +
                (backupName ? `, or restore the pre-upgrade backup ${backupName} in place of wsscrcpy.db.` : '.'),
        );
        this.name = 'DatabaseNewerThanBuildError';
    }
}

/**
 * An upgrade that did not happen: the pre-upgrade snapshot could not be
 * written, or a migration threw and was rolled back. Either way the database
 * is intact at an older schema version, so this is not corruption either.
 */
export class DatabaseUpgradeError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = 'DatabaseUpgradeError';
    }
}

function userVersion(db: DatabaseSync): number {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

/** `wsscrcpy.db.v<N>.bak`: the database as it was before an upgrade from schema vN. */
function snapshotName(dbFile: string, version: number): string {
    return `${path.basename(dbFile)}.v${version}.bak`;
}

/**
 * VACUUM INTO a same-directory temp file, then rename it into place, so the
 * snapshot is either the whole pre-upgrade database or absent, never half of
 * one. VACUUM INTO refuses a target that exists, hence the clear first.
 */
function writeSnapshot(db: DatabaseSync, dest: string): void {
    const tmp = path.join(path.dirname(dest), `.${path.basename(dest)}.tmp-${process.pid}`);
    try {
        fs.rmSync(tmp, { force: true });
        db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
        renameSyncWithRetry(tmp, dest, fs.renameSync);
    } catch (err) {
        try {
            fs.rmSync(tmp, { force: true });
        } catch {
            /* best effort: the original failure is what the caller needs to see */
        }
        throw err;
    }
}

/** Keep only the from-version: remove every other `wsscrcpy.db.v<N>.bak` beside the database. */
function removeOtherSnapshots(dbFile: string, keep: string): void {
    const dir = path.dirname(dbFile);
    const prefix = `${path.basename(dbFile)}.v`;
    for (const name of fs.readdirSync(dir)) {
        if (name === keep || !name.startsWith(prefix) || !/^\d+\.bak$/.test(name.slice(prefix.length))) continue;
        try {
            fs.rmSync(path.join(dir, name), { force: true });
        } catch (err) {
            Logger.for('Db').warn(`could not remove old pre-upgrade backup ${name}: ${(err as Error).message}`);
        }
    }
}

/**
 * Before the first migration of an upgrade, snapshot the database to
 * `wsscrcpy.db.v<from>.bak` so the build being upgraded from has a database it
 * can open again. Skipped for a brand-new database (user_version 0 and no
 * schema objects: nothing to protect) and for an in-memory one (no file).
 */
function snapshotBeforeUpgrade(db: DatabaseSync, from: number, to: number): void {
    const dbFile = db.location();
    if (!dbFile) return;
    if (from === 0) {
        const objects = (db.prepare('SELECT count(*) AS n FROM sqlite_schema').get() as { n: number }).n;
        if (objects === 0) return;
    }
    const name = snapshotName(dbFile, from);
    try {
        writeSnapshot(db, path.join(path.dirname(dbFile), name));
    } catch (err) {
        throw new DatabaseUpgradeError(
            `wsscrcpy.db upgrade from schema v${from} to v${to} stopped: the pre-upgrade backup ${name} ` +
                `could not be written (${(err as Error).message}). The database was not changed.`,
            { cause: err },
        );
    }
    removeOtherSnapshots(dbFile, name);
    Logger.for('Db').info(`saved pre-upgrade backup ${name} before migrating schema v${from} to v${to}`);
}

export function runMigrations(db: DatabaseSync): void {
    const current = userVersion(db);
    const target = MIGRATIONS.length;
    if (current > target) {
        const dbFile = db.location();
        const backup = dbFile ? snapshotName(dbFile, target) : undefined;
        const present = backup && dbFile && fs.existsSync(path.join(path.dirname(dbFile), backup));
        throw new DatabaseNewerThanBuildError(current, target, present ? backup : undefined);
    }
    if (current === target) return;
    snapshotBeforeUpgrade(db, current, target);
    for (const m of MIGRATIONS) {
        if (m.version <= current) continue;
        db.exec('BEGIN');
        try {
            m.up(db);
            db.exec(`PRAGMA user_version = ${m.version}`); // m.version is a trusted integer literal
            db.exec('COMMIT');
        } catch (err) {
            db.exec('ROLLBACK');
            throw new DatabaseUpgradeError(
                `wsscrcpy.db upgrade from schema v${current} to v${target} failed at migration ${m.version} ` +
                    `(${(err as Error).message}); the database was left at schema v${userVersion(db)}.`,
                { cause: err },
            );
        }
    }
}
