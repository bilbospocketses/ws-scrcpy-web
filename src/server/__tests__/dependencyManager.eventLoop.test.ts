import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DependencyManager } from '../DependencyManager';

/**
 * The first-run install copies the extracted Node tree (~2,500 files, ~110 MB)
 * into place on the server's only thread, while it is serving requests. Done
 * synchronously that parks every in-flight request behind it: a 4-second
 * `/api/config` measured on a fast NVMe box, past 10 s on a CI runner — which
 * was the whole of the auth suite's "flaky" 18.11 (the post-reload
 * `/api/settings` never answered inside its 10 s expect).
 *
 * The contract: the copy yields to the event loop. A macrotask scheduled just
 * before the copy starts must run BEFORE the copy finishes. With a synchronous
 * copy it cannot — the loop never turns until the last file is written — so
 * this is red against the old code by construction, not by timing.
 */

let tmp: string;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsscrcpy-copydir-'));
});
afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

function seedTree(root: string, dirs: number, filesPerDir: number): string[] {
    const files: string[] = [];
    for (let d = 0; d < dirs; d++) {
        const dir = path.join(root, `dir-${d}`, 'nested');
        fs.mkdirSync(dir, { recursive: true });
        for (let f = 0; f < filesPerDir; f++) {
            const p = path.join(dir, `file-${f}.bin`);
            fs.writeFileSync(p, `${d}/${f}`);
            files.push(path.relative(root, p));
        }
    }
    return files;
}

describe('DependencyManager.copyDirContents', () => {
    it('yields to the event loop between files instead of blocking until the tree is copied', async () => {
        const src = path.join(tmp, 'src');
        const dest = path.join(tmp, 'dest');
        const files = seedTree(src, 4, 16);
        const mgr = new DependencyManager(path.join(tmp, 'deps'));

        let finished = false;
        let macrotaskRanBeforeFinish = false;
        setImmediate(() => {
            macrotaskRanBeforeFinish = !finished;
        });
        // copyDirContents is private — invoked via a typed cast for the test only.
        await (mgr as unknown as { copyDirContents(s: string, d: string): Promise<void> }).copyDirContents(src, dest);
        finished = true;
        // Let the immediate run if it has not yet (it has, if the copy yielded).
        await new Promise<void>((r) => setImmediate(r));

        expect(macrotaskRanBeforeFinish).toBe(true);
        for (const rel of files) {
            expect(fs.readFileSync(path.join(dest, rel), 'utf8')).toBe(fs.readFileSync(path.join(src, rel), 'utf8'));
        }
    });

    it('copies an empty directory tree without error and creates the destination', async () => {
        const src = path.join(tmp, 'src');
        const dest = path.join(tmp, 'dest');
        fs.mkdirSync(path.join(src, 'empty'), { recursive: true });
        const mgr = new DependencyManager(path.join(tmp, 'deps'));

        await (mgr as unknown as { copyDirContents(s: string, d: string): Promise<void> }).copyDirContents(src, dest);

        expect(fs.statSync(path.join(dest, 'empty')).isDirectory()).toBe(true);
    });
});
