import type { IncomingMessage, ServerResponse } from 'http';
import { isAuthEnabled } from '../auth/authState';
import { requireAdmin } from '../auth/requireAdmin';
import { Config } from '../Config';
import { Logger } from '../Logger';
import { isValidToken, parseTokenFromCookie } from '../security/instanceToken';
import { isLoopback } from '../security/loopback';

/** Whether AuthGate attached a validated session user to this request. */
function hasAuthenticatedUser(req: IncomingMessage): boolean {
    return (req as IncomingMessage & { user?: unknown }).user !== undefined;
}

const log = Logger.for('ServerShutdownApi');

/**
 * HTTP API for SP3 P4a graceful shutdown.
 *
 *   POST /api/server/shutdown -> 200 { ok: true }
 *
 * Used by the Windows tray helper and the Settings "stop server & exit" button
 * (§27) to request a clean process exit without killing the Node process from
 * the outside (which would skip flush hooks).
 *
 * Contract (per docs/plans/sp3-p4a-contracts.md):
 *   - Body-less request; payload is ignored.
 *   - Response is sent first, then teardown + `process.exit(0)` are scheduled
 *     via setTimeout so the response gets flushed to the socket before the
 *     event loop shuts down.
 *   - 100 ms is empirically enough on localhost; the tray helper's
 *     ureq POST has its own 5 s timeout and exits regardless of reply.
 *   - On the scheduled tick we run `cleanup()` (the shared gracefulShutdown
 *     from index.ts — stops the adb daemon + releases running services) and
 *     await it BEFORE exiting, so a button/tray quit doesn't orphan the adb
 *     daemon. process.exit(0) is a clean exit; the launcher's supervisor sees
 *     `decide_restart(0, false) == None` and does NOT restart (exit 75 is the
 *     restart sentinel — deliberately NOT used here).
 *
 * Who may call it (item 114, 2026-09-06 — this used to read "No auth:
 * localhost-only intent", which stopped being true the moment the per-instance
 * token shipped and quietly killed the tray's Exit):
 *
 * The endpoint is exempt from BOTH gates — the per-instance token
 * (security/instanceToken.ts) and AuthGate (auth/authState.ts) — because the
 * tray helper is a process, not a browser: it has no cookie and no session, and
 * in service mode its Exit is the only stop affordance the product has. This
 * handler therefore does the authorizing itself:
 *
 *   - **On loopback: allowed.** Stopping the app from the machine it runs on is
 *     the operator's call (user decision, 2026-09-06). The trade is explicit:
 *     any local process can stop the server, including a system-scope service a
 *     non-admin user could not otherwise stop. Loopback is the same trust
 *     boundary `WhoamiApi` and the embed-consent endpoints already draw.
 *   - **Off-box: unchanged from before the exemptions.** The caller must
 *     present the instance token (403 without it — a LAN client that never
 *     loaded the page has none), and in locked mode must be signed in (401).
 *     Note this is NOT "loopback only": a browser reaching a containerised
 *     server comes through the Docker gateway, and row 20.6 exists to catch
 *     exactly that regression.
 *   - **`requireAdmin` runs last**, so a signed-in non-admin cannot stop the
 *     server from anywhere.
 */
const SHUTDOWN_DELAY_MS = 100;

export interface ServerShutdownApiOptions {
    /**
     * Async teardown run on the scheduled tick BEFORE process exit — stops the
     * adb daemon + releases running services so a graceful quit doesn't orphan
     * them. Production passes the shared `gracefulShutdown()` from index.ts;
     * the default no-op keeps tests that don't exercise cleanup terse.
     */
    cleanup?: () => Promise<void>;
    /** setTimeout seam — tests inject to capture the scheduled callback. */
    schedule?: (cb: () => void, ms: number) => unknown;
    /** process.exit seam — tests inject to avoid killing the worker. */
    exit?: (code: number) => void;
}

export class ServerShutdownApi {
    private readonly cleanup: () => Promise<void>;
    private readonly schedule: (cb: () => void, ms: number) => unknown;
    private readonly exit: (code: number) => void;

    /**
     * Production callers pass `{ cleanup }`; the schedule/exit seams default to
     * the real `setTimeout` / `process.exit` and are overridden only in tests.
     */
    constructor(options: ServerShutdownApiOptions = {}) {
        this.cleanup = options.cleanup ?? (async () => {});
        this.schedule = options.schedule ?? setTimeout;
        this.exit = options.exit ?? ((code: number) => process.exit(code));
    }

    public async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        if (req.url !== '/api/server/shutdown' || req.method !== 'POST') return false;

        res.setHeader('Content-Type', 'application/json');

        // Loopback is what authorizes the COOKIELESS caller this endpoint's
        // exemptions exist for (the tray helper). An off-box caller gets the
        // treatment it had before those exemptions: it must present the
        // instance token it was handed with the page, and in locked mode it
        // must be signed in.
        //
        // This is not "loopback only". Requiring loopback outright broke the
        // Settings button inside a container, where the browser reaches the
        // server through the Docker gateway and so is never on loopback —
        // caught by row 20.6 in CI, which is exactly what that row is for.
        if (!isLoopback(req.socket?.remoteAddress ?? '')) {
            if (!isValidToken(parseTokenFromCookie(req.headers.cookie))) {
                log.warn(`refusing shutdown from ${req.socket?.remoteAddress ?? '<unknown>'}: no instance token`);
                res.writeHead(403);
                res.end(JSON.stringify({ error: 'this endpoint answers this machine only' }));
                return true;
            }
            if (isAuthEnabled(Config.getInstance().db) && !hasAuthenticatedUser(req)) {
                // AuthGate lets this path through unauthenticated so the tray
                // can reach it; off-box, that exemption is re-imposed here.
                log.warn(`refusing shutdown from ${req.socket?.remoteAddress ?? '<unknown>'}: not signed in`);
                res.writeHead(401);
                res.end(JSON.stringify({ error: 'unauthorized' }));
                return true;
            }
        }

        // A signed-in non-admin cannot stop the server, from anywhere. In open
        // mode, and for the cookieless local caller in locked mode, this
        // resolves to the implicit admin and passes — deliberate, see above.
        if (!requireAdmin(req, res)) return true;

        log.info('shutdown requested via /api/server/shutdown');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));

        // Return the promise from the scheduled callback so tests can await the
        // full teardown→exit chain; production setTimeout ignores the return.
        this.schedule(() => this.shutdown(), SHUTDOWN_DELAY_MS);

        return true;
    }

    /**
     * Run graceful cleanup (best-effort), then exit 0. Cleanup failure is
     * logged and swallowed — a stuck teardown must not block the exit, and the
     * exit watchdog in index.ts backstops any hang.
     */
    private async shutdown(): Promise<void> {
        try {
            await this.cleanup();
        } catch (err) {
            log.warn(`graceful cleanup failed during shutdown: ${(err as Error)?.message ?? String(err)}`);
        }
        log.info('exiting (process.exit 0)');
        this.exit(0);
    }
}
