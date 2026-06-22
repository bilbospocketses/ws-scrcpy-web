export interface LockoutState {
    failedAttempts: number;
    lockoutWindowStart: number | null;
    lockedUntil: number | null;
}

export const MAX_FAILS = 5;
export const WINDOW_MS = 5 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;

export function isLocked(s: LockoutState, now: number): boolean {
    return s.lockedUntil !== null && now < s.lockedUntil;
}

export function clearedState(): LockoutState {
    return { failedAttempts: 0, lockoutWindowStart: null, lockedUntil: null };
}

export function extendLock(now: number): LockoutState {
    return { failedAttempts: MAX_FAILS, lockoutWindowStart: null, lockedUntil: now + LOCK_MS };
}

export function applyFailure(s: LockoutState, now: number): LockoutState {
    let windowStart = s.lockoutWindowStart;
    let fails = s.failedAttempts;
    if (windowStart === null || now - windowStart > WINDOW_MS) {
        windowStart = now;
        fails = 0;
    }
    fails += 1;
    const lockedUntil = fails >= MAX_FAILS ? now + LOCK_MS : null;
    return { failedAttempts: fails, lockoutWindowStart: windowStart, lockedUntil };
}
