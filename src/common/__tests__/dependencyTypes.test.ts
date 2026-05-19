import { describe, expect, it } from 'vitest';
import { compareVersions } from '../DependencyTypes';

describe('compareVersions', () => {
    it('returns 0 for equal versions', () => {
        expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    });

    it('returns -1 when installed is older', () => {
        expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    });

    it('returns 1 when installed is newer', () => {
        expect(compareVersions('1.3.0', '1.2.4')).toBe(1);
    });

    it('handles different segment lengths', () => {
        expect(compareVersions('35', '35.0.1')).toBe(-1);
    });

    it('returns -1 when either version is null', () => {
        expect(compareVersions(null, '1.0.0')).toBe(-1);
        expect(compareVersions('1.0.0', null)).toBe(-1);
    });

    it('strips leading v from version strings', () => {
        expect(compareVersions('v1.2.3', 'v1.2.3')).toBe(0);
    });
});
