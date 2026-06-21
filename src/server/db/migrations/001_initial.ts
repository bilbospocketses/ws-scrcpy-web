import type { DatabaseSync } from 'node:sqlite';
import { IMPLICIT_ADMIN_ID } from '../constants';
import type { Migration } from '../migrations';

const DDL = `
CREATE TABLE users (
    id                   INTEGER PRIMARY KEY,
    username             TEXT    NOT NULL COLLATE NOCASE UNIQUE,
    role                 TEXT    NOT NULL CHECK (role IN ('user','admin')),
    password_hash        TEXT,
    disabled             INTEGER NOT NULL DEFAULT 0,
    failed_attempts      INTEGER NOT NULL DEFAULT 0,
    lockout_window_start INTEGER,
    locked_until         INTEGER,
    created_at           INTEGER NOT NULL,
    last_login_at        INTEGER
);
CREATE TABLE sessions (
    token_hash   TEXT    PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE TABLE user_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key     TEXT    NOT NULL,
    value   TEXT    NOT NULL,
    PRIMARY KEY (user_id, key)
);
CREATE TABLE devices (
    serial       TEXT PRIMARY KEY,
    manufacturer TEXT,
    model        TEXT,
    address      TEXT,
    last_seen_at INTEGER
);
CREATE TABLE device_labels (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    serial  TEXT    NOT NULL,
    label   TEXT    NOT NULL,
    PRIMARY KEY (user_id, serial)
);
CREATE TABLE device_settings (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    udid    TEXT    NOT NULL,
    scope   TEXT    NOT NULL,
    value   TEXT    NOT NULL,
    PRIMARY KEY (user_id, udid, scope)
);
CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
`;

export const migration001: Migration = {
    version: 1,
    up(db: DatabaseSync): void {
        db.exec(DDL);
        // Date.now() is acceptable in app/runtime code (only workflow scripts forbid it).
        const now = Date.now();
        db.prepare('INSERT INTO users (id, username, role, password_hash, created_at) VALUES (?, ?, ?, NULL, ?)').run(
            IMPLICIT_ADMIN_ID,
            'admin',
            'admin',
            now,
        );
        db.prepare("INSERT INTO app_settings (key, value) VALUES ('authEnabled', 'false')").run();
    },
};
