import type { IncomingMessage, ServerResponse } from 'http';
import { FRAME_ANCESTORS_ADD_ID, IPV6_EMBEDDER_ERROR } from '../../common/embedderOrigin';
import { resolveUserId } from '../auth/currentUser';
import { requireOperator } from '../auth/requireOperator';
import { Config, validateHttpsPortInput } from '../Config';
import type { Change } from '../db/PendingSettingsStore';
import { Logger } from '../Logger';
import { isIpv6FrameAncestor, parseFrameAncestorOrigin } from '../security/frameGuard';
import { isLoopback } from '../security/loopback';
import { applyUpdaterConfigChange, type UpdaterControls } from '../updaterConfigSync';
import { hostOnlyConfigKeys, refuseInContainer } from './containerGuard';
import { EMBED_DECIDED_LOCALLY_ERROR } from './EmbedRequestApi';
import { scheduleRestartForPortChange } from './restartRequest';
import { type SystemServicePortGuardDeps, systemServicePortRefusal } from './systemServicePortGuard';
import { BodyTooLargeError, readBodyCapped } from './utils';

const log = Logger.for('SettingsBatchApi');

/** The staged id for the https port (the Server tab's `https port` row). */
export const HTTPS_PORT_ID = 'httpsPort';

/**
 * The change ids a batch may carry.
 *
 * An allowlist, not a denylist: an id absent here is refused outright rather
 * than passed to a writer that might accept it. Actions (install service,
 * delete user, dependency install) are deliberately NOT here -- they fire UAC,
 * destroy data, or carry their own confirmations, and a summary screen that
 * implied Save would perform them would be lying.
 *
 * `frameAncestorsAdd` (0.5.3) is Settings → Embedding's pre-approval: origins
 * to ADD to `frameAncestors`, staged in the dialog and written only by Save.
 * It is not an `AppConfig` key, so the apply loop routes it to
 * `Config.addFrameAncestors` -- the store a consent-prompt approval writes --
 * rather than `updateAppConfig`, and it carries the consent routes' loopback
 * rule on top of this route's operator gate (see `frameAncestorsAddRefusal`
 * and the check in `handle`). Revoking an origin stays an immediate action.
 *
 * `httpsPort` (after 0.5.3) is the Server tab's https port, the port the Local
 * HTTPS listener binds. Like `frameAncestorsAdd` it is not an `AppConfig` key:
 * the apply loop routes it to `Config.setHttpsPort` (the same writer
 * `POST /api/tls/https-port` uses), validated by `validateHttpsPortInput`, and
 * a container refuses it with the `/api/tls/*` copy, since Local HTTPS does not
 * exist there.
 */
export const STAGEABLE_IDS: ReadonlySet<string> = new Set([
    'webPort',
    HTTPS_PORT_ID,
    'channel',
    'autoUpdate',
    'updateCheckIntervalMinutes',
    'githubOwner',
    FRAME_ANCESTORS_ADD_ID,
]);

/**
 * At most this many origins in one `frameAncestorsAdd`. The tab adds one or two
 * per click, so a real save is far below it; the cap only bounds what a crafted
 * request can make the server validate and write.
 */
export const MAX_FRAME_ANCESTORS_PER_ADD = 32;

/**
 * Why a `frameAncestorsAdd` value is unusable, or null when it is a list of
 * 1-32 strings that `parseFrameAncestorOrigin` accepts -- the same validator the
 * config loader and the consent prompt use, so an origin is held to one
 * standard however it arrives. Pure; checked before the WAL row is written.
 */
export function frameAncestorsAddRefusal(to: unknown): string | null {
    if (!Array.isArray(to)) return 'must be a list of origins';
    if (to.length === 0) return 'no origins to add';
    if (to.length > MAX_FRAME_ANCESTORS_PER_ADD) {
        return `at most ${MAX_FRAME_ANCESTORS_PER_ADD} origins can be added in one save`;
    }
    for (const entry of to) {
        if (typeof entry === 'string' && isIpv6FrameAncestor(entry)) {
            // Its own reason: a browser discards an IPv6 frame-ancestors source.
            return `${JSON.stringify(entry)}: ${IPV6_EMBEDDER_ERROR}`;
        }
        if (typeof entry !== 'string' || parseFrameAncestorOrigin(entry) === null) {
            return `not an http(s) origin with no path: ${JSON.stringify(entry)}`;
        }
    }
    return null;
}

/** The refusal for a batch that would leave the http and https ports equal. */
export function portCollisionError(port: number): string {
    return `the http and https ports must differ (both would be ${port})`;
}

/**
 * `webPort` LAST, always, with `httpsPort` straight before it.
 *
 * `webPort` is the change that ends the process: restartRequired -> exit 75 ->
 * the supervisor restarts on the new port. Anything applied after it can be
 * lost, so making it terminal is what guarantees nothing is stranded.
 * `httpsPort` needs that same restart, so it goes second to last: everything
 * that can still refuse has had its turn before it is written, leaving only
 * `webPort` after it.
 */
export function orderChanges(changes: Change[]): Change[] {
    const isPort = (c: Change): boolean => c.id === 'webPort' || c.id === HTTPS_PORT_ID;
    return [
        ...changes.filter((c) => !isPort(c)),
        ...changes.filter((c) => c.id === HTTPS_PORT_ID),
        ...changes.filter((c) => c.id === 'webPort'),
    ];
}

/**
 * Test seams for the webPort restart (`scheduleRestartForPortChange`), mirroring
 * `ServerShutdownApiOptions`. Production leaves both undefined and gets the real
 * `setTimeout` / `process.exit`; tests inject both so a webPort batch never
 * actually schedules a real timer or kills the vitest worker.
 */
export interface SettingsBatchApiOptions extends SystemServicePortGuardDeps {
    /** setTimeout seam -- tests inject to capture the scheduled callback. */
    schedule?: (cb: () => void, ms: number) => unknown;
    /** process.exit seam -- tests inject to avoid killing the worker. */
    exit?: (code: number) => void;
    /**
     * The RUNNING update service, told about a saved channel, owner or interval
     * (`applyUpdaterConfigChange`). Production hands in the same `UpdateService`
     * `UpdatesApi` gets (index.ts); tests hand in spies. Absent, a batch only
     * writes config -- which is exactly the 6.11 bug, so only a test that does
     * not care about the updater should leave it out.
     */
    updater?: UpdaterControls;
}

export class SettingsBatchApi {
    constructor(private readonly seams: SettingsBatchApiOptions = {}) {}

    public async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        if (req.url !== '/api/settings/batch' || req.method !== 'POST') return false;
        if (!requireOperator(req, res)) return true;

        let changes: Change[];
        try {
            const parsed = JSON.parse(await readBodyCapped(req)) as { changes?: Change[] };
            changes = parsed.changes ?? [];
        } catch (err) {
            if (err instanceof BodyTooLargeError) {
                res.writeHead(413, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'body too large' }));
                return true;
            }
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'malformed body' }));
            return true;
        }

        // Shape-check BEFORE the scan below, which reads `c.id` off every
        // element. A non-array `changes`, or an array holding a null, threw
        // there -- outside the try/catch above -- and surfaced as a generic 500
        // from the caller's error handler, reporting a server fault for what is
        // simply a malformed request. Reachable only by a crafted operator
        // request, since the real client always sends `store.changes()`.
        if (!Array.isArray(changes) || changes.some((c) => c === null || typeof c !== 'object')) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'changes must be an array of change objects' }));
            return true;
        }

        // A change with no `to` is refused rather than applied. `updateAppConfig`
        // SKIPS an undefined value (Config.ts, `if (value === undefined) continue`)
        // without complaining, so such a change fell through to `applied.push`
        // and a `completed` WAL row -- an audit trail asserting a write that
        // never happened, which is the one thing the marks either side of the
        // apply exist to prevent. Note `undefined`, not falsy: `to: false` and
        // `to: 0` are real values. JSON drops an explicit `to: undefined`, so
        // this catches both the absent key and the explicit one.
        const valueless = changes.find((c) => c.to === undefined);
        if (valueless) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `change has no value: ${valueless.id}` }));
            return true;
        }

        const unknown = changes.find((c) => !STAGEABLE_IDS.has(c.id));
        if (unknown) {
            // Refuse BEFORE writing the WAL row: a rejected batch should leave
            // no trace to reason about later.
            log.warn(`refusing batch containing non-stageable id ${unknown.id}`);
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `not a stageable setting: ${unknown.id}` }));
            return true;
        }

        // A pre-approved embedder (Settings → Embedding) is the same decision as
        // approving a consent prompt, so it carries that decision's rule as well
        // as this route's: from this machine only. `requireOperator` above has
        // already established an admin, but it also admits a signed-in admin or
        // the remote-admin opt-out from off-box, which the consent routes
        // (`EmbedRequestApi.requireLocalAdmin`) deliberately do not. Then the
        // value itself, through `parseFrameAncestorOrigin`. Both are refused
        // before the WAL row, in the rejected-apply shape, so the dialog names
        // the change ("couldn't save Allowed embedders: …") and nothing else in
        // the batch has been applied.
        for (const embed of changes.filter((c) => c.id === FRAME_ANCESTORS_ADD_ID)) {
            if (!isLoopback(req.socket?.remoteAddress ?? '')) {
                log.warn('refusing batch: an embedder pre-approval from off this machine');
                res.writeHead(403, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        ok: false,
                        applied: [],
                        failed: { id: embed.id, error: EMBED_DECIDED_LOCALLY_ERROR },
                    }),
                );
                return true;
            }
            const refusal = frameAncestorsAddRefusal(embed.to);
            if (refusal) {
                log.warn(`refusing batch: ${embed.id} ${refusal}`);
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, applied: [], failed: { id: embed.id, error: refusal } }));
                return true;
            }
        }

        // The web port and the updater's settings are host-only, so a container
        // refuses the batch before its WAL row (container audit).
        const hostOnly = hostOnlyConfigKeys(changes.map((c) => c.id));
        if (hostOnly.length > 0 && refuseInContainer(res, `change ${hostOnly.join(', ')}`, 'docker-settings')) {
            return true;
        }
        // The https port belongs to Local HTTPS, which a container does not
        // support (user decision 2026-09-30): refused with the very copy every
        // `/api/tls/*` route answers there (TlsApi.ts), before the WAL row.
        const httpsChange = changes.find((c) => c.id === HTTPS_PORT_ID);
        if (httpsChange && refuseInContainer(res, 'Local HTTPS', 'reverse-proxy')) {
            return true;
        }

        const cfg = Config.getInstance();

        // The https port is validated here, before the WAL row and before any
        // sibling is applied, in the rejected-apply shape the dialog names
        // ("couldn't save HTTPS port: …"). `validateHttpsPortInput` is the rule
        // `POST /api/tls/https-port` applies: an integer from 1 to 65535.
        let httpsPortTarget: number | null = null;
        if (httpsChange) {
            const validated = validateHttpsPortInput(httpsChange.to);
            if (!validated.ok) {
                log.warn(`refusing batch: ${HTTPS_PORT_ID} ${validated.error}`);
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({ ok: false, applied: [], failed: { id: HTTPS_PORT_ID, error: validated.error } }),
                );
                return true;
            }
            httpsPortTarget = validated.value;
        }

        // The two listeners cannot share a port: an http listener on the https
        // port wins and Local HTTPS is dropped for that boot (Config.buildServers,
        // `httpsCollisionWarning`). Refused as a whole, before anything is
        // applied, whichever side of the batch moved -- the dialog refuses it
        // too, so only a hand-built request reaches this.
        const portChange = changes.find((c) => c.id === 'webPort');
        if (httpsChange || portChange) {
            const webPortAfter = portChange ? portChange.to : cfg.getAppConfig().webPort;
            const httpsPortAfter = httpsPortTarget ?? cfg.httpsPort;
            if (webPortAfter === httpsPortAfter) {
                const id = httpsChange ? HTTPS_PORT_ID : 'webPort';
                const error = portCollisionError(httpsPortAfter);
                log.warn(`refusing batch: ${error}`);
                res.writeHead(409, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, applied: [], failed: { id, error } }));
                return true;
            }
        }

        // The Linux system service binds its port exactly, so a busy one is
        // refused here, BEFORE the WAL row and before any sibling change is
        // applied: webPort is applied last, and refusing it there would leave the
        // rest of the batch half-landed. Answered in the rejected-apply shape,
        // which the Settings dialog shows as "couldn't save HTTP port: <why>".
        if (portChange) {
            const refusal = await systemServicePortRefusal(
                portChange.to,
                cfg.servers.map((s) => s.port),
                this.seams,
            );
            if (refusal) {
                log.warn(`refusing batch: ${refusal}`);
                res.writeHead(409, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, applied: [], failed: { id: 'webPort', error: refusal } }));
                return true;
            }
        }

        const batchId = cfg.db.pendingSettings.create(resolveUserId(req), changes);
        const ordered = orderChanges(changes);
        const applied: string[] = [];

        /**
         * Tell the RUNNING update service what this batch changed (smoke row
         * 6.11, qa-harness): the config before the first apply against the
         * config now. Without it a saved interval or channel sat in config.json
         * while the service kept the old timer and the old channel until restart.
         *
         * Called on every exit that may have written something -- the clean
         * finish, and a failure partway (a sibling that landed before the failing
         * change is just as real) -- but NOT when the batch moved the port: that
         * process ends a second later and the next one's `UpdateService.init()`
         * reads the new values from config.json, so the call would only start a
         * check the exit cuts off.
         *
         * Not awaited. `reconfigure` resolves only when the check it starts is
         * over, which on Windows with automatic updates on includes downloading
         * the whole package; the Save must not hang on that. Its outcome lands in
         * the service state GET /api/updates/status reports, as with any check.
         * A container never gets here with an updater id: the container refusal
         * above answers 409 for all of them before anything is applied.
         */
        const before = cfg.getAppConfig();
        const notifyUpdater = (): void => {
            const updater = this.seams.updater;
            if (!updater) return;
            applyUpdaterConfigChange(updater, before, cfg.getAppConfig()).catch((err: unknown) => {
                const message = err instanceof Error ? err.message : String(err);
                log.warn(`batch ${batchId}: the update service did not take the new settings: ${message}`);
            });
        };

        /**
         * One rejected apply: mark the WAL row failed, answer 400, end the batch.
         *
         * Shared by both apply paths rather than written twice, so webPort cannot
         * drift away from the shape every other change already answers with.
         * `updateAppConfig` validates through `validateField` and THROWS
         * `ConfigValidationError`; reaching it with a bad value is now possible
         * from the UI, since the per-field Save that used to pre-screen the port
         * is gone.
         */
        /**
         * True once this batch has written an https port that differs from the
         * one configured before it. The https listener is built once at boot
         * and nothing rebinds it in-process (Config.setHttpsPort), so a moved
         * https port needs the same restart a moved web port does -- and ONE
         * restart covers both.
         */
        let httpsPortMoved = false;

        /**
         * A failure after the https port was written: only `webPort` comes after
         * it (`orderChanges`), so this is a web port the config refused. The new
         * https port is on disk and is applied, so the restart it needs is still
         * scheduled rather than left for some later, unrelated restart.
         */
        const failBatch = (id: string, err: unknown): true => {
            const message = err instanceof Error ? err.message : String(err);
            cfg.db.pendingSettings.markFailed(batchId, `${id}: ${message}`);
            log.warn(`batch ${batchId} failed at ${id}: ${message}`);
            if (httpsPortMoved) {
                scheduleRestartForPortChange(cfg.restartMarkerPath, log, this.seams);
            } else {
                notifyUpdater();
            }
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    ok: false,
                    applied,
                    failed: { id, error: message },
                    ...(httpsPortMoved ? { restartRequired: true } : {}),
                }),
            );
            return true;
        };

        for (const change of ordered) {
            if (change.id === HTTPS_PORT_ID) {
                // Validated before the WAL row, so `httpsPortTarget` is set.
                const port = httpsPortTarget as number;
                const previous = cfg.httpsPort;
                try {
                    cfg.setHttpsPort(port);
                } catch (err) {
                    return failBatch(change.id, err);
                }
                applied.push(change.id);
                httpsPortMoved = port !== previous;
                continue;
            }
            if (change.id === 'webPort') {
                let result: ReturnType<typeof cfg.updateAppConfig>;
                try {
                    result = cfg.updateAppConfig({ webPort: change.to as number });
                } catch (err) {
                    // A rejected port must NOT leave a 'completed' audit row
                    // claiming a write that never happened.
                    return failBatch(change.id, err);
                }
                applied.push(change.id);
                // The config write has succeeded; mark completed BEFORE the step
                // that ends the process — the scheduled restart below. Past that
                // point we may never get another instruction in, and the row
                // would still say 'pending' when the process dies. Boot does not
                // re-apply such a row (`reconcilePendingSettings` marks it
                // 'abandoned' and deliberately never replays it), so the harm is
                // not a double-apply — it is an audit trail that says a change
                // was ABANDONED when it had in fact already been written to
                // config.json, which is the record someone reads to explain why
                // the port moved. A 'completed' row written here is inert by
                // comparison: it describes a write that did happen.
                cfg.db.pendingSettings.markCompleted(batchId);
                // One restart whichever port moved. `redirectPort` stays the
                // web port's alone: the browser follows the http port, and a
                // moved https port alone leaves it where it is.
                const restartRequired = result.restartRequired || httpsPortMoved;
                if (restartRequired) {
                    scheduleRestartForPortChange(cfg.restartMarkerPath, log, this.seams);
                } else {
                    // Neither port moved, so this process lives on.
                    notifyUpdater();
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        ok: true,
                        applied,
                        restartRequired,
                        redirectPort: result.restartRequired ? result.config.webPort : undefined,
                    }),
                );
                return true;
            }
            if (change.id === FRAME_ANCESTORS_ADD_ID) {
                // The consent prompt's store, not AppConfig: applied to the
                // running server and written to config.json's `frameAncestors`
                // in one step, all or nothing. Validated above, so a false here
                // is not expected; it is still a refusal rather than an
                // `applied` entry, so the WAL never claims a write that did not
                // happen.
                const origins = change.to as string[];
                try {
                    if (!cfg.addFrameAncestors(origins)) {
                        return failBatch(change.id, new Error('not a usable frame ancestor'));
                    }
                } catch (err) {
                    return failBatch(change.id, err);
                }
                applied.push(change.id);
                log.info(`Embedding pre-approved in Settings for ${origins.join(', ')}`);
                continue;
            }
            try {
                cfg.updateAppConfig({ [change.id]: change.to } as never);
                applied.push(change.id);
            } catch (err) {
                return failBatch(change.id, err);
            }
        }

        cfg.db.pendingSettings.markCompleted(batchId);
        if (httpsPortMoved) {
            // Completed first, as on the webPort path: the restart ends the process.
            scheduleRestartForPortChange(cfg.restartMarkerPath, log, this.seams);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, applied, restartRequired: true }));
            return true;
        }
        notifyUpdater();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, applied }));
        return true;
    }
}
