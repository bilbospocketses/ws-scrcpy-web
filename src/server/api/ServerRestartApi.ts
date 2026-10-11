import type { IncomingMessage, ServerResponse } from 'http';
import { requireOperator } from '../auth/requireOperator';
import { Config } from '../Config';
import { Logger } from '../Logger';
import { type RestartSeams, scheduleRestart } from './restartRequest';

const log = Logger.for('ServerRestartApi');

/**
 * HTTP API for Settings → Server's "restart server" (0.5.9).
 *
 *   POST /api/server/restart -> 200 { ok: true }
 *
 * Answers first, then writes the `.restart` marker and exits 75 a beat later
 * (`scheduleRestart`, the path a port change takes). Exit 75 is the restart
 * signal everywhere the app runs under a supervisor: the launcher restarts on
 * it before it looks at whether it is the installed service
 * (`launcher/src/supervisor.rs`, `decide_restart`), and the container's
 * `start.sh` loop restarts on it too. So unlike "stop server & exit", this is
 * offered in service mode and in a container. A bare `npm start` has no
 * supervisor and simply stops.
 *
 * An ordinary admin route, unlike its shutdown sibling: it has no cookieless
 * tray caller, so it keeps the per-instance token and AuthGate, then
 * `requireOperator`. Off this machine that means a signed-in session, or, with
 * sign-in off, remote admin allowed; on this machine too, with sign-in on, the
 * caller must be signed in (AuthGate). Either way only an admin passes.
 */
export class ServerRestartApi {
    private readonly seams: RestartSeams | undefined;

    /** Production passes nothing; tests inject the timer and the exit. */
    constructor(seams?: RestartSeams) {
        this.seams = seams;
    }

    public async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        if (req.url !== '/api/server/restart' || req.method !== 'POST') return false;

        res.setHeader('Content-Type', 'application/json');
        if (!requireOperator(req, res)) return true;

        log.info('restart requested via /api/server/restart');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        scheduleRestart(Config.getInstance().restartMarkerPath, log, 'restart requested', this.seams);
        return true;
    }
}
