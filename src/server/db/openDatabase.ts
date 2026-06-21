import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import { runMigrations } from './migrations';
import { Logger } from '../Logger';

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
    let db: DatabaseSync;
    try {
        db = new DatabaseSync(dbPath);
        configure(db);
        if (!integrityOk(db)) throw new Error('integrity_check failed');
        runMigrations(db);
        return db;
    } catch (err) {
        // Corrupt or unreadable. Recovery order: (1) move the corrupt file + its WAL sidecars
        // aside; (2) restore the last-good `.bak` (VACUUM-INTO snapshot from graceful shutdown)
        // if it opens clean — this preserves settings the migration moved OUT of the (now-trimmed)
        // config.json, which a fresh+re-import would lose; (3) only if no valid backup, create a
        // fresh schema (settings reset to defaults — the caller's legacy files were already trimmed).
        Logger.for('Db').error(`wsscrcpy.db unusable (${(err as Error).message}); attempting recovery`);
        try {
            db!.close();
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
