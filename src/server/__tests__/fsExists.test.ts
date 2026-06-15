import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileExists } from '../util/fsExists';

describe('fileExists', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsexists-'));
    });

    afterEach(() => {
        try {
            fs.rmSync(dir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    });

    it('resolves true for an existing file', async () => {
        const p = path.join(dir, 'present.txt');
        fs.writeFileSync(p, 'x');
        expect(await fileExists(p)).toBe(true);
    });

    it('resolves true for an existing directory', async () => {
        expect(await fileExists(dir)).toBe(true);
    });

    it('resolves false for a missing path (never throws)', async () => {
        expect(await fileExists(path.join(dir, 'does-not-exist'))).toBe(false);
    });
});
