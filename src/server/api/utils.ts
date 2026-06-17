// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';

/**
 * Cap on request-body size. Every body this server reads (config patch, device
 * connect/label/delete, scan) is tiny JSON; 1 MiB is generous. Beyond it we
 * treat the request as abusive and drop it rather than buffering unbounded
 * memory — an unauthenticated memory DoS otherwise. (#22)
 */
export const MAX_BODY_BYTES = 1024 * 1024;

/** Thrown by `readBodyCapped` when a request body exceeds the cap. */
export class BodyTooLargeError extends Error {
    constructor(limit: number) {
        super(`request body exceeds ${limit} bytes`);
        this.name = 'BodyTooLargeError';
    }
}

/**
 * Drain `req` into a UTF-8 string, capping total size at `limit`. On overflow
 * the request is destroyed and the promise rejects with BodyTooLargeError — the
 * caller should respond 413. Buffers are concatenated (not string-appended) so a
 * multi-byte UTF-8 sequence split across chunks decodes correctly. (#22)
 */
export function readBodyCapped(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0;
        let settled = false;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > limit) {
                settled = true;
                reject(new BodyTooLargeError(limit));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (settled) return;
            settled = true;
            resolve(Buffer.concat(chunks).toString('utf8'));
        });
        req.on('error', (err) => {
            if (settled) return;
            settled = true;
            reject(err);
        });
    });
}

/**
 * Drain `req` and parse a JSON body. Returns `{}` on empty body, parse failure,
 * non-object payloads (arrays, primitives), or an over-cap/aborted body —
 * best-effort by design, so callers that need strict validation should layer it
 * on top of the returned object. Memory is bounded by `readBodyCapped`. (#22)
 */
export async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
    let body: string;
    try {
        body = await readBodyCapped(req, limit);
    } catch {
        return {}; // overflow / aborted socket → best-effort empty
    }
    if (body.length === 0) {
        return {};
    }
    try {
        const parsed = JSON.parse(body);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // fall through to {}
    }
    return {};
}

/** Thrown by `readJsonBodyStrict` when a non-empty body is not a JSON object. */
export class InvalidJsonError extends Error {
    constructor() {
        super('request body is not a valid JSON object');
        this.name = 'InvalidJsonError';
    }
}

/**
 * Strict sibling of `readJsonBody`: an empty body still resolves to `{}` (the
 * caller validates required fields and 400s), but a non-empty body that is not a
 * JSON object — parse failure, array, or primitive — throws `InvalidJsonError`,
 * so the handler answers 400 instead of letting a raw `JSON.parse` throw bubble
 * to a generic 500 (which also leaked the parser's message back to the client).
 * Memory is bounded by `readBodyCapped`; an over-cap body rejects with
 * `BodyTooLargeError`. (#72, #73)
 */
export async function readJsonBodyStrict<T extends Record<string, unknown> = Record<string, unknown>>(
    req: IncomingMessage,
    limit = MAX_BODY_BYTES,
): Promise<T> {
    const body = await readBodyCapped(req, limit);
    if (body.length === 0) {
        return {} as T;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(body);
    } catch {
        throw new InvalidJsonError();
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as T;
    }
    throw new InvalidJsonError();
}

/**
 * Write a generic `500` JSON response, guarding `res.headersSent` so a handler
 * that already began streaming a response cannot trigger a "headers after sent"
 * throw at a top-level catch (#74), and never echoing the internal error text
 * back to the client. Callers should log the real error server-side first.
 */
export function sendInternalError(res: ServerResponse): void {
    if (res.headersSent) {
        res.end();
        return;
    }
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
}
