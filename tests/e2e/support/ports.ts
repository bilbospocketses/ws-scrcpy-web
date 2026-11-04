import net from 'node:net';
import { WAIT_MS } from './timeouts';

/**
 * Ports held and probed the way another program on the host would.
 */

/**
 * Hold a port the way another program would. `listen(port)` with no host binds
 * the same dual-stack wildcard the app's own `server.listen(port)` does, so the
 * collision is real on Linux and Windows alike; a blocker on 127.0.0.1 alone
 * would not stop a wildcard bind on Windows.
 *
 * Accepted sockets are closed at once and their errors swallowed. A walking
 * server PROBES the busy port to ask whether a sibling instance holds it
 * (siblingInstance.ts), then aborts the probe; an accepted socket with no
 * 'error' listener turns that reset into an uncaught `read ECONNRESET` in the
 * test process, with no stack pointing anywhere near the cause.
 */
export async function holdPort(port: number): Promise<net.Server> {
    const blocker = net.createServer((socket) => {
        socket.on('error', () => {});
        socket.destroy();
    });
    await new Promise<void>((resolve, reject) => {
        blocker.once('error', reject);
        blocker.listen(port, () => resolve());
    });
    return blocker;
}

/** Let go of a port `holdPort` took. Safe on `undefined`, for a `finally` reached before the hold. */
export function releasePort(blocker: net.Server | undefined): Promise<void> {
    return new Promise((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
}

/**
 * Does anything accept a TCP connection on `host`:`port` right now? A refused
 * port answers at once. A connect that neither connects nor is refused within
 * WAIT_MS is no answer at all, so it rejects as HUNG rather than reading as
 * "not listening", which is a verdict.
 */
export function isListening(port: number, host = '127.0.0.1'): Promise<boolean> {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ port, host });
        const done = (v: boolean) => {
            socket.destroy();
            resolve(v);
        };
        socket.setTimeout(WAIT_MS, () => {
            socket.destroy();
            reject(
                new Error(
                    `HUNG: a connect to ${host}:${port} neither connected nor was refused in ${WAIT_MS / 1000} s`,
                ),
            );
        });
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}
