import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { BodyTooLargeError, MAX_BODY_BYTES, readBodyCapped, readJsonBody } from './utils';

function reqFrom(chunks: Array<Buffer | string>): IncomingMessage {
    return Readable.from(
        chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c)),
    ) as unknown as IncomingMessage;
}

describe('readBodyCapped', () => {
    it('returns the full body when under the cap', async () => {
        expect(await readBodyCapped(reqFrom(['{"a":1}']), 1024)).toBe('{"a":1}');
    });

    it('rejects with BodyTooLargeError and destroys the request on overflow', async () => {
        const req = reqFrom([Buffer.alloc(2048, 0x61)]);
        await expect(readBodyCapped(req, 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
        expect((req as unknown as { destroyed: boolean }).destroyed).toBe(true);
    });

    it('counts cumulative chunk size against the cap', async () => {
        const req = reqFrom([Buffer.alloc(600), Buffer.alloc(600)]);
        await expect(readBodyCapped(req, 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
    });

    it('exposes a sane default cap', () => {
        expect(MAX_BODY_BYTES).toBeGreaterThanOrEqual(64 * 1024);
    });
});

describe('readJsonBody', () => {
    it('parses a JSON object', async () => {
        expect(await readJsonBody(reqFrom(['{"a":1}']))).toEqual({ a: 1 });
    });

    it('returns {} on empty, non-object, or invalid JSON', async () => {
        expect(await readJsonBody(reqFrom([]))).toEqual({});
        expect(await readJsonBody(reqFrom(['[1,2]']))).toEqual({});
        expect(await readJsonBody(reqFrom(['not json']))).toEqual({});
    });

    it('returns {} (best-effort) when the body exceeds the cap', async () => {
        expect(await readJsonBody(reqFrom([Buffer.alloc(2048, 0x61)]), 1024)).toEqual({});
    });
});
