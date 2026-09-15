import type { IncomingMessage, ServerResponse } from 'http';
import { requireAdmin } from '../auth/requireAdmin';
import { Logger } from '../Logger';
import { PairingService } from '../pairing/PairingService';
import { encodeQrSvg } from '../pairing/qr';
import { BodyTooLargeError, InvalidJsonError, readJsonBodyStrict, sendInternalError } from './utils';

const log = Logger.for('PairingApi');

/** Every route this handler owns lives under here. */
const PREFIX = '/api/devices/pair';

/**
 * `address` reaches adb as an argv element of `adb pair <address> <code>`.
 * `PairingService.startCode` does NOT validate it and `AdbClient.pair` only
 * validates a `-s` serial, so this is the only place it is checked — and it is
 * request-body input.
 *
 * execFile means there is no shell to inject into, so the real hazards are
 * option injection (adb parses a leading `-` as a flag, e.g. `-H` to redirect
 * to another adb server) and a value that is not an endpoint at all. The
 * phone's wireless-debugging screen shows `IP:port`, so that is the only shape
 * accepted: an IPv4 literal or a hostname, or a bracketed IPv6 literal, plus a
 * port. The port range is checked numerically because the pattern alone would
 * accept `:0` and `:99999`.
 */
const HOST_PORT_RE =
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]{2,45}\]):(\d{1,5})$/;

export function isPairingAddress(value: string): boolean {
    if (value.length > 300) {
        return false;
    }
    const match = HOST_PORT_RE.exec(value);
    if (!match) {
        return false;
    }
    const port = Number(match[1] ?? '');
    return port >= 1 && port <= 65535;
}

/**
 * Android's wireless-debugging pairing code is six digits. Accepting digits
 * only — with a little slack on the length rather than a hard six, in case a
 * vendor build differs — keeps anything that could be read as an adb option or
 * a control character out of the argv.
 */
const PAIRING_CODE_RE = /^[0-9]{4,10}$/;

export function isPairingCode(value: string): boolean {
    return PAIRING_CODE_RE.test(value);
}

/**
 * The HTTP surface for wireless pairing: start a QR or pairing-code session,
 * poll it, cancel it.
 *
 * REGISTRATION ORDER IS LOAD-BEARING. `DeviceDiscoveryApi.handle` claims ANY
 * url starting `/api/devices`, and when none of its own routes match it answers
 * 404 and returns `true`. Registered after it, every route here 404s with
 * nothing in the log to say why. Register this handler FIRST — see
 * `src/server/index.ts`, and the routing test in `pairingApi.test.ts` that
 * pins the behaviour.
 *
 * The pairing password never leaves this process. The QR payload embeds it, so
 * the QR route converts it to markup and drops the string: it is not returned,
 * not logged, not stored. `PairingStatus` has no field that could carry it in
 * any state, and the catch below logs an error's NAME only — the pairing code
 * is an argument to calls made in here, so an unaudited error message is not
 * safe to log. `PairingService` logs its own already-redacted detail.
 */
export class PairingApi {
    /**
     * Lazy by default, mirroring `AuthGate`'s `getDb`: resolving the singleton
     * eagerly would build an `AdbClient` (and read `Config`) at construction
     * time. Tests pass their own service rather than mutating the singleton,
     * which would leak a live discovery timer between them.
     */
    constructor(private readonly getService: () => PairingService = () => PairingService.getInstance()) {}

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        let pathname: string;
        let params: URLSearchParams;
        try {
            const parsed = new URL(req.url || '', 'http://localhost');
            pathname = parsed.pathname;
            params = parsed.searchParams;
        } catch {
            return false; // unparseable target — not ours to answer
        }
        // Match on the PATH, not the raw url: `url === '/api/devices/pair/qr'`
        // would miss a query string, and `startsWith('.../status')` would also
        // claim `/api/devices/pair/statuses`.
        if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) {
            return false;
        }

        res.setHeader('Content-Type', 'application/json');

        // Admin-scoped, and DELIBERATELY stricter than the neighbouring device
        // routes — this asymmetry is the decision, not an oversight to be tidied
        // away. Pairing establishes a PERSISTENT trust relationship with a NEW
        // device, on behalf of the whole server; `/api/devices/connect` merely
        // attaches to a device that is already trusted. That is a real
        // difference in privilege.
        //
        // In open mode this passes: the acting user resolves to the implicit
        // admin. It is deliberately NOT `requireOperator`, which also demands
        // loopback — the ordinary way to use this feature is standing at the
        // phone driving the UI from a laptop across the room, and requiring
        // loopback would lock that out unless WS_SCRCPY_ALLOW_REMOTE_ADMIN=1.
        //
        // The gate sits here — after the ownership check, before the route
        // table — so that a route added later cannot silently land ungated,
        // while a URL this handler does not own still falls through with
        // `false` instead of being answered with somebody else's 403.
        if (!requireAdmin(req, res)) {
            return true;
        }

        const svc = this.getService();
        try {
            if (req.method === 'POST' && pathname === `${PREFIX}/qr`) {
                const { sessionId, payload, expiresAt } = svc.startQr();
                // The payload is converted here and never returned, logged, or
                // stored. Only the rendered SVG leaves the process.
                const svg = encodeQrSvg(payload);
                res.writeHead(200);
                res.end(JSON.stringify({ sessionId, svg, expiresAt }));
                return true;
            }

            if (req.method === 'POST' && pathname === `${PREFIX}/code`) {
                const body = await readJsonBodyStrict<{ address?: unknown; code?: unknown }>(req);
                const address = typeof body.address === 'string' ? body.address.trim() : '';
                const code = typeof body.code === 'string' ? body.code.trim() : '';
                if (!address || !code) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'address and code are required' }));
                    return true;
                }
                // Validated separately from the presence check so the user is
                // told which half is wrong. Neither message echoes the input —
                // the code is a secret and the address is attacker-controlled.
                if (!isPairingAddress(address)) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'address must be IP:port, as shown on the phone' }));
                    return true;
                }
                if (!isPairingCode(code)) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'code must be the numeric pairing code shown on the phone' }));
                    return true;
                }
                res.writeHead(200);
                res.end(JSON.stringify(svc.startCode(address, code)));
                return true;
            }

            if (req.method === 'GET' && pathname === `${PREFIX}/status`) {
                const status = svc.status(params.get('sessionId') ?? '');
                if (!status) {
                    // 404 rather than returning the active session: an unknown
                    // id must not be a way to read somebody else's pairing.
                    //
                    // A CANCELLED session lands here too — `cancel` drops the
                    // session outright, so the next poll is a miss rather than
                    // a 'failed' status. For the client, a 404 that follows its
                    // own cancel is the success signal, not an error.
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'no such pairing session' }));
                    return true;
                }
                // `expired` and the three terminal states are final: the client
                // can stop polling on any of them. A session past 'awaiting-scan'
                // never reports 'expired' — the TTL bounds the scan window only.
                res.writeHead(200);
                res.end(JSON.stringify(status));
                return true;
            }

            if (req.method === 'POST' && pathname === `${PREFIX}/cancel`) {
                const { sessionId } = await readJsonBodyStrict<{ sessionId?: string }>(req);
                // Idempotent on purpose: `cancel` already no-ops for an id that
                // is not current, and a teardown path should not have to care
                // whether it won the race against expiry or a replacement.
                if (typeof sessionId === 'string' && sessionId) {
                    svc.cancel(sessionId);
                }
                res.writeHead(200);
                res.end(JSON.stringify({ ok: true }));
                return true;
            }

            // An owned prefix but no route — let the chain answer it, which is
            // DeviceDiscoveryApi's `/api/devices` 404.
            return false;
        } catch (err) {
            if (err instanceof BodyTooLargeError) {
                res.writeHead(413);
                res.end(JSON.stringify({ error: 'request body too large' }));
                return true;
            }
            if (err instanceof InvalidJsonError) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: 'invalid JSON body' }));
                return true;
            }
            // NAME only, never `.message`. The pairing code and the QR payload
            // are arguments to calls made above, so an error from an unaudited
            // path could carry one into the log — the exact leak `AdbClient.pair`
            // exists to prevent. The route is enough to locate the failure.
            log.error(`${req.method} ${pathname} threw ${(err as Error)?.name || 'Error'}`);
            sendInternalError(res);
            return true;
        }
    }
}
