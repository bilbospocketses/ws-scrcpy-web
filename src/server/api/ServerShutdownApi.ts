// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import { Logger } from '../Logger';

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
 *   - No auth: localhost-only intent. Future hardening if exposed remotely.
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

        log.info('shutdown requested via /api/server/shutdown');
        res.setHeader('Content-Type', 'application/json');
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
