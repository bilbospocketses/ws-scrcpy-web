import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyRuntimeBytes } from './swap-appimage-runtime.mjs';

describe('swap-appimage-runtime verifyRuntimeBytes', () => {
    it('returns the buffer when the SHA-256 matches', () => {
        const buf = Buffer.from('a fake runtime');
        const sha = createHash('sha256').update(buf).digest('hex');
        expect(verifyRuntimeBytes(buf, sha)).toBe(buf);
    });

    it('throws when the SHA-256 does not match (tampered or changed runtime)', () => {
        const buf = Buffer.from('a fake runtime');
        expect(() => verifyRuntimeBytes(buf, 'deadbeef')).toThrow(/mismatch/i);
    });
});
