import type { IncomingMessage, ServerResponse } from 'http';
import { requireAdmin } from '../auth/requireAdmin';
import { Config } from '../Config';
import { Logger } from '../Logger';
import { createRequest, getPendingRequest, getStatus, resolveRequest } from '../security/embedRequests';
import { readJsonBody } from './utils';

const log = Logger.for('EmbedRequestApi');

/**
 * Consent flow for embedding permission — see security/embedRequests.ts for the
 * reasoning behind the split between these two surfaces.
 *
 *   POST /embed-request        — ungated. Another local app asks for permission.
 *                                Creates a prompt; touches nothing else.
 *   GET  /embed-request/{id}   — ungated. That app reads the outcome.
 *
 *   GET  /api/embed-request          — admin. The pending prompt, for our UI.
 *   POST /api/embed-request/decision — admin. A human's Approve / Deny.
 *
 * The ungated pair sits outside /api deliberately: `requiresToken` covers only
 * /api, and a foreign app has no way to hold this instance's token cookie. They
 * are still behind the Host allowlist, and behind the Origin check for the POST
 * — which is what stops a web page from asking at all, since a browser always
 * sends Origin and it will never match ours.
 */
export class EmbedRequestApi {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = (req.url || '').split('?')[0] ?? '';

        if (url === '/embed-request' && req.method === 'POST') {
            return this.handleAsk(req, res);
        }
        if (url.startsWith('/embed-request/') && req.method === 'GET') {
            return this.handleStatus(url, res);
        }
        if (url === '/api/embed-request' && req.method === 'GET') {
            return this.handlePending(req, res);
        }
        if (url === '/api/embed-request/decision' && req.method === 'POST') {
            return this.handleDecision(req, res);
        }
        return false;
    }

    private async handleAsk(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        res.setHeader('Content-Type', 'application/json');

        // Loopback only. The Host allowlist already accepts LAN IPs so the app
        // can be used from another machine, but nothing on the LAN should be
        // able to raise a consent prompt on this desktop.
        const remote = req.socket.remoteAddress ?? '';
        if (!isLoopback(remote)) {
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'embed requests are accepted from this machine only' }));
            return true;
        }

        // readJsonBody never throws — it returns {} for a malformed, oversized or non-object body
        // — so a bad body simply yields an empty origin and is rejected below as such.
        const body = await readJsonBody(req);

        const origin = typeof body['origin'] === 'string' ? body['origin'] : '';
        const appName = typeof body['appName'] === 'string' ? body['appName'] : '';

        const created = createRequest(origin, appName);
        if (!created) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'origin must be an http(s) origin with no path' }));
            return true;
        }

        log.info(`${created.appName} asked to embed from ${created.origin}; awaiting approval`);
        res.writeHead(200);
        res.end(JSON.stringify({ id: created.id, status: 'pending' }));
        return true;
    }

    private handleStatus(url: string, res: ServerResponse): boolean {
        res.setHeader('Content-Type', 'application/json');
        const raw = url.slice('/embed-request/'.length);
        let id: string;
        try {
            id = decodeURIComponent(raw);
        } catch {
            // A malformed percent-escape is by definition not a known request id; answering
            // 'unknown' is truer than the 500 an escaping URIError would produce.
            res.writeHead(200);
            res.end(JSON.stringify({ id: raw, status: 'unknown' }));
            return true;
        }
        res.writeHead(200);
        res.end(JSON.stringify({ id, status: getStatus(id) }));
        return true;
    }

    private handlePending(req: IncomingMessage, res: ServerResponse): boolean {
        res.setHeader('Content-Type', 'application/json');
        if (!this.requireLocalAdmin(req, res)) return true;
        res.writeHead(200);
        res.end(JSON.stringify({ request: getPendingRequest() }));
        return true;
    }

    /**
     * Admin AND loopback, for the two endpoints that read or decide a request.
     *
     * requireAdmin alone is not sufficient. In open mode (the default) it resolves to the implicit
     * admin, and the per-instance token that gates /api is handed to any unauthenticated GET of an
     * extensionless path — so a LAN client can mint a token and approve its own request. The
     * approval surface therefore carries the same loopback restriction the asking surface has:
     * consent is given at the machine, not over the network.
     */
    private requireLocalAdmin(req: IncomingMessage, res: ServerResponse): boolean {
        if (!isLoopback(req.socket.remoteAddress ?? '')) {
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'embed permission is decided on this machine only' }));
            return false;
        }
        return requireAdmin(req, res);
    }

    private async handleDecision(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        res.setHeader('Content-Type', 'application/json');
        if (!this.requireLocalAdmin(req, res)) return true;

        // readJsonBody is best-effort and returns {} rather than throwing, so a malformed body
        // falls through to the id check below and is answered as "no pending request".
        const body = await readJsonBody(req);

        const id = typeof body['id'] === 'string' ? body['id'] : '';
        const approved = body['approved'] === true;

        const request = resolveRequest(id, approved);
        if (!request) {
            // Already answered, expired, or superseded. Never approve on a
            // stale prompt.
            res.writeHead(409);
            res.end(JSON.stringify({ error: 'no pending request with that id' }));
            return true;
        }

        if (!approved) {
            log.info(`Embedding from ${request.origin} was denied`);
            res.writeHead(200);
            res.end(JSON.stringify({ status: 'denied' }));
            return true;
        }

        const persisted = Config.getInstance().addFrameAncestor(request.origin);
        if (!persisted) {
            log.warn(`Approved embedding from ${request.origin} but it is not a usable frame ancestor`);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'could not apply the approved origin' }));
            return true;
        }

        log.info(`Embedding from ${request.origin} approved and applied`);
        res.writeHead(200);
        res.end(JSON.stringify({ status: 'approved', origin: request.origin }));
        return true;
    }
}

function isLoopback(remoteAddress: string): boolean {
    // Node reports IPv4-mapped IPv6 for dual-stack listeners (::ffff:127.0.0.1).
    const addr = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice('::ffff:'.length) : remoteAddress;
    return addr === '127.0.0.1' || addr === '::1' || addr.startsWith('127.');
}
