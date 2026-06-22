import { describe, expect, it } from 'vitest';
import { applyFailure, clearedState, extendLock, isLocked, LOCK_MS, WINDOW_MS } from '../loginPolicy';

const base = { failedAttempts: 0, lockoutWindowStart: null as number | null, lockedUntil: null as number | null };

describe('loginPolicy', () => {
    it('locks on the 5th failure inside the 5-minute window', () => {
        let s = base;
        for (let i = 0; i < 4; i++) s = applyFailure(s, 1000);
        expect(s.lockedUntil).toBeNull();
        s = applyFailure(s, 1000);
        expect(s.failedAttempts).toBe(5);
        expect(s.lockedUntil).toBe(1000 + LOCK_MS);
        expect(isLocked(s, 1000)).toBe(true);
    });
    it('resets the counter when the window has elapsed', () => {
        let s = applyFailure(base, 0);
        s = applyFailure(s, WINDOW_MS + 1); // new window
        expect(s.failedAttempts).toBe(1);
        expect(s.lockedUntil).toBeNull();
    });
    it('auto-unlocks after the lock expires', () => {
        const locked = { failedAttempts: 5, lockoutWindowStart: 0, lockedUntil: LOCK_MS };
        expect(isLocked(locked, LOCK_MS - 1)).toBe(true);
        expect(isLocked(locked, LOCK_MS)).toBe(false);
    });
    it('extendLock pushes the unlock 15 min from the latest attempt', () => {
        expect(extendLock(5000).lockedUntil).toBe(5000 + LOCK_MS);
    });
    it('clearedState zeroes everything', () => {
        expect(clearedState()).toEqual({ failedAttempts: 0, lockoutWindowStart: null, lockedUntil: null });
    });
});
