import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractZipTo } from '../zipExtract';
import { buildZip } from './helpers/zipFixture';

/**
 * The first-run dependency install runs on the server's only thread, while it
 * is serving requests. Inflating an entry synchronously — node.exe is ~90 MB
 * uncompressed — parks every in-flight request behind it; measured at a
 * 4-second `/api/config` on a fast NVMe box and past 10 s on a CI runner,
 * where it was the whole of the auth suite's "flaky" 18.11.
 *
 * So the contract is stated as a refusal: `inflateRawSync` throwing here means
 * the extractor must be routing its inflate through zlib's async API, which
 * runs on the libuv threadpool and leaves the event loop free to answer.
 * Separate from zipExtract.test.ts because a module mock applies file-wide.
 */
vi.mock('node:zlib', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:zlib')>();
    return {
        ...real,
        inflateRawSync: () => {
            throw new Error('inflateRawSync ran on the event loop');
        },
    };
});

let tmp: string;
let zipPath: string;
let destDir: string;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zipextract-offthread-'));
    zipPath = path.join(tmp, 'fixture.zip');
    destDir = path.join(tmp, 'out');
});
afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('extractZipTo keeps the inflate off the event loop', () => {
    it('inflates a deflated entry without ever calling inflateRawSync', async () => {
        // Repetitive so deflate actually compresses and an inflate has to happen.
        const big = Buffer.from('abcdefgh'.repeat(4096));
        fs.writeFileSync(
            zipPath,
            buildZip([
                { name: 'plain.txt', content: Buffer.from('hello'), method: 0 },
                { name: 'nested/deflated.bin', content: big, method: 8 },
            ]),
        );

        await extractZipTo(zipPath, destDir);

        expect(fs.readFileSync(path.join(destDir, 'plain.txt'), 'utf8')).toBe('hello');
        expect(fs.readFileSync(path.join(destDir, 'nested', 'deflated.bin'))).toEqual(big);
    });

    it('still rejects a CRC mismatch on the async path', async () => {
        fs.writeFileSync(
            zipPath,
            buildZip([{ name: 'adb', content: Buffer.from('x'.repeat(64)), method: 8, breakCrc: true }]),
        );
        await expect(extractZipTo(zipPath, destDir)).rejects.toThrow(/CRC32 mismatch/i);
    });
});
