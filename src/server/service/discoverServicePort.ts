// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import * as http from 'http';
import { Logger } from '../Logger';

const log = Logger.for('PortDiscovery');

/**
 * After the elevated helper installs+starts the service, the new
 * service-instance binds whatever port it can — usually 8000 or, more
 * commonly, the next free port up from there because the user's local
 * (calling) instance is still bound to 8000.
 *
 * We discover the service port by polling localhost:{startPort}..
 * {startPort + range - 1}, hitting `/api/whoami` on each, and matching
 * the first response whose `pid` differs from our own. The local
 * instance is the only other ws-scrcpy-web Node process expected on
 * those ports, so a different-PID match is almost certainly the new
 * service instance.
 *
 * Returns the URL string (`http://localhost:<port>`) on success, or
 * `null` on timeout. The caller treats `null` as "skip the auto-redirect
 * for this install" — service is still installed and working, the user
 * just won't get the seamless handoff.
 */
export async function discoverServicePort(
    options: {
        ownPid: number;
        startPort: number;
        range?: number;
        timeoutMs?: number;
        intervalMs?: number;
    },
): Promise<string | null> {
    const { ownPid, startPort } = options;
    const range = options.range ?? 100;
    const timeoutMs = options.timeoutMs ?? 30_000;
    const intervalMs = options.intervalMs ?? 250;

    const deadline = Date.now() + timeoutMs;
    const startTs = Date.now();
    let iteration = 0;

    // §33 beta.38 diagnostic logging — per-iteration progress so we can
    // tell whether discover() was actively polling but missing the new
    // launcher (iterations > 0, no match) vs. immediately bailing out
    // (iterations == 0, timeout sub-100ms). Iteration log is throttled
    // (every 4 iterations) to avoid spam on the 250ms intervalMs cadence.
    while (Date.now() < deadline) {
        iteration++;
        for (let port = startPort; port < startPort + range; port++) {
            // Skip our own port — we know we're on it, so any response
            // there is us, not the new service.
            if (port === options.startPort && await isOwnPort(port, ownPid)) {
                continue;
            }
            const found = await probePort(port, ownPid);
            if (found) {
                log.info(
                    `port-discovery: matched service instance at port ${port} on iteration ${iteration} (elapsed=${Date.now() - startTs}ms)`,
                );
                return `http://localhost:${port}`;
            }
        }
        if (iteration === 1 || iteration % 4 === 0) {
            log.info(
                `port-discovery: iteration ${iteration} elapsed=${Date.now() - startTs}ms, probed ports ${startPort}..${startPort + range - 1}, no match`,
            );
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }

    log.warn(
        `port-discovery: timed out after ${timeoutMs}ms across ${iteration} iterations; no service instance found`,
    );
    return null;
}

/**
 * Hit `http://localhost:<port>/api/whoami` and return true if it
 * responds with a different pid than our own. Any failure (port closed,
 * non-200, parse error, our own pid) returns false — the caller keeps
 * scanning.
 *
 * Exported for unit-testing.
 */
export async function probePort(port: number, ownPid: number, hostname = 'localhost'): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get(
            { hostname, port, path: '/api/whoami', timeout: 1000 },
            (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    resolve(false);
                    return;
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    body += chunk;
                    if (body.length > 4096) {
                        // Defensive: /api/whoami response is < 200 bytes.
                        // If we get more than 4KB, we're talking to
                        // something else.
                        req.destroy();
                        resolve(false);
                    }
                });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body) as { pid?: unknown };
                        const otherPid = typeof parsed.pid === 'number' ? parsed.pid : -1;
                        resolve(otherPid > 0 && otherPid !== ownPid);
                    } catch {
                        resolve(false);
                    }
                });
                res.on('error', () => resolve(false));
            },
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}

/**
 * Returns true if `port` responds to `/api/whoami` with our own pid —
 * i.e. it is us, not another instance. Used to skip our own port in
 * the scan range without forcing a full PID enumeration.
 */
async function isOwnPort(port: number, ownPid: number): Promise<boolean> {
    return new Promise((resolve) => {
        const req = http.get(
            { hostname: 'localhost', port, path: '/api/whoami', timeout: 500 },
            (res) => {
                if (res.statusCode !== 200) {
                    res.resume();
                    resolve(false);
                    return;
                }
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (chunk) => {
                    body += chunk;
                });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body) as { pid?: unknown };
                        resolve(parsed.pid === ownPid);
                    } catch {
                        resolve(false);
                    }
                });
                res.on('error', () => resolve(false));
            },
        );
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
    });
}
