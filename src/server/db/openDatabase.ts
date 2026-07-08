import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../Logger';
import { runMigrations } from './migrations';

function configure(db: DatabaseSync): void {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
}

function integrityOk(db: DatabaseSync): boolean {
    try {
        const r = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
        return r.integrity_check === 'ok';
    } catch {
        return false;
    }
}

export function openDatabase(dbPath: string): DatabaseSync {
    // node:sqlite (like all SQLite) does NOT create missing parent directories:
    // opening <dataRoot>/wsscrcpy.db before <dataRoot> exists fails with
    // SQLITE_CANTOPEN (errcode 14). Create the directory first so a fresh data
    // root (new install, fresh dev checkout, CI) can open the store on boot.
    ensureParentDir(dbPath);

    // A failure to OPEN the file at all (permissions, a read-only or otherwise
    // unwritable location) is an environment problem, not a corrupt database. The
    // recovery path below (move-aside → restore-backup → recreate) is for bad
    // *content* and can't help here — it would just re-open the same unopenable
    // path and re-throw a cryptic ERR_SQLITE_ERROR that crashes the supervisor.
    // Split it out and surface a clear, actionable message instead.
    let db: DatabaseSync;
    try {
        db = new DatabaseSync(dbPath);
    } catch (err) {
        throw new Error(`unable to open database at ${dbPath}: ${(err as Error).message}`, { cause: err });
    }

    try {
        configure(db);
        if (!integrityOk(db)) throw new Error('integrity_check failed');
        runMigrations(db);
        return db;
    } catch (err) {
        // The file opened but its *content* is corrupt or unreadable. Recovery order:
        // (1) move the corrupt file + its WAL sidecars aside; (2) restore the last-good
        // `.bak` (VACUUM-INTO snapshot from graceful shutdown) if it opens clean — this
        // preserves settings the migration moved OUT of the (now-trimmed) config.json,
        // which a fresh+re-import would lose; (3) only if no valid backup, create a
        // fresh schema (settings reset to defaults — the caller's legacy files were
        // already trimmed). The re-opens below are safe: the successful open above
        // proved the directory is writable.
        Logger.for('Db').error(`wsscrcpy.db unusable (${(err as Error).message}); attempting recovery`);
        try {
            db.close();
        } catch {
            /* best effort */
        }
        moveAsideCorrupt(dbPath); // renames dbPath, dbPath-wal, dbPath-shm to *.corrupt-<ts>

        const bak = `${dbPath}.bak`;
        if (fs.existsSync(bak)) {
            try {
                const probe = new DatabaseSync(bak);
                const ok =
                    (probe.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check ===
                    'ok';
                probe.close();
                if (ok) {
                    fs.copyFileSync(bak, dbPath);
                    Logger.for('Db').error('restored wsscrcpy.db from wsscrcpy.db.bak');
                }
            } catch {
                /* fall through to fresh */
            }
        }
        const fresh = new DatabaseSync(dbPath);
        configure(fresh);
        if (!integrityOk(fresh)) {
            // backup copy somehow bad → start clean
            fresh.close();
            moveAsideCorrupt(dbPath);
            const blank = new DatabaseSync(dbPath);
            configure(blank);
            runMigrations(blank);
            return blank;
        }
        runMigrations(fresh); // a restored backup may be an older schema version → migrate it forward
        return fresh;
    }
}

function ensureParentDir(dbPath: string): void {
    const dir = path.dirname(dbPath);
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
        throw new Error(`unable to create database directory ${dir}: ${(err as Error).message}`, { cause: err });
    }
}

function moveAsideCorrupt(dbPath: string): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const suffix of ['', '-wal', '-shm']) {
        const p = `${dbPath}${suffix}`;
        if (fs.existsSync(p)) {
            try {
                fs.renameSync(p, `${p}.corrupt-${stamp}`);
            } catch {
                try {
                    fs.rmSync(p, { force: true });
                } catch {
                    /* best effort */
                }
            }
        }
    }
}
