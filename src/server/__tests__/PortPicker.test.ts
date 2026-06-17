// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as net from 'net';
import { afterEach, describe, expect, it } from 'vitest';
import { findAvailablePort, webPortOverride } from '../PortPicker';

function listenOn(port: number): Promise<net.Server> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.once('error', reject);
        srv.once('listening', () => resolve(srv));
        // Bind to all interfaces so the test's "busy" reservation collides
        // with PortPicker.tryPort, which also binds to 0.0.0.0 by default.
        srv.listen(port);
    });
}

function close(srv: net.Server): Promise<void> {
    return new Promise((resolve) => {
        try {
            srv.close(() => resolve());
        } catch {
            resolve();
        }
    });
}

/**
 * Open a server on an OS-assigned ephemeral port and immediately close it,
 * returning the port number. The port is "likely free" but the OS may reuse
 * it later — tests that rely on freeness must either keep the slot reserved
 * or accept some flakiness on shared CI runners.
 */
async function reserveEphemeral(): Promise<number> {
    const srv = await new Promise<net.Server>((resolve) => {
        const s = net.createServer();
        s.listen(0, () => resolve(s));
    });
    const addr = srv.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    await close(srv);
    return port;
}

describe('webPortOverride', () => {
    it('parses a valid port', () => {
        expect(webPortOverride('8000')).toBe(8000);
    });
    it('rejects invalid/unset', () => {
        expect(webPortOverride(undefined)).toBeNull();
        expect(webPortOverride('')).toBeNull();
        expect(webPortOverride('0')).toBeNull();
        expect(webPortOverride('70000')).toBeNull();
        expect(webPortOverride('abc')).toBeNull();
    });
});

describe('findAvailablePort', () => {
    const opened: net.Server[] = [];

    afterEach(async () => {
        while (opened.length) {
            const s = opened.pop()!;
            await close(s);
        }
    });

    it('returns the start port when free', async () => {
        const port = await reserveEphemeral();
        const result = await findAvailablePort(port, port);
        expect(result).toBe(port);
    });

    it('skips a busy first port and returns a later free one', async () => {
        // Pick two distinct ephemeral ports, then occupy the lower one and
        // search the range [busy, busy+50]. Result must be > busy.
        const busyPort = await reserveEphemeral();
        const busy = await listenOn(busyPort);
        opened.push(busy);

        const result = await findAvailablePort(busyPort, busyPort + 50);
        expect(result).not.toBe(busyPort);
        expect(result).not.toBeNull();
        expect(result! > busyPort).toBe(true);
    });

    it('returns null when start > end', async () => {
        const result = await findAvailablePort(9000, 8999);
        expect(result).toBeNull();
    });

    it('returns null when every port in range is busy', async () => {
        const port = await reserveEphemeral();
        const srv = await listenOn(port);
        opened.push(srv);
        const result = await findAvailablePort(port, port);
        expect(result).toBeNull();
    });
});
