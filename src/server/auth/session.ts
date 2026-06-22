import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes } from 'crypto';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, sliding

export function newToken(): string {
    return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

export class SessionStore {
    constructor(private readonly db: DatabaseSync) {}

    create(userId: number, now: number, ttlMs: number = SESSION_TTL_MS): string {
        const token = newToken();
        this.db
            .prepare(
                'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)',
            )
            .run(hashToken(token), userId, now, now + ttlMs, now);
        return token;
    }

    findValid(token: string, now: number, ttlMs: number = SESSION_TTL_MS): { userId: number } | undefined {
        const row = this.db
            .prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?')
            .get(hashToken(token)) as { user_id: number; expires_at: number } | undefined;
        if (!row) return undefined;
        if (now >= row.expires_at) {
            this.delete(token);
            return undefined;
        }
        this.db
            .prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
            .run(now, now + ttlMs, hashToken(token));
        return { userId: row.user_id };
    }

    delete(token: string): void {
        this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
    }

    deleteForUser(userId: number): void {
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }
}
