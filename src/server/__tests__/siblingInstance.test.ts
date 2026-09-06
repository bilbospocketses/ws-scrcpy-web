import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { isServiceInstance, isSiblingInstance } from '../siblingInstance';

/**
 * The resolver must not persist an auto-shift when the configured port is held
 * by another instance of this app (smoke row 3.7, case b: an elevated second
 * instance wrote its shifted port into the shared config.json). These run
 * against real loopback servers, because the whole question is what a socket
 * answers.
 */
describe('isServiceInstance', () => {
    it('is true only for the service units, which start Node with WS_SCRCPY_SERVICE=1', () => {
        // The service instance keeps persisting its shift: on the Windows
        // handoff the port it finds busy is held by the local node it replaces,
        // and the tray reads the service's port from config.json.
        expect(isServiceInstance({ WS_SCRCPY_SERVICE: '1' })).toBe(true);
        expect(isServiceInstance({ WS_SCRCPY_SERVICE: 'true' })).toBe(false);
        expect(isServiceInstance({})).toBe(false);
    });
});

type Reply = { status: number; body: string; type?: string };

function serve(handler: (path: string) => Reply | 'hang'): Promise<{ server: Server; port: number }> {
    return new Promise((resolve) => {
        const server = createServer((req, res) => {
            const r = handler(req.url ?? '/');
            if (r === 'hang') {
                return; // never answer; the probe's timeout decides
            }
            res.writeHead(r.status, { 'content-type': r.type ?? 'application/json' });
            res.end(r.body);
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port }));
    });
}

function envelope(webPort: number): string {
    return JSON.stringify({
        config: { installMode: null, webPort, firstRunComplete: false },
        runtime: { firstRunComplete: false, portWasAutoShifted: false, webPort, frameAncestors: [] },
    });
}

describe('isSiblingInstance', () => {
    const servers: Server[] = [];
    afterEach(async () => {
        for (const s of servers.splice(0)) {
            s.closeAllConnections();
            await new Promise<void>((r) => s.close(() => r()));
        }
    });

    it('recognises another ws-scrcpy-web by its GET /api/config envelope', async () => {
        const { server, port } = await serve((p) =>
            p === '/api/config' ? { status: 200, body: envelope(8000) } : { status: 404, body: '{}' },
        );
        servers.push(server);
        expect(await isSiblingInstance(port)).toBe(true);
    });

    it("does not mistake another program's 200 for a sibling", async () => {
        const { server, port } = await serve(() => ({ status: 200, body: '<html>hello</html>', type: 'text/html' }));
        servers.push(server);
        expect(await isSiblingInstance(port)).toBe(false);
    });

    it('does not mistake a JSON 200 without the envelope shape for a sibling', async () => {
        const { server, port } = await serve(() => ({ status: 200, body: JSON.stringify({ ok: true, port: 8000 }) }));
        servers.push(server);
        expect(await isSiblingInstance(port)).toBe(false);
    });

    it('treats a non-2xx (an auth-enabled sibling saying 401) as "not a sibling" -- the safe default', async () => {
        const { server, port } = await serve(() => ({ status: 401, body: JSON.stringify({ error: 'login' }) }));
        servers.push(server);
        expect(await isSiblingInstance(port)).toBe(false);
    });

    it('treats a refused connection as "not a sibling"', async () => {
        // Take a port, release it, probe it: nothing listens there now.
        const { server, port } = await serve(() => ({ status: 200, body: envelope(8000) }));
        await new Promise<void>((r) => server.close(() => r()));
        expect(await isSiblingInstance(port)).toBe(false);
    });

    it('gives up within its timeout when the port accepts but never answers', async () => {
        const { server, port } = await serve(() => 'hang');
        servers.push(server);
        const started = Date.now();
        expect(await isSiblingInstance(port, { timeoutMs: 300 })).toBe(false);
        expect(Date.now() - started).toBeLessThan(5000);
    });
});
