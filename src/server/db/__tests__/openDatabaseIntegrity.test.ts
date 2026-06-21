import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { openDatabase } from '../openDatabase';

const dirs: string[] = [];
function tmp(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsint-'));
    dirs.push(d);
    return d;
}
afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('openDatabase integrity recovery', () => {
    it('moves a corrupt file aside and recreates a fresh schema', () => {
        const dir = tmp();
        const p = path.join(dir, 'wsscrcpy.db');
        fs.writeFileSync(p, 'this is not a sqlite database header at all');
        const db = openDatabase(p);
        // Fresh DB is usable at v1 and the corrupt file was preserved with a .corrupt- suffix.
        expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(1);
        const moved = fs.readdirSync(dir).filter((f) => f.startsWith('wsscrcpy.db.corrupt-'));
        expect(moved.length).toBe(1);
        db.close();
    });
});
