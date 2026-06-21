import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
});
