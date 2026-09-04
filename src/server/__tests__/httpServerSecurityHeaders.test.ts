import type { IncomingMessage, ServerResponse } from 'http';
import { describe, expect, it } from 'vitest';
import { createHttpRequestHandler } from '../services/HttpServer';
import { makeReqRes } from './helpers/httpMock';

// Finding 10.8 — X-Content-Type-Options and X-Frame-Options were present on
// static responses, the login page and the login 401, but absent from every API
// JSON response and from the request gate's own 403: those are the paths that
// were never routed through the shared securityHeaders() helper. The fix sets
// them once at the request-handler choke point, so every response on the server
// carries them regardless of which handler ends up writing the body.
describe('HttpServer baseline security headers', () => {
    const jsonHandler = {
        async handle(_req: IncomingMessage, res: ServerResponse): Promise<boolean> {
            res.writeHead(200);
            res.end(JSON.stringify({ ok: true }));
            return true;
        },
    };

    it('sets them on an API JSON response', async () => {
        const handler = createHttpRequestHandler([jsonHandler], undefined, false);
        const { req, res, getStatus, getHeader } = makeReqRes('GET', '/api/config', undefined, {
            host: 'localhost:8000',
        });

        handler(req, res);
        await new Promise((r) => setImmediate(r));

        expect(getStatus()).toBe(200);
        expect(getHeader('X-Content-Type-Options')).toBe('nosniff');
        expect(getHeader('X-Frame-Options')).toBe('SAMEORIGIN');
    });

    it("sets them on the request gate's 403", async () => {
        const handler = createHttpRequestHandler([jsonHandler], undefined, false);
        // A foreign Host is refused by the DNS-rebinding guard before any
        // handler runs, so this response is written by the gate itself.
        const { req, res, getStatus, getJson, getHeader } = makeReqRes('GET', '/api/config', undefined, {
            host: 'evil.example.com',
        });

        handler(req, res);
        await new Promise((r) => setImmediate(r));

        expect(getStatus()).toBe(403);
        expect(getJson()).toMatchObject({ error: 'forbidden' });
        expect(getHeader('X-Content-Type-Options')).toBe('nosniff');
        expect(getHeader('X-Frame-Options')).toBe('SAMEORIGIN');
    });
});
