// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as http from 'http';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverServicePort, probePort } from '../service/discoverServicePort';

interface FakeServer {
    server: http.Server;
    port: number;
    close(): Promise<void>;
}

async function startFakeWhoamiServer(pid: number): Promise<FakeServer> {
    const server = http.createServer((req, res) => {
        if (req.url === '/api/whoami') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ pid, installMode: 'user', version: 'test' }));
        } else {
            res.writeHead(404);
            res.end();
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') {
        throw new Error('could not bind fake server');
    }
    return {
        server,
        port: addr.port,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

describe('probePort', () => {
    let fake: FakeServer | null = null;

    afterEach(async () => {
        if (fake) {
            await fake.close();
            fake = null;
        }
    });

    it('returns true when port responds with /api/whoami and a different pid', async () => {
        fake = await startFakeWhoamiServer(99999);
        const found = await probePort(fake.port, 1234, '127.0.0.1');
        expect(found).toBe(true);
    });

    it('returns false when port responds with our own pid', async () => {
        fake = await startFakeWhoamiServer(1234);
        const found = await probePort(fake.port, 1234, '127.0.0.1');
        expect(found).toBe(false);
    });

    it('returns false when nothing is listening on the port', async () => {
        // High port unlikely to be in use. probePort has a 1s timeout
        // so the test resolves quickly.
        const found = await probePort(58291, 1234, '127.0.0.1');
        expect(found).toBe(false);
    });
});

describe('discoverServicePort', () => {
    let fake: FakeServer | null = null;

    afterEach(async () => {
        if (fake) {
            await fake.close();
            fake = null;
        }
    });

    it('finds a service instance on the discovered port', async () => {
        fake = await startFakeWhoamiServer(99999);
        const found = await discoverServicePort({
            ownPid: 1234,
            startPort: fake.port,
            range: 1,
            timeoutMs: 2000,
            intervalMs: 50,
        });
        expect(found).toBe(`http://localhost:${fake.port}`);
    });

    it('returns null after timeout when no instance is reachable', async () => {
        // Use a port range that has nothing listening (high ports).
        const found = await discoverServicePort({
            ownPid: 1234,
            startPort: 58291,
            range: 1,
            timeoutMs: 200,
            intervalMs: 50,
        });
        expect(found).toBeNull();
    });
});
