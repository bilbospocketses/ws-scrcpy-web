import type { DatabaseSync } from 'node:sqlite';
import type { Migration } from '../migrations';

// The write-ahead log for a staged settings batch (item 127).
//
// It lives in SQLite rather than browser storage because a webPort change moves
// the server to a new PORT, which is a different ORIGIN -- localStorage from the
// old origin is unreadable after the redirect. The data root survives both the
// restart and the origin change, so this table is the only place a batch can be
// recorded across it.
const DDL = `
CREATE TABLE pending_settings (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    status     TEXT    NOT NULL CHECK (status IN ('pending','completed','failed','abandoned')),
    changes    TEXT    NOT NULL,
    error      TEXT
);
CREATE INDEX idx_pending_settings_status ON pending_settings(status);
`;

export const migration002: Migration = {
    version: 2,
    up(db: DatabaseSync): void {
        db.exec(DDL);
    },
};
