import type { IncomingMessage, ServerResponse } from 'http';
import { getAppVersion } from '../appVersion';
import { Config } from '../Config';
import { isLoopback } from '../security/loopback';

/** The value a sibling probe keys on. Nothing else on this box answers with it. */
export const APP_IDENTITY = 'ws-scrcpy-web';

/**
 * GET /api/whoami — the sibling-instance identity probe.
 *
 * Answers `{ app, pid, installMode, version }` to a caller ON THIS MACHINE and
 * 403 to anyone else. `app` is the positive identification
 * (siblingInstance.ts keys on it; the other three fields are generic enough
 * that any service could emit them); `pid` tells one instance from another.
 *
 * Why it is shaped this way:
 *
 *   - It is exempt from the per-instance token (security/instanceToken.ts) and
 *     from AuthGate (auth/authState.ts) because the caller is a SECOND
 *     INSTANCE of this app deciding whether the process holding its configured
 *     port is one of us. That instance has no cookie and, with users
 *     configured, no session — which is exactly why the token-exempt
 *     `GET /api/config` could not serve as the probe: AuthGate answers it 401
 *     in locked mode, so the guard read "not a sibling" and an elevated second
 *     instance wrote its shifted port into the shared config.json (smoke row
 *     3.7, case b, the limit beta.104 shipped with).
 *   - It is loopback-only BECAUSE it is ungated. The probe is always sent to
 *     127.0.0.1, so nothing is lost, and the LAN learns nothing from it — not
 *     the product name, not the version.
 *
 * History: this endpoint was born for the service-install port-discovery
 * sweep (`localhost:8000..8099/api/whoami`, "the one with a different PID"),
 * which mtime-based discovery replaced long ago; it then sat with no consumer
 * at all until the sibling guard needed exactly what it offers.
 */
export class WhoamiApi {
    // Read package.json directly via getAppVersion(); npm_package_version is
    // only set when launched via `npm`, not when the packaged launcher spawns Node.
    private static readonly version = getAppVersion();

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (url !== '/api/whoami') return false;

        res.setHeader('Content-Type', 'application/json');

        if (req.method !== 'GET') {
            res.writeHead(405);
            res.end(JSON.stringify({ error: 'method not allowed' }));
            return true;
        }

        if (!isLoopback(req.socket?.remoteAddress ?? '')) {
            res.writeHead(403);
            res.end(JSON.stringify({ error: 'this endpoint answers this machine only' }));
            return true;
        }

        res.writeHead(200);
        res.end(
            JSON.stringify({
                app: APP_IDENTITY,
                pid: process.pid,
                installMode: Config.getInstance().getAppConfig().installMode,
                version: WhoamiApi.version,
            }),
        );
        return true;
    }
}
