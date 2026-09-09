import { describe, expect, it } from 'vitest';
import { defaultChannelForVersion } from '../ConfigEvents';

// The channel a fresh install defaults to when config.json does not name one.
// Measured 2026-09-09 (qa-harness Arc 3): every build defaulted to 'stable', so a
// fresh beta.103 install asked a beta-only feed for releases.stable.json and sat
// at `status: error … 404` until the Updates radio was flipped.
describe('defaultChannelForVersion', () => {
    it('a -beta.N prerelease defaults to the beta channel', () => {
        expect(defaultChannelForVersion('0.1.30-beta.114')).toBe('beta');
        expect(defaultChannelForVersion('0.1.30-beta.1')).toBe('beta');
        expect(defaultChannelForVersion('v0.1.30-beta.3')).toBe('beta');
    });

    it('a bare -beta tag counts too', () => {
        expect(defaultChannelForVersion('0.2.0-beta')).toBe('beta');
    });

    it('is case-insensitive', () => {
        expect(defaultChannelForVersion('0.1.30-BETA.2')).toBe('beta');
    });

    it('a release build defaults to stable', () => {
        expect(defaultChannelForVersion('0.1.30')).toBe('stable');
        expect(defaultChannelForVersion('1.0.0')).toBe('stable');
    });

    it('other prerelease tags default to stable -- only beta has a feed of its own', () => {
        expect(defaultChannelForVersion('0.1.30-rc.1')).toBe('stable');
        expect(defaultChannelForVersion('0.1.30-alpha.4')).toBe('stable');
    });

    it('does not match "beta" inside another word', () => {
        expect(defaultChannelForVersion('0.1.30-betamax.1')).toBe('stable');
    });

    it('an empty or unknown version defaults to stable', () => {
        expect(defaultChannelForVersion('')).toBe('stable');
        expect(defaultChannelForVersion('0.0.0')).toBe('stable');
    });
});
