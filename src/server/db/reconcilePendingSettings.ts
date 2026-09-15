import { Logger } from '../Logger';
import type { Db } from './Db';

const log = Logger.for('PendingSettings');
const DEFAULT_RETENTION_DAYS = 90;

/**
 * Boot-time reconciliation of the staged-settings write-ahead log.
 *
 * A row still `pending` means a previous instance died mid-batch. We mark it
 * ABANDONED and never re-apply it: silently applying settings a user may not
 * remember confirming is worse than losing them, and the durable row still
 * explains what happened.
 *
 * Finished rows older than the retention window are pruned so the table stays
 * bounded on a long-lived install.
 */
export function reconcilePendingSettings(
    db: Db,
    retentionDays: number = DEFAULT_RETENTION_DAYS,
): { abandoned: number; pruned: number } {
    const stranded = db.pendingSettings.getPending();
    for (const row of stranded) {
        log.warn(
            `batch ${row.id} was still pending at boot (${row.changes.length} change(s)); ` +
                'marking abandoned and NOT applying it',
        );
        db.pendingSettings.markAbandoned(row.id);
    }
    const pruned = db.pendingSettings.pruneOlderThan(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    return { abandoned: stranded.length, pruned };
}
