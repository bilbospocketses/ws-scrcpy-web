import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../password';

describe('password hashing', () => {
    it('verifies a correct password and rejects a wrong one', () => {
        const h = hashPassword('hunter2');
        expect(h.startsWith('scrypt$16384$8$1$')).toBe(true);
        expect(verifyPassword('hunter2', h)).toBe(true);
        expect(verifyPassword('Hunter2', h)).toBe(false);
    });
    it('produces a distinct salt per call', () => {
        expect(hashPassword('x')).not.toBe(hashPassword('x'));
    });
    it('returns false for a malformed stored hash', () => {
        expect(verifyPassword('x', 'not-a-phc-string')).toBe(false);
    });
});
