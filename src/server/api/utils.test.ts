import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
    BodyTooLargeError,
    InvalidJsonError,
    MAX_BODY_BYTES,
    readBodyCapped,
    readJsonBody,
    readJsonBodyStrict,
    sendInternalError,
} from './utils';

function reqFrom(chunks: Array<Buffer | string>): IncomingMessage {
    return Readable.from(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c))) as unknown as IncomingMessage;
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

describe('readJsonBodyStrict', () => {
    it('parses a JSON object', async () => {
        expect(await readJsonBodyStrict(reqFrom(['{"a":1}']))).toEqual({ a: 1 });
    });

    it('resolves to {} on an empty body (caller validates required fields and 400s)', async () => {
        expect(await readJsonBodyStrict(reqFrom([]))).toEqual({});
    });

    it('throws InvalidJsonError on malformed JSON (so the handler can 400, not 500)', async () => {
        await expect(readJsonBodyStrict(reqFrom(['not json']))).rejects.toBeInstanceOf(InvalidJsonError);
    });

    it('throws InvalidJsonError on a non-object payload (array or primitive)', async () => {
        await expect(readJsonBodyStrict(reqFrom(['[1,2]']))).rejects.toBeInstanceOf(InvalidJsonError);
        await expect(readJsonBodyStrict(reqFrom(['42']))).rejects.toBeInstanceOf(InvalidJsonError);
    });

    it('propagates BodyTooLargeError over the cap (distinct from a 400)', async () => {
        await expect(readJsonBodyStrict(reqFrom([Buffer.alloc(2048, 0x61)]), 1024)).rejects.toBeInstanceOf(
            BodyTooLargeError,
        );
    });
});

describe('sendInternalError', () => {
    function mockRes(headersSent: boolean) {
        return { headersSent, writeHead: vi.fn(), end: vi.fn() };
    }

    it('writes a generic 500 with no internal detail when headers are unsent', () => {
        const res = mockRes(false);
        sendInternalError(res as unknown as ServerResponse);
        expect(res.writeHead).toHaveBeenCalledWith(500, { 'Content-Type': 'application/json' });
        expect(JSON.parse(res.end.mock.calls[0]![0] as string)).toEqual({ error: 'internal error' });
    });

    it('does not writeHead again once headers were sent (avoids the double-writeHead throw)', () => {
        const res = mockRes(true);
        sendInternalError(res as unknown as ServerResponse);
        expect(res.writeHead).not.toHaveBeenCalled();
        expect(res.end).toHaveBeenCalledWith();
    });
});
