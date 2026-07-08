import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../openDatabase';

const dirs: string[] = [];
function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsdb-'));
    dirs.push(d);
    return path.join(d, 'wsscrcpy.db');
}
afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('openDatabase', () => {
    it('creates the file, enables WAL + foreign_keys, migrates to v1', () => {
        const p = tmp();
        const db = openDatabase(p);
        expect(fs.existsSync(p)).toBe(true);
        expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
        expect((db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys).toBe(1);
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
        db.close();
    });

    it('creates missing parent directories for the db path (fresh data root)', () => {
        // Mirrors a first run on a host where <dataRoot> was never created (new
        // install, fresh checkout, CI). node:sqlite will not mkdir on its own, so
        // opening here previously failed with SQLITE_CANTOPEN (errcode 14).
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wsdb-'));
        dirs.push(base);
        const nested = path.join(base, 'does', 'not', 'exist', 'yet', 'wsscrcpy.db');
        const db = openDatabase(nested);
        expect(fs.existsSync(nested)).toBe(true);
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
        db.close();
    });

    it('surfaces a clear error (not a raw ERR_SQLITE_ERROR) when the directory is uncreatable', () => {
        // A regular file sits where the db directory should be, so the directory
        // can't be created and the path is unopenable. The recovery path must not
        // re-throw a cryptic node:sqlite error and crash the supervisor.
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wsdb-'));
        dirs.push(base);
        const fileNotDir = path.join(base, 'not-a-dir');
        fs.writeFileSync(fileNotDir, 'x');
        const bad = path.join(fileNotDir, 'wsscrcpy.db');
        expect(() => openDatabase(bad)).toThrow(/unable to create database directory/i);
    });
});
