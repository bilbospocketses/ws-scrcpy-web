import type { IncomingMessage, ServerResponse } from 'http';
import { requireAdmin } from '../auth/requireAdmin';
import { Logger } from '../Logger';
import { isLoopback } from '../security/loopback';

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
 * token shipped):
 *
 *   - **Loopback only.** Anything else gets 403 and nothing runs. `listen()`
 *     binds every interface and `isHostAllowed` accepts any IP literal, so the
 *     remote address is what keeps this off the LAN — the same reasoning as
 *     `WhoamiApi` and the embed-consent endpoints.
 *   - **Token-exempt** (security/instanceToken.ts), because the tray helper is
 *     a process and has no cookie. It POSTed here cookielessly since v0.1.8 and
 *     the token gate answered 403 from the day it landed, so the tray's Exit —
 *     the ONLY stop affordance in service mode — silently did nothing.
 *   - **Still behind AuthGate.** In locked mode an unauthenticated caller is
 *     401'd before reaching this handler, so the tray's Exit does not work
 *     there. Exempting it would mean `requireAdmin` falling back to the
 *     implicit admin for a cookieless caller, which is exactly what
 *     `AuthGate`'s fail-closed comment forbids; whether a loopback process may
 *     stop a locked-mode server is a policy question for the operator, not a
 *     bug fix. See todo item 114.
 *   - **`requireAdmin` still runs**, so a signed-in non-admin browser cannot
 *     stop the server.
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

        // Loopback is the authorization for the cookieless caller this endpoint
        // exists for (the tray helper). Checked BEFORE requireAdmin so an
        // off-box caller learns nothing about whether auth is on.
        if (!isLoopback(req.socket?.remoteAddress ?? '')) {
            log.warn(`refusing shutdown from non-loopback ${req.socket?.remoteAddress ?? '<unknown>'}`);
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'this endpoint answers this machine only' }));
            return true;
        }

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
