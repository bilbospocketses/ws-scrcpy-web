import { DatabaseSync } from 'node:sqlite';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseNewerThanBuildError, DatabaseUpgradeError, MIGRATIONS, runMigrations } from '../migrations';
import { openDatabase } from '../openDatabase';

const dirs: string[] = [];
function tmpDir(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsupg-'));
    dirs.push(d);
    return d;
}
afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

function userVersion(db: DatabaseSync): number {
    return (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
}

function versionOf(file: string): number {
    const db = new DatabaseSync(file);
    try {
        return userVersion(db);
    } finally {
        db.close();
    }
}

/** A database as the v2 build left it, holding one setting to recognise it by. */
function makeV2(dbPath: string): void {
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    for (const m of MIGRATIONS.slice(0, 2)) {
        m.up(db);
        db.exec(`PRAGMA user_version = ${m.version}`);
    }
    db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('channel', '"beta"');
    db.close();
}

function corruptFiles(dir: string): string[] {
    return fs.readdirSync(dir).filter((f) => f.includes('.corrupt-'));
}

function snapshotFiles(dir: string): string[] {
    return fs.readdirSync(dir).filter((f) => /^wsscrcpy\.db\.v\d+\.bak$/.test(f));
}

describe('pre-upgrade snapshot', () => {
    it('upgrading v2 writes wsscrcpy.db.v2.bak holding the pre-upgrade database', () => {
        const dir = tmpDir();
        const p = path.join(dir, 'wsscrcpy.db');
        makeV2(p);

        const db = openDatabase(p);
        expect(userVersion(db)).toBe(MIGRATIONS.length);
        db.close();

        const snap = path.join(dir, 'wsscrcpy.db.v2.bak');
        expect(fs.existsSync(snap)).toBe(true);
        const s = new DatabaseSync(snap);
        expect(userVersion(s)).toBe(2);
        expect(s.prepare('SELECT value FROM app_settings WHERE key = ?').get('channel')).toEqual({ value: '"beta"' });
        // The v3 column is absent: this is the database BEFORE the migration.
        const cols = (s.prepare('PRAGMA table_info(devices)').all() as { name: string }[]).map((c) => c.name);
        expect(cols).not.toContain('mac');
        s.close();
        // No temp file is left behind by the atomic write.
        expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    });

    it('keeps only the from-version: a stale wsscrcpy.db.v1.bak is removed, wsscrcpy.db.bak is not', () => {
        const dir = tmpDir();
        const p = path.join(dir, 'wsscrcpy.db');
        makeV2(p);
        fs.writeFileSync(path.join(dir, 'wsscrcpy.db.v1.bak'), 'stale');
        fs.writeFileSync(path.join(dir, 'wsscrcpy.db.bak'), 'shutdown snapshot');

        openDatabase(p).close();

        expect(snapshotFiles(dir)).toEqual(['wsscrcpy.db.v2.bak']);
        expect(fs.readFileSync(path.join(dir, 'wsscrcpy.db.bak'), 'utf8')).toBe('shutdown snapshot');
    });

    it('a fresh database takes no snapshot', () => {
        const dir = tmpDir();
        openDatabase(path.join(dir, 'wsscrcpy.db')).close();
        expect(snapshotFiles(dir)).toEqual([]);
    });

    it('an up-to-date database takes no snapshot', () => {
        const dir = tmpDir();
        const p = path.join(dir, 'wsscrcpy.db');
        openDatabase(p).close();
        openDatabase(p).close();
        expect(snapshotFiles(dir)).toEqual([]);
    });

    it('a snapshot that cannot be written stops the upgrade and leaves the database at v2', () => {
        const dir = tmpDir();
        const p = path.join(dir, 'wsscrcpy.db');
        makeV2(p);
        fs.writeFileSync(path.join(dir, 'wsscrcpy.db.v1.bak'), 'stale');
        // A non-empty directory where the snapshot must go: the rename onto it fails.
        const blocker = path.join(dir, 'wsscrcpy.db.v2.bak');
        fs.mkdirSync(blocker);
        fs.writeFileSync(path.join(blocker, 'x'), 'x');

        expect(() => openDatabase(p)).toThrow(DatabaseUpgradeError);
        expect(() => openDatabase(p)).toThrow(/pre-upgrade backup wsscrcpy\.db\.v2\.bak could not be written/);

        expect(versionOf(p)).toBe(2);
        expect(corruptFiles(dir)).toEqual([]);
        // The older snapshot is the only one there is: it must survive a failed write.
        expect(fs.existsSync(path.join(dir, 'wsscrcpy.db.v1.bak'))).toBe(true);
        expect(fs.readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    });

    it('a failing migration leaves the database in place at its old version', () => {
        const dir = tmpDir();
        const p = path.join(dir, 'wsscrcpy.db');
        makeV2(p);
        // Migration 3 adds devices.mac; a column already there makes it throw.
        const pre = new DatabaseSync(p);
        pre.exec('ALTER TABLE devices ADD COLUMN mac TEXT');
        pre.close();

        expect(() => openDatabase(p)).toThrow(DatabaseUpgradeError);

        expect(versionOf(p)).toBe(2);
        expect(corruptFiles(dir)).toEqual([]);
        expect(fs.existsSync(path.join(dir, 'wsscrcpy.db.v2.bak'))).toBe(true);
    });
});

describe('a database newer than the build', () => {
    function makeNewer(dbPath: string): void {
        const db = new DatabaseSync(dbPath);
        for (const m of MIGRATIONS) m.up(db);
        db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
        db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)').run('channel', '"newer"');
        db.close();
    }

    it('is not treated as corruption: no move-aside, no .bak restore', () => {
        const dir = tmpDir();
        const p = path.join(dir, 'wsscrcpy.db');
        makeNewer(p);
        // A valid shutdown snapshot the recovery path would otherwise restore over it.
        const bak = path.join(dir, 'wsscrcpy.db.bak');
        const b = new DatabaseSync(bak);
        runMigrations(b);
        b.close();
        const bakBytes = fs.readFileSync(bak);

        expect(() => openDatabase(p)).toThrow(DatabaseNewerThanBuildError);

        expect(versionOf(p)).toBe(MIGRATIONS.length + 1);
        const db = new DatabaseSync(p);
        expect(db.prepare('SELECT value FROM app_settings WHERE key = ?').get('channel')).toEqual({ value: '"newer"' });
        db.close();
        expect(corruptFiles(dir)).toEqual([]);
        expect(fs.readFileSync(bak).equals(bakBytes)).toBe(true);
    });

    it('says how to recover, naming the pre-upgrade backup only when it exists', () => {
        const dir = tmpDir();
        const p = path.join(dir, 'wsscrcpy.db');
        makeNewer(p);
        const stored = MIGRATIONS.length + 1;
        const supported = MIGRATIONS.length;

        let message = '';
        try {
            openDatabase(p);
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).toContain(
            `wsscrcpy.db was written by a newer version of ws-scrcpy-web (schema v${stored}; this build supports v${supported}).`,
        );
        expect(message).toContain('Install that version again');
        expect(message).not.toContain('.bak');

        fs.writeFileSync(path.join(dir, `wsscrcpy.db.v${supported}.bak`), 'snapshot');
        expect(() => openDatabase(p)).toThrow(
            `restore the pre-upgrade backup wsscrcpy.db.v${supported}.bak in place of wsscrcpy.db`,
        );
    });
});
