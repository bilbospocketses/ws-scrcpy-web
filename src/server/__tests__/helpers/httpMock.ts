import type { IncomingMessage, ServerResponse } from 'http';
import { Readable } from 'stream';

/**
 * A body-capable HTTP req/res pair for handler tests. The req is a real
 * `Readable`, so handlers that read the body via `req.on('data')`/`'end'`
 * (`readJsonBody`) work — the minimal `{ url, method }` stub used elsewhere
 * hangs them. Shared across Phase 2/3/4 handler tests. Pass a `Cookie` header
 * via `headers` for auth tests.
 */
export function makeReqRes(
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
): { req: IncomingMessage; res: ServerResponse; getStatus(): number; getJson(): unknown } {
    // Emit a Buffer (not a string) — readJsonBody does Buffer.concat(chunks),
    // which throws ERR_INVALID_ARG_TYPE on string chunks.
    const req = Readable.from(
        body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    ) as unknown as IncomingMessage;
    req.method = method;
    req.url = url;
    req.headers = { 'content-type': 'application/json', ...headers };
    let status = 0;
    const chunks: string[] = [];
    const res = {
        writeHead(s: number) {
            status = s;
            return res;
        },
        setHeader() {
            /* no-op */
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
    };
}
