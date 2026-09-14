import type { IncomingMessage, ServerResponse } from 'http';
import { resolveUserId } from '../auth/currentUser';
import { requireOperator } from '../auth/requireOperator';
import { Config } from '../Config';
import type { Change } from '../db/PendingSettingsStore';
import { Logger } from '../Logger';
import { scheduleRestartForPortChange } from './restartRequest';
import { BodyTooLargeError, readBodyCapped } from './utils';

const log = Logger.for('SettingsBatchApi');

/**
 * The change ids a batch may carry.
 *
 * An allowlist, not a denylist: an id absent here is refused outright rather
 * than passed to a writer that might accept it. Actions (install service,
 * delete user, dependency install) are deliberately NOT here -- they fire UAC,
 * destroy data, or carry their own confirmations, and a summary screen that
 * implied Save would perform them would be lying.
 */
export const STAGEABLE_IDS: ReadonlySet<string> = new Set([
    'webPort',
    'channel',
    'autoUpdate',
    'updateCheckIntervalMinutes',
]);

/**
 * `webPort` LAST, always.
 *
 * It is the only change that ends the process: restartRequired -> exit 75 ->
 * the supervisor restarts on the new port. Anything applied after it can be
 * lost, so making it terminal is what guarantees nothing is stranded.
 */
export function orderChanges(changes: Change[]): Change[] {
    return [...changes.filter((c) => c.id !== 'webPort'), ...changes.filter((c) => c.id === 'webPort')];
}

/**
 * Test seams for the webPort restart (`scheduleRestartForPortChange`), mirroring
 * `ServerShutdownApiOptions`. Production leaves both undefined and gets the real
 * `setTimeout` / `process.exit`; tests inject both so a webPort batch never
 * actually schedules a real timer or kills the vitest worker.
 */
export interface SettingsBatchApiOptions {
    /** setTimeout seam -- tests inject to capture the scheduled callback. */
    schedule?: (cb: () => void, ms: number) => unknown;
    /** process.exit seam -- tests inject to avoid killing the worker. */
    exit?: (code: number) => void;
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

        const unknown = changes.find((c) => !STAGEABLE_IDS.has(c.id));
        if (unknown) {
            // Refuse BEFORE writing the WAL row: a rejected batch should leave
            // no trace to reason about later.
            log.warn(`refusing batch containing non-stageable id ${unknown.id}`);
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `not a stageable setting: ${unknown.id}` }));
            return true;
        }

        const cfg = Config.getInstance();
        const batchId = cfg.db.pendingSettings.create(resolveUserId(req), changes);
        const ordered = orderChanges(changes);
        const applied: string[] = [];

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
        const failBatch = (id: string, err: unknown): true => {
            const message = err instanceof Error ? err.message : String(err);
            cfg.db.pendingSettings.markFailed(batchId, `${id}: ${message}`);
            log.warn(`batch ${batchId} failed at ${id}: ${message}`);
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: false, applied, failed: { id, error: message } }));
            return true;
        };

        for (const change of ordered) {
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
                if (result.restartRequired) {
                    scheduleRestartForPortChange(cfg.restartMarkerPath, log, this.seams);
                }
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        ok: true,
                        applied,
                        restartRequired: result.restartRequired,
                        redirectPort: result.restartRequired ? result.config.webPort : undefined,
                    }),
                );
                return true;
            }
            try {
                cfg.updateAppConfig({ [change.id]: change.to } as never);
                applied.push(change.id);
            } catch (err) {
                return failBatch(change.id, err);
            }
        }

        cfg.db.pendingSettings.markCompleted(batchId);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, applied }));
        return true;
    }
}
