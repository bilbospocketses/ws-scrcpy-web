import type { DatabaseSync } from 'node:sqlite';

export type BatchStatus = 'pending' | 'completed' | 'failed' | 'abandoned';

/**
 * One staged edit, as the batch applies it and the WAL records it.
 *
 * Declared here as well as client-side (`settings/StagedSettingsStore.ts`)
 * because importing a `node:sqlite` module into the browser bundle would be
 * wrong; the two shapes are deliberately identical.
 *
 * `to` is the RAW value and is what `updateAppConfig` receives -- it must
 * survive `validateField`, so a boolean setting arrives as a boolean. The two
 * text fields are display-only, written by the client's formatter and never
 * read here; they are carried so the WAL row records what the user was shown.
 */
export interface Change {
    id: string;
    label: string;
    from: unknown;
    to: unknown;
    fromText?: string;
    toText?: string;
}

export interface BatchRow {
    id: number;
    userId: number;
    createdAt: number;
    status: BatchStatus;
    changes: Change[];
    error: string | null;
}

interface RawRow {
    id: number;
    user_id: number;
    created_at: number;
    status: BatchStatus;
    changes: string;
    error: string | null;
}

/**
 * The write-ahead log for staged settings batches.
 *
 * `create` before applying, then exactly one terminal mark. `getPending` is read
 * at boot: a row still pending means a previous instance died mid-batch.
 */
export class PendingSettingsStore {
    constructor(private readonly db: DatabaseSync) {}

    create(userId: number, changes: Change[]): number {
        const info = this.db
            .prepare('INSERT INTO pending_settings (user_id, created_at, status, changes) VALUES (?, ?, ?, ?)')
            .run(userId, Date.now(), 'pending', JSON.stringify(changes));
        return Number(info.lastInsertRowid);
    }

    markCompleted(id: number): void {
        this.setStatus(id, 'completed', null);
    }

    markFailed(id: number, error: string): void {
        this.setStatus(id, 'failed', error);
    }

    markAbandoned(id: number): void {
        this.setStatus(id, 'abandoned', null);
    }

    getPending(): BatchRow[] {
        const rows = this.db
            .prepare("SELECT * FROM pending_settings WHERE status = 'pending' ORDER BY id")
            .all() as unknown as RawRow[];
        return rows.map((r) => ({
            id: r.id,
            userId: r.user_id,
            createdAt: r.created_at,
            status: r.status,
            changes: JSON.parse(r.changes) as Change[],
            error: r.error,
        }));
    }

    /** Delete FINISHED rows older than the cutoff. Pending rows are never pruned. */
    pruneOlderThan(cutoffMs: number): number {
        const info = this.db
            .prepare("DELETE FROM pending_settings WHERE status != 'pending' AND created_at < ?")
            .run(cutoffMs);
        return Number(info.changes);
    }

    private setStatus(id: number, status: BatchStatus, error: string | null): void {
        this.db.prepare('UPDATE pending_settings SET status = ?, error = ? WHERE id = ?').run(status, error, id);
    }
}
