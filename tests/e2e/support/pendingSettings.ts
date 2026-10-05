import { DatabaseSync } from 'node:sqlite';

/**
 * The settings write-ahead log, `pending_settings` in a private server's
 * database: what a staged Save records before it applies, and what a server
 * killed mid-apply leaves for the next boot to find.
 */

export interface WalRow {
    id: number;
    status: string;
    changes: { id: string; to: unknown }[];
    error: string | null;
}

function openDb(dbPath: string): DatabaseSync {
    try {
        return new DatabaseSync(dbPath, { readOnly: true });
    } catch {
        return new DatabaseSync(dbPath);
    }
}

/** Every row of the batch WAL, oldest first. Opened and closed per call. */
export function walRows(dbPath: string): WalRow[] {
    const db = openDb(dbPath);
    try {
        const rows = db.prepare('SELECT id, status, changes, error FROM pending_settings ORDER BY id').all() as {
            id: number;
            status: string;
            changes: string;
            error: string | null;
        }[];
        return rows.map((r) => ({
            id: r.id,
            status: r.status,
            changes: JSON.parse(r.changes) as WalRow['changes'],
            error: r.error,
        }));
    } finally {
        db.close();
    }
}

/**
 * Leave behind exactly what a server killed mid-apply leaves: a row still
 * `pending`. Only ever called while the server is STOPPED.
 *
 * The real kill cannot be timed from outside — the apply loop is synchronous
 * between `create` and `markCompleted` — so the spec plants its residue
 * instead and asserts what the next boot does with it.
 */
export function plantPendingBatch(dbPath: string, changes: { id: string; label: string; to: unknown }[]): number {
    const db = new DatabaseSync(dbPath);
    try {
        const info = db
            .prepare('INSERT INTO pending_settings (user_id, created_at, status, changes) VALUES (?, ?, ?, ?)')
            .run(1, Date.now(), 'pending', JSON.stringify(changes.map((c) => ({ ...c, from: null }))));
        return Number(info.lastInsertRowid);
    } finally {
        db.close();
    }
}
