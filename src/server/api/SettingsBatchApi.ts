import type { IncomingMessage, ServerResponse } from 'http';
import { resolveUserId } from '../auth/currentUser';
import { requireOperator } from '../auth/requireOperator';
import { Config } from '../Config';
import type { Change } from '../db/PendingSettingsStore';
import { Logger } from '../Logger';
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

export class SettingsBatchApi {
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

        for (const change of ordered) {
            if (change.id === 'webPort') {
                // Mark completed BEFORE the change that ends the process. After
                // this apply we may never get another instruction in; a stale
                // 'completed' is inert, whereas a stale 'pending' would be
                // re-applied at the next boot.
                cfg.db.pendingSettings.markCompleted(batchId);
                const result = cfg.updateAppConfig({ webPort: change.to as number });
                applied.push(change.id);
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
                const message = err instanceof Error ? err.message : String(err);
                cfg.db.pendingSettings.markFailed(batchId, `${change.id}: ${message}`);
                log.warn(`batch ${batchId} failed at ${change.id}: ${message}`);
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ ok: false, applied, failed: { id: change.id, error: message } }));
                return true;
            }
        }

        cfg.db.pendingSettings.markCompleted(batchId);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, applied }));
        return true;
    }
}
