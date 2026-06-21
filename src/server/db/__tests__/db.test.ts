import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db, dbDir } from '../Db';

const dirs: string[] = [];
function dataRoot(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsroot-'));
    dirs.push(d);
    return d;
}
afterEach(() => {
    Db._resetForTest();
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('Db singleton', () => {
    it('opens <dataRoot>/wsscrcpy.db, runs the import, and exposes repos', () => {
        const root = dataRoot();
        fs.writeFileSync(
            path.join(root, 'config.json'),
            JSON.stringify({ webPort: 8000, installMode: 'user', firstRunComplete: true, channel: 'beta' }),
        );
        const db = Db.getInstance(root);
        expect(fs.existsSync(path.join(root, 'wsscrcpy.db'))).toBe(true);
        expect(db.appSettings.get('channel')).toBe('beta');
        expect(db.users.getById(1)?.role).toBe('admin');
    });

    it('caches the singleton across getInstance calls (same handle)', () => {
        const root = dataRoot();
        const a = Db.getInstance(root);
        const b = Db.getInstance(root);
        expect(a).toBe(b);
        expect(a.sqlite).toBe(b.sqlite);
    });

    it('backup() writes a .bak snapshot', () => {
        const root = dataRoot();
        const db = Db.getInstance(root);
        const bak = path.join(root, 'wsscrcpy.db.bak');
        db.backup(bak);
        expect(fs.existsSync(bak)).toBe(true);
    });
});

describe('dbDir resolver', () => {
    it('uses dataRoot when set, else the parent of dependenciesPath', () => {
        expect(dbDir({ dataRoot: '/data/root', dependenciesPath: '/opt/app/dependencies' })).toBe('/data/root');
        expect(dbDir({ dataRoot: null, dependenciesPath: '/opt/app/dependencies' })).toBe(
            path.dirname('/opt/app/dependencies'),
        );
    });
});
