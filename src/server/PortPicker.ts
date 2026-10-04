import * as net from 'net';

/**
 * Try to bind to a single port. Resolves to true if free, false if busy.
 * Closes the test server immediately on success so the port is available
 * for the real listener.
 */
function tryPort(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
        const server = net.createServer();
        let settled = false;
        const done = (free: boolean) => {
            if (settled) return;
            settled = true;
            try {
                server.close();
            } catch {
                /* ignore */
            }
            resolve(free);
        };
        server.once('error', () => done(false));
        server.once('listening', () => {
            // Close before resolving so the port is immediately reusable.
            server.close(() => resolve(true));
            settled = true;
        });
        try {
            server.listen(port);
        } catch {
            done(false);
        }
    });
}

/** Parse the WS_SCRCPY_WEB_PORT override into a valid port, or null. It forces
 *  the exact port the server listens on (reconcileWebPort.ts). The Docker image
 *  sets it, and so does the e2e harness. */
export function webPortOverride(env: string | undefined): number | null {
    const n = Number(env);
    return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

/**
 * Walk [start, end] inclusive in order. Return the first port that is free,
 * or null if every port in the range is busy.
 */
export async function findAvailablePort(start: number, end: number): Promise<number | null> {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
        return null;
    }
    for (let port = start; port <= end; port++) {
        // eslint-disable-next-line no-await-in-loop -- sequential by design
        const free = await tryPort(port);
        if (free) return port;
    }
    return null;
}
