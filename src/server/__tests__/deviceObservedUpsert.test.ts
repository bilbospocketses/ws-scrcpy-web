import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../db/Db';
import { upsertObservedDevices } from '../api/deviceObserved';

const dirs: string[] = [];
function root(): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wsobs-'));
    dirs.push(d);
    return d;
}
afterEach(() => {
    Db._resetForTest();
    while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('observed device upsert', () => {
    it('records serial/model/address/last-seen and preserves prior non-null fields', () => {
        const dir = root();
        const db = Db.getInstance(dir);
        upsertObservedDevices(db, [{ serial: 'S1', model: 'Pixel 7', lastSeenAt: 10 }]);
        upsertObservedDevices(db, [{ serial: 'S1', address: '10.0.0.5:5555', lastSeenAt: 20 }]);
        expect(db.devices.getDevice('S1')).toMatchObject({
            model: 'Pixel 7',
            address: '10.0.0.5:5555',
            lastSeenAt: 20,
        });
    });
});
