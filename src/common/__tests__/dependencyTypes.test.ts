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

    it('treats null as the lowest version (asymmetric)', () => {
        // null = "no version" = lowest. The only case the real caller
        // (DependencyManager.resolveStatus) reaches is a null INSTALLED version
        // vs a non-null latest → -1 (install/update available). The reverse and
        // both-null cases are defensive but must be consistent, not always -1.
        expect(compareVersions(null, '1.0.0')).toBe(-1);
        expect(compareVersions('1.0.0', null)).toBe(1);
        expect(compareVersions(null, null)).toBe(0);
    });

    it('strips leading v from version strings', () => {
        expect(compareVersions('v1.2.3', 'v1.2.3')).toBe(0);
    });

    it('orders a stable release above its prerelease (1.0.0 > 1.0.0-beta)', () => {
        // The bug: `.split('.').map(Number)` turns `30-beta` into NaN, so stable
        // vs beta compared equal/garbage and beta update detection broke.
        expect(compareVersions('0.1.30', '0.1.30-beta.1')).toBe(1);
        expect(compareVersions('0.1.30-beta.1', '0.1.30')).toBe(-1);
    });

    it('orders prerelease identifiers numerically, not as strings', () => {
        expect(compareVersions('0.1.30-beta.2', '0.1.30-beta.10')).toBe(-1);
        expect(compareVersions('0.1.30-beta.10', '0.1.30-beta.2')).toBe(1);
        expect(compareVersions('0.1.30-beta.5', '0.1.30-beta.5')).toBe(0);
    });

    it('orders prerelease tags lexically (alpha < beta)', () => {
        expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    });
});
