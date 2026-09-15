import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations';
import { PendingSettingsStore } from '../PendingSettingsStore';

let db: DatabaseSync;
let store: PendingSettingsStore;

beforeEach(() => {
    db = new DatabaseSync(':memory:');
    runMigrations(db);
    store = new PendingSettingsStore(db);
});

const CHANGES = [
    { id: 'webPort', label: 'Web port', from: 8000, to: 8010 },
    { id: 'channel', label: 'Update channel', from: 'stable', to: 'beta' },
];

describe('PendingSettingsStore', () => {
    it('creates a pending row and reads it back with its changes intact', () => {
        const id = store.create(1, CHANGES);
        const pending = store.getPending();
        expect(pending).toHaveLength(1);
        expect(pending[0]!.id).toBe(id);
        expect(pending[0]!.status).toBe('pending');
        expect(pending[0]!.userId).toBe(1);
        expect(pending[0]!.changes).toEqual(CHANGES);
    });

    it('a completed row is no longer pending', () => {
        const id = store.create(1, CHANGES);
        store.markCompleted(id);
        expect(store.getPending()).toHaveLength(0);
    });

    it('a failed row records why and stops being pending', () => {
        const id = store.create(1, CHANGES);
        store.markFailed(id, 'webPort must be an integer between 1024 and 65535');
        expect(store.getPending()).toHaveLength(0);
    });

    it('marks a row abandoned — the boot path for a batch nobody finished', () => {
        const id = store.create(1, CHANGES);
        store.markAbandoned(id);
        expect(store.getPending()).toHaveLength(0);
        // The literal status, not just "no longer pending": `markCompleted` would
        // satisfy that weaker check too, and a boot row recorded as `completed`
        // claims a write that never happened. This is the assertion that makes
        // `reconcilePendingSettings` marking ABANDONED a tested fact.
        const row = db.prepare('SELECT status FROM pending_settings WHERE id = ?').get(id) as { status: string };
        expect(row.status).toBe('abandoned');
    });

    it('prunes only finished rows older than the cutoff, never pending ones', () => {
        const old = store.create(1, CHANGES);
        store.markCompleted(old);
        db.prepare('UPDATE pending_settings SET created_at = ? WHERE id = ?').run(1000, old);
        const live = store.create(1, CHANGES);

        expect(store.pruneOlderThan(2000)).toBe(1);
        expect(store.getPending().map((r) => r.id)).toEqual([live]);
    });
});
