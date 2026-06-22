import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export function hashPassword(plain: string): string {
    const salt = randomBytes(16);
    const hash = scryptSync(plain, salt, KEYLEN, { N, r: R, p: P });
    return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    const salt = Buffer.from(parts[4]!, 'base64');
    const expected = Buffer.from(parts[5]!, 'base64');
    if (expected.length === 0) return false;
    const actual = scryptSync(plain, salt, expected.length, { N: n, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummyHash: string | undefined;
/**
 * Run a verification against a throwaway hash to blind login timing on the
 * unknown-user / disabled-user paths (defeats username enumeration).
 *
 * Cold-start note: the first call warms `dummyHash` via `??=`, which runs
 * hashPassword() once (2 scrypts: one to generate the salt+hash, one inside
 * verifyPassword). Every subsequent call is 1 scrypt — matching the real
 * wrong-password path. This one-time asymmetry on process start is negligible
 * and does NOT constitute a per-username timing oracle.
 */
export function blindVerify(plain: string): void {
    dummyHash ??= hashPassword('timing-blind-dummy-password');
    verifyPassword(plain, dummyHash);
}
