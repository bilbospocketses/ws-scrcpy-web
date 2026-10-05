import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Db } from '../Db';
import { backupAndCloseStore } from '../shutdownStore';

// Finding 10.21. The graceful stop took the `.bak` and never closed the store,
// so after every stop `wsscrcpy.db` was a 4 KB header beside a ~119 KB `-wal`:
// the data lived in the sidecar. Junk written over the main file alone (smoke
// row 10.17's procedure) was then masked by the WAL and recovery never ran.
// Closing the last connection makes SQLite checkpoint the WAL into the main
// file and delete it.

const dirs: string[] = [];
function dataRoot(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsstop-'));
    dirs.push(d);
    return d;
}
afterEach(() => {
    vi.restoreAllMocks();
    Db._resetForTest();
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function walSize(dbPath: string): number {
    const wal = `${dbPath}-wal`;
    return fs.existsSync(wal) ? fs.statSync(wal).size : 0;
}

const quietLog = { warn: vi.fn() };

describe('backupAndCloseStore (the graceful stop)', () => {
    it('takes the .bak, closes the store, and leaves no -wal with content', () => {
        const db = Db.getInstance(dataRoot());
        db.users.create({ username: 'kept', role: 'user', passwordHash: null });
        // Non-vacuous: the write really is sitting in the WAL before the stop.
        expect(walSize(db.dbPath)).toBeGreaterThan(0);

        backupAndCloseStore(db, quietLog);

        expect(fs.existsSync(`${db.dbPath}.bak`)).toBe(true);
        expect(db.sqlite.isOpen).toBe(false);
        expect(walSize(db.dbPath)).toBe(0);
        expect(quietLog.warn).not.toHaveBeenCalled();

        // The data is in the MAIN file now: a copy of wsscrcpy.db alone, with
        // no sidecar beside it, still has the user.
        const lone = path.join(path.dirname(db.dbPath), 'lone-copy.db');
        fs.copyFileSync(db.dbPath, lone);
        const probe = new DatabaseSync(lone);
        try {
            const row = probe.prepare('SELECT username FROM users WHERE username = ?').get('kept');
            expect(row).toEqual({ username: 'kept' });
        } finally {
            probe.close();
        }
    });

    it('still closes the store when the backup fails, and says so', () => {
        const db = Db.getInstance(dataRoot());
        vi.spyOn(db, 'backup').mockImplementation(() => {
            throw new Error('disk full');
        });
        const log = { warn: vi.fn() };

        backupAndCloseStore(db, log);

        expect(db.sqlite.isOpen).toBe(false);
        expect(walSize(db.dbPath)).toBe(0);
        expect(log.warn).toHaveBeenCalledWith('db backup on shutdown failed: disk full');
    });

    it('is safe to run twice (the shutdown paths share one teardown)', () => {
        const db = Db.getInstance(dataRoot());
        backupAndCloseStore(db, quietLog);
        expect(() => backupAndCloseStore(db, quietLog)).not.toThrow();
        expect(db.sqlite.isOpen).toBe(false);
    });
});

describe('Db.close', () => {
    it('is idempotent', () => {
        const db = Db.getInstance(dataRoot());
        db.close();
        expect(() => db.close()).not.toThrow();
        expect(db.sqlite.isOpen).toBe(false);
    });
});
