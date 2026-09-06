import * as zlib from 'node:zlib';

/**
 * Builds ZIPs byte by byte rather than leaning on a library, because the point
 * of the tests that use it is to pin the exact on-disk layout our extractor
 * claims to read — a library fixture would only prove we agree with that
 * library. Shared by zipExtract.test.ts (layout, modes, refusals) and
 * zipExtract.offThread.test.ts (where the inflate runs).
 */

export const MADE_BY_UNIX = 3;
export const MADE_BY_DOS = 0;

export interface FixtureEntry {
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

export function buildZip(entries: FixtureEntry[]): Buffer {
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
