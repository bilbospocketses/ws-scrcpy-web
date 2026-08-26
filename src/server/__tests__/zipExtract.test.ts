import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractZipTo, readCentralDirectory, resolveEntryPath } from '../zipExtract';

/**
 * These tests build ZIPs byte by byte rather than leaning on a library, because
 * the point is to pin the exact on-disk layout our extractor claims to read —
 * a library fixture would only prove we agree with that library.
 */

const MADE_BY_UNIX = 3;
const MADE_BY_DOS = 0;

interface FixtureEntry {
    name: string;
    content?: Buffer;
    /** 0 = store, 8 = deflate. */
    method?: number;
    /** POSIX mode; omit for a DOS-made entry with no mode bits. */
    unixMode?: number;
    madeBy?: number;
    /** Corrupt the recorded CRC on purpose. */
    breakCrc?: boolean;
}

function buildZip(entries: FixtureEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const e of entries) {
        const isDir = e.name.endsWith('/');
        const content = isDir ? Buffer.alloc(0) : (e.content ?? Buffer.alloc(0));
        const method = isDir ? 0 : (e.method ?? 0);
        const data = method === 8 ? zlib.deflateRawSync(content) : content;
        const crc = e.breakCrc ? 0xdeadbeef : zlib.crc32(content) >>> 0;
        const nameBuf = Buffer.from(e.name, 'utf8');
        const madeBy = e.madeBy ?? (e.unixMode !== undefined ? MADE_BY_UNIX : MADE_BY_DOS);

        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10);
        local.writeUInt16LE(0, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(content.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        nameBuf.copy(local, 30);

        const central = Buffer.alloc(46 + nameBuf.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((madeBy << 8) | 20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(method, 10);
        central.writeUInt16LE(0, 12);
        central.writeUInt16LE(0, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(content.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt16LE(0, 34);
        central.writeUInt16LE(0, 36);
        // `<< 16` on a mode like 0o100755 overflows into the sign bit, so the
        // unsigned coercion has to come after the shift, not before.
        central.writeUInt32LE(e.unixMode !== undefined ? (e.unixMode << 16) >>> 0 : 0, 38);
        central.writeUInt32LE(offset, 42);
        nameBuf.copy(central, 46);

        locals.push(local, data);
        centrals.push(central);
        offset += local.length + data.length;
    }

    const centralBuf = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...locals, centralBuf, eocd]);
}

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
