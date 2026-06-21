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
}
