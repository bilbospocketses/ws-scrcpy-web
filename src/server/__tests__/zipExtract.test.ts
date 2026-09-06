import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractZipTo, readCentralDirectory, resolveEntryPath } from '../zipExtract';
import { buildZip, type FixtureEntry, MADE_BY_DOS } from './helpers/zipFixture';

// The byte-level ZIP builder lives in helpers/zipFixture.ts (shared with
// zipExtract.offThread.test.ts); see its header for why it is hand-rolled.

let tmp: string;
let zipPath: string;
let destDir: string;

beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zipextract-'));
    zipPath = path.join(tmp, 'fixture.zip');
    destDir = path.join(tmp, 'out');
});
afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

function writeZip(entries: FixtureEntry[]): void {
    fs.writeFileSync(zipPath, buildZip(entries));
}

describe('extractZipTo', () => {
    it('round-trips stored and deflated entries', async () => {
        const small = Buffer.from('hello');
        // Repetitive so deflate actually compresses and we exercise inflateRawSync.
        const big = Buffer.from('abcdefgh'.repeat(500));
        writeZip([
            { name: 'plain.txt', content: small, method: 0 },
            { name: 'nested/deflated.txt', content: big, method: 8 },
        ]);

        await extractZipTo(zipPath, destDir);

        expect(fs.readFileSync(path.join(destDir, 'plain.txt'))).toEqual(small);
        expect(fs.readFileSync(path.join(destDir, 'nested', 'deflated.txt'))).toEqual(big);
    });

    it('creates explicit directory entries', async () => {
        writeZip([{ name: 'platform-tools/' }, { name: 'platform-tools/adb', content: Buffer.from('bin') }]);

        await extractZipTo(zipPath, destDir);

        expect(fs.statSync(path.join(destDir, 'platform-tools')).isDirectory()).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('preserves the executable bit', async () => {
        // The whole reason mode handling exists: adb ships 0755 in Google's
        // platform-tools zip and is useless without it.
        writeZip([
            { name: 'adb', content: Buffer.from('#!/bin/sh\n'), unixMode: 0o100755 },
            { name: 'NOTICE.txt', content: Buffer.from('legal'), unixMode: 0o100644 },
        ]);

        await extractZipTo(zipPath, destDir);

        expect(fs.statSync(path.join(destDir, 'adb')).mode & 0o777).toBe(0o755);
        expect(fs.statSync(path.join(destDir, 'NOTICE.txt')).mode & 0o777).toBe(0o644);
    });

    it.skipIf(process.platform === 'win32')('falls back to 0644 for DOS-made archives with no mode bits', async () => {
        writeZip([{ name: 'readme.txt', content: Buffer.from('x'), madeBy: MADE_BY_DOS }]);

        await extractZipTo(zipPath, destDir);

        expect(fs.statSync(path.join(destDir, 'readme.txt')).mode & 0o777).toBe(0o644);
    });

    it('refuses an entry that escapes the destination (zip slip)', async () => {
        writeZip([{ name: '../escaped.txt', content: Buffer.from('nope') }]);

        await expect(extractZipTo(zipPath, destDir)).rejects.toThrow(/escapes the destination/i);
        expect(fs.existsSync(path.join(tmp, 'escaped.txt'))).toBe(false);
    });

    it('rejects a CRC mismatch rather than writing corrupt bytes', async () => {
        writeZip([{ name: 'adb', content: Buffer.from('truncated'), breakCrc: true }]);

        await expect(extractZipTo(zipPath, destDir)).rejects.toThrow(/CRC32 mismatch/i);
    });

    it('rejects an unsupported compression method', async () => {
        writeZip([{ name: 'weird.bin', content: Buffer.from('x'), method: 0 }]);
        // Rewrite the central-directory method field to bzip2 (12).
        const buf = fs.readFileSync(zipPath);
        const entries = readCentralDirectory(buf);
        expect(entries).toHaveLength(1);
        const centralStart = buf.length - 22 - (46 + 'weird.bin'.length);
        buf.writeUInt16LE(12, centralStart + 10);
        fs.writeFileSync(zipPath, buf);

        await expect(extractZipTo(zipPath, destDir)).rejects.toThrow(/unsupported ZIP compression method 12/i);
    });

    it('rejects symlink entries instead of silently dropping them', async () => {
        writeZip([{ name: 'link', content: Buffer.from('target'), unixMode: 0o120777 }]);

        await expect(extractZipTo(zipPath, destDir)).rejects.toThrow(/symlink entries are not supported/i);
    });

    it('rejects an encrypted entry', async () => {
        writeZip([{ name: 'secret.txt', content: Buffer.from('x') }]);
        const buf = fs.readFileSync(zipPath);
        const centralStart = buf.length - 22 - (46 + 'secret.txt'.length);
        buf.writeUInt16LE(0x0001, centralStart + 8);
        fs.writeFileSync(zipPath, buf);

        await expect(extractZipTo(zipPath, destDir)).rejects.toThrow(/encrypted/i);
    });
});

describe('readCentralDirectory', () => {
    it('throws a named error when the EOCD is missing', () => {
        expect(() => readCentralDirectory(Buffer.from('not a zip at all'))).toThrow(
            /end-of-central-directory record not found/i,
        );
    });

    it('detects a ZIP64 locator rather than misreading the sentinels', () => {
        const base = buildZip([{ name: 'a.txt', content: Buffer.from('a') }]);
        // Splice a ZIP64 EOCD locator immediately before the EOCD.
        const locator = Buffer.alloc(20);
        locator.writeUInt32LE(0x07064b50, 0);
        const eocd = base.subarray(base.length - 22);
        const withLocator = Buffer.concat([base.subarray(0, base.length - 22), locator, eocd]);

        expect(() => readCentralDirectory(withLocator)).toThrow(/ZIP64/i);
    });

    it('reports the unix mode only for UNIX-made archives', () => {
        const unix = readCentralDirectory(buildZip([{ name: 'a', content: Buffer.from('a'), unixMode: 0o100755 }]));
        expect(unix[0]!.unixMode).toBe(0o100755);

        const dos = readCentralDirectory(buildZip([{ name: 'a', content: Buffer.from('a'), madeBy: MADE_BY_DOS }]));
        expect(dos[0]!.unixMode).toBeNull();
    });
});

describe('resolveEntryPath', () => {
    it('allows ordinary nested paths', () => {
        const dest = path.resolve('/tmp/dest');
        expect(resolveEntryPath(dest, 'platform-tools/adb')).toBe(path.join(dest, 'platform-tools', 'adb'));
    });

    it.each(['../escape.txt', 'a/../../escape.txt', '/etc/passwd'])('rejects %s', (name) => {
        expect(() => resolveEntryPath(path.resolve('/tmp/dest'), name)).toThrow(/escapes the destination/i);
    });
});
