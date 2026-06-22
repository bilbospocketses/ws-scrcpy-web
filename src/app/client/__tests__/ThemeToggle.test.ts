import { describe, expect, it } from 'vitest';
import { shouldSeedTheme } from '../ThemeToggle';

describe('shouldSeedTheme', () => {
    it('returns false when migration is pending and no stored theme (do not race the migration)', () => {
        expect(shouldSeedTheme(false, false)).toBe(false);
    });

    it('returns true when migration is done and no stored theme (fresh install: safe to seed)', () => {
        expect(shouldSeedTheme(false, true)).toBe(true);
    });

    it('returns false when stored theme present and migration pending (stored theme wins)', () => {
        expect(shouldSeedTheme(true, false)).toBe(false);
    });

    it('returns false when stored theme present and migration done (stored theme wins)', () => {
        expect(shouldSeedTheme(true, true)).toBe(false);
    });
});
