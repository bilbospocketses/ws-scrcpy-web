import { describe, expect, it } from 'vitest';
import { Entry } from '../../Entry';
import { parseDataChunk, parseDentReply, parseFailReply, parseStatReply, readSyncReplyCode } from '../adbSyncReply';

function u32le(n: number): number[] {
    return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
}
function buildReply(code: string, body: number[]): Uint8Array {
    const codeBytes = [...new TextEncoder().encode(code)];
    return new Uint8Array([...codeBytes, ...body]);
}

describe('readSyncReplyCode', () => {
    it('reads the 4-byte ascii reply code', () => {
        expect(readSyncReplyCode(buildReply('DENT', [0, 0]))).toBe('DENT');
        expect(readSyncReplyCode(buildReply('FAIL', []))).toBe('FAIL');
    });
});

describe('parseDentReply', () => {
    it('extracts a directory entry (name, size, type) from the DENT body', () => {
        const name = 'file.txt';
        const data = buildReply('DENT', [
            ...u32le(0o100644), // mode: regular file
            ...u32le(1234), // size
            ...u32le(99), // mtime
            ...u32le(name.length), // namelen
            ...new TextEncoder().encode(name),
        ]);
        const entry = parseDentReply(data);
        expect(entry).toBeInstanceOf(Entry);
        expect(entry.name).toBe(name);
        expect(entry.size).toBe(1234);
        expect(entry.isFile()).toBe(true);
        expect(entry.isDirectory()).toBe(false);
    });
});

describe('parseStatReply', () => {
    it('extracts mode/size/mtime from the STAT body', () => {
        const data = buildReply('STAT', [...u32le(0o40755), ...u32le(4096), ...u32le(42)]);
        expect(parseStatReply(data)).toEqual({ mode: 0o40755, size: 4096, mtime: 42 });
    });
});

describe('parseFailReply', () => {
    it('extracts the length-prefixed failure message', () => {
        const msg = 'permission denied';
        const data = buildReply('FAIL', [...u32le(msg.length), ...new TextEncoder().encode(msg)]);
        expect(parseFailReply(data)).toBe(msg);
    });
});

describe('parseDataChunk', () => {
    it('returns the payload after the 4-byte code', () => {
        expect([...parseDataChunk(buildReply('DATA', [1, 2, 3, 4]))]).toEqual([1, 2, 3, 4]);
    });
});
