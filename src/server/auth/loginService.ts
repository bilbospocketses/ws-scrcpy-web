import type { Db } from '../db/Db';
import { applyFailure, extendLock, isLocked } from './loginPolicy';
import { verifyPassword } from './password';
import { SessionStore } from './session';

export type LoginResult =
    | { ok: true; token: string; userId: number }
    | { ok: false; reason: 'invalid' | 'disabled' | 'locked' };

export function login(db: Db, username: string, password: string, now: number): LoginResult {
    const user = db.users.getByUsername(username);
    if (!user) return { ok: false, reason: 'invalid' };
    if (user.disabled) return { ok: false, reason: 'disabled' };

    const state = {
        failedAttempts: user.failedAttempts,
        lockoutWindowStart: user.lockoutWindowStart,
        lockedUntil: user.lockedUntil,
    };
    if (isLocked(state, now)) {
        db.users.setLockout(user.id, extendLock(now)); // inactivity timer resets on every attempt while locked
        return { ok: false, reason: 'locked' };
    }
    // Lock expired (or never locked): proceed; clear stale lock on expiry.
    if (state.lockedUntil !== null) db.users.clearLockout(user.id);

    if (user.passwordHash && verifyPassword(password, user.passwordHash)) {
        db.users.clearLockout(user.id);
        db.users.setLastLogin(user.id, now);
        const token = new SessionStore(db.sqlite).create(user.id, now);
        return { ok: true, token, userId: user.id };
    }

    const next = applyFailure({ ...state, lockedUntil: null }, now);
    db.users.setLockout(user.id, next);
    return { ok: false, reason: 'invalid' };
}
