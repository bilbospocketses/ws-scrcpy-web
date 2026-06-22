import type { DatabaseSync } from 'node:sqlite';

export type Role = 'user' | 'admin';

export interface User {
    id: number;
    username: string;
    role: Role;
    passwordHash: string | null;
    disabled: boolean;
    failedAttempts: number;
    lockoutWindowStart: number | null;
    lockedUntil: number | null;
    createdAt: number;
    lastLoginAt: number | null;
}

// NOTE: a `type` alias (not `interface`) so it gains an implicit index signature
// and is therefore comparable to node:sqlite's `.all()` return type
// (`Record<string, SQLOutputValue>[]`) without an `as unknown` double-cast.
type UserRow = {
    id: number;
    username: string;
    role: Role;
    password_hash: string | null;
    disabled: number;
    failed_attempts: number;
    lockout_window_start: number | null;
    locked_until: number | null;
    created_at: number;
    last_login_at: number | null;
};

function toUser(r: UserRow): User {
    return {
        id: r.id,
        username: r.username,
        role: r.role,
        passwordHash: r.password_hash,
        disabled: r.disabled === 1,
        failedAttempts: r.failed_attempts,
        lockoutWindowStart: r.lockout_window_start,
        lockedUntil: r.locked_until,
        createdAt: r.created_at,
        lastLoginAt: r.last_login_at,
    };
}

const COLS =
    'id, username, role, password_hash, disabled, failed_attempts, lockout_window_start, locked_until, created_at, last_login_at';

export class UserStore {
    constructor(private readonly db: DatabaseSync) {}

    getById(id: number): User | undefined {
        const r = this.db.prepare(`SELECT ${COLS} FROM users WHERE id = ?`).get(id) as UserRow | undefined;
        return r ? toUser(r) : undefined;
    }

    getByUsername(username: string): User | undefined {
        const r = this.db.prepare(`SELECT ${COLS} FROM users WHERE username = ?`).get(username) as UserRow | undefined;
        return r ? toUser(r) : undefined;
    }

    list(): User[] {
        return (this.db.prepare(`SELECT ${COLS} FROM users ORDER BY id`).all() as UserRow[]).map(toUser);
    }

    create(input: { username: string; role: Role; passwordHash: string | null }): User {
        const now = Date.now();
        const info = this.db
            .prepare('INSERT INTO users (username, role, password_hash, created_at) VALUES (?, ?, ?, ?)')
            .run(input.username, input.role, input.passwordHash, now);
        return this.getById(Number(info.lastInsertRowid))!;
    }

    setPasswordHash(id: number, hash: string): void {
        this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, id);
    }
    setUsername(id: number, username: string): void {
        this.db.prepare('UPDATE users SET username = ? WHERE id = ?').run(username, id);
    }
    setRole(id: number, role: Role): void {
        this.db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id);
    }
    setDisabled(id: number, disabled: boolean): void {
        this.db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
    }
    setLastLogin(id: number, at: number): void {
        this.db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(at, id);
    }
    delete(id: number): void {
        this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    }
    countEnabledAdmins(): number {
        return (
            this.db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0").get() as {
                c: number;
            }
        ).c;
    }
    countEnabledAdminsWithPassword(): number {
        return (
            this.db
                .prepare(
                    "SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0 AND password_hash IS NOT NULL",
                )
                .get() as { c: number }
        ).c;
    }
    setLockout(
        id: number,
        s: { failedAttempts: number; lockoutWindowStart: number | null; lockedUntil: number | null },
    ): void {
        this.db
            .prepare('UPDATE users SET failed_attempts = ?, lockout_window_start = ?, locked_until = ? WHERE id = ?')
            .run(s.failedAttempts, s.lockoutWindowStart, s.lockedUntil, id);
    }
    clearLockout(id: number): void {
        this.db
            .prepare(
                'UPDATE users SET failed_attempts = 0, lockout_window_start = NULL, locked_until = NULL WHERE id = ?',
            )
            .run(id);
    }
}
