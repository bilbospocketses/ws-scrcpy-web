import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { verifySha256 } from '../verifySha256';

describe('verifySha256', () => {
    let dir: string;
    let file: string;
    let goodHash: string;
    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sha-'));
        file = path.join(dir, 'blob');
        const data = Buffer.from('hello appimage');
        fs.writeFileSync(file, data);
        goodHash = createHash('sha256').update(data).digest('hex');
    });
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('returns true for a matching hash (case-insensitive)', async () => {
        expect(await verifySha256(file, goodHash.toUpperCase())).toBe(true);
    });
    it('returns false for a wrong hash', async () => {
        expect(await verifySha256(file, '0'.repeat(64))).toBe(false);
    });
});
