import { describe, expect, it } from 'vitest';
import { stringArraysDiffer } from './statsDiff';

describe('stringArraysDiffer (drawStats change detection, #91)', () => {
    it('detects a difference at index 0 (the old loop skipped it)', () => {
        expect(stringArraysDiffer(['a', 'x'], ['b', 'x'])).toBe(true);
    });

    it('detects a difference at the last index without reading past the array', () => {
        expect(stringArraysDiffer(['x', 'a'], ['x', 'b'])).toBe(true);
    });

    it('returns false for identical arrays', () => {
        expect(stringArraysDiffer(['a', 'b'], ['a', 'b'])).toBe(false);
    });

    it('detects a length difference', () => {
        expect(stringArraysDiffer(['a'], ['a', 'b'])).toBe(true);
    });
});
