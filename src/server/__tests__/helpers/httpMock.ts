import type { IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'stream';

/**
 * A body-capable HTTP req/res pair for handler tests. The req is a real
 * `Readable`, so handlers that read the body via `req.on('data')`/`'end'`
 * (`readJsonBody`) work — the minimal `{ url, method }` stub used elsewhere
 * hangs them. Shared across Phase 2/3/4 handler tests. Pass a `Cookie` header
 * via `headers` for auth tests.
 *
 * `socket` fills in the fields handlers read off the connection itself:
 * `encrypted` (did THIS process terminate TLS) and `remoteAddress` (which is
 * what makes an `X-Forwarded-Proto` header trustworthy — see forwardedProto).
 * Omit it and there is no socket at all, which is the pre-existing behaviour
 * every other test relies on.
 */
export function makeReqRes(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
    socket?: { encrypted?: boolean; remoteAddress?: string },
): {
    req: IncomingMessage;
    res: ServerResponse;
    getStatus(): number;
    getJson(): unknown;
    getHeader(name: string): string | undefined;
} {
    // Emit a Buffer (not a string) — readJsonBody does Buffer.concat(chunks),
    // which throws ERR_INVALID_ARG_TYPE on string chunks.
    const req = Readable.from(
        body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    ) as unknown as IncomingMessage;
    req.method = method;
    req.url = url;
    req.headers = { 'content-type': 'application/json', ...headers };
    if (socket) {
        (req as { socket?: unknown }).socket = socket;
    }
    let status = 0;
    const chunks: string[] = [];
    const setHeaders: Record<string, string> = {};
    const res = {
        writeHead(s: number) {
            status = s;
            return res;
        },
        setHeader(name: string, value: string) {
            setHeaders[name.toLowerCase()] = value;
        },
        end(c?: string) {
            if (c) chunks.push(c);
        },
    } as unknown as ServerResponse;
    return {
        req,
        res,
        getStatus: () => status,
        getJson: () => (chunks.length ? JSON.parse(chunks.join('')) : undefined),
        getHeader: (name: string) => setHeaders[name.toLowerCase()],
    };
}
