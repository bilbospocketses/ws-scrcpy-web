import type { IncomingMessage, ServerResponse } from 'http';
import { getAppVersion } from '../appVersion';
import { Config } from '../Config';

/**
 * GET /api/whoami — minimal instance identification endpoint.
 *
 * Returns `{ pid, installMode, version }`. Used by the v0.1.8 install
 * port-discovery flow: after the elevated helper installs+starts the
 * service, the local instance polls localhost:8000..8099 hitting
 * `/api/whoami` and identifies the new service instance as "the one
 * with a different PID than us." Without a `pid` exposed somewhere,
 * we'd have to guess based on `installMode` alone, which is brittle.
 *
 * Deliberately minimal: no privileged data (no config secrets, no
 * paths, no env). Just enough for cross-instance identification.
 */
export class WhoamiApi {
    // v0.1.17: read package.json directly via getAppVersion(); npm_package_version
    // is only set when launched via `npm`, not when the packaged launcher spawns Node.
    private static readonly version = getAppVersion();

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (url !== '/api/whoami') return false;

        if (req.method !== 'GET') {
            res.writeHead(405);
            res.end(JSON.stringify({ error: 'method not allowed' }));
            return true;
        }

        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(
            JSON.stringify({
                pid: process.pid,
                installMode: Config.getInstance().getAppConfig().installMode,
                version: WhoamiApi.version,
            }),
        );
        return true;
    }
}
