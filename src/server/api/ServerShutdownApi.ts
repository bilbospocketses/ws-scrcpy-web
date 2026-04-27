// biome-ignore lint/style/useNodejsImportProtocol: webpack externals don't support node: prefix
import type { IncomingMessage, ServerResponse } from 'http';
import { Logger } from '../Logger';

const log = Logger.for('ServerShutdownApi');

/**
 * HTTP API for SP3 P4a graceful shutdown.
 *
 *   POST /api/server/shutdown -> 200 { ok: true }
 *
 * Used by the Windows tray helper (and the Settings "Stop Server & Exit"
 * button, lands later) to request a clean process exit without killing the
 * Node process from the outside (which would skip flush hooks).
 *
 * Contract (per docs/plans/sp3-p4a-contracts.md):
 *   - Body-less request; payload is ignored.
 *   - Response is sent first, then `process.exit(0)` is scheduled via
 *     setTimeout so the response gets flushed to the socket before the
 *     event loop shuts down.
 *   - 100 ms is empirically enough on localhost; the tray helper's
 *     ureq POST has its own 5 s timeout and exits regardless of reply.
 *   - No auth: localhost-only intent. Future hardening if exposed remotely.
 */
const SHUTDOWN_DELAY_MS = 100;

export class ServerShutdownApi {
    /**
     * Override hooks for unit tests so we can verify scheduling without
     * actually killing the Vitest worker. Production callers omit both args.
     */
    constructor(
        private readonly schedule: (cb: () => void, ms: number) => unknown = setTimeout,
        private readonly exit: (code: number) => void = (code: number) => process.exit(code),
    ) {}

    public async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        if (req.url !== '/api/server/shutdown' || req.method !== 'POST') return false;

        log.info('shutdown requested via /api/server/shutdown');
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));

        this.schedule(() => {
            log.info('exiting (process.exit 0)');
            this.exit(0);
        }, SHUTDOWN_DELAY_MS);

        return true;
    }
}
