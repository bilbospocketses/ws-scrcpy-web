import { describe, expect, it } from 'vitest';
import { classifyDeviceKind } from '../deviceKind';

describe('classifyDeviceKind', () => {
    it('classifies TV from ro.build.characteristics', () => {
        expect(classifyDeviceKind('tv,default', 'false', 'Physical size: 1920x1080', 'Physical density: 320')).toBe(
            'tv',
        );
    });

    it('classifies TV from pm has-feature leanback even when characteristics say default', () => {
        expect(classifyDeviceKind('default', 'true\n', 'Physical size: 1920x1080', 'Physical density: 320')).toBe('tv');
    });

    it('classifies tablet at smallestWidthDp >= 600', () => {
        // 2560x1600 @ 320dpi → smallestDp = min(2560,1600)/2 = 800
        expect(classifyDeviceKind('default', 'false', 'Physical size: 2560x1600', 'Physical density: 320')).toBe(
            'tablet',
        );
    });

    it('classifies phone at smallestWidthDp < 600', () => {
        // 1080x2400 @ 420dpi → smallestDp = 1080/(420/160) ≈ 411
        expect(classifyDeviceKind('default', 'false', 'Physical size: 1080x2400', 'Physical density: 420')).toBe(
            'phone',
        );
    });

    it('does not false-positive on "tablet" in characteristics', () => {
        // Word boundary: "tablet,nosdcard" must not match the tv regex
        expect(
            classifyDeviceKind('tablet,nosdcard', 'false', 'Physical size: 1080x2400', 'Physical density: 420'),
        ).toBe('phone');
    });

    it('does not false-positive on values containing "tv" as substring', () => {
        // "notv" or "stv" should not match — \btv\b word boundary
        expect(classifyDeviceKind('notv,default', 'false', 'Physical size: 1080x2400', 'Physical density: 420')).toBe(
            'phone',
        );
    });

    it('returns undefined on empty characteristics + empty leanback + unparseable wm output', () => {
        expect(classifyDeviceKind('', '', 'garbage', 'garbage')).toBeUndefined();
    });

    it('treats trailing whitespace in leanback output correctly', () => {
        expect(classifyDeviceKind('default', '  true  \r\n', 'Physical size: 1080x2400', 'Physical density: 420')).toBe(
            'tv',
        );
    });

    it('handles boundary case smallestWidthDp === 600 as tablet', () => {
        // 600dp @ 160dpi = 600px smallest side. Use 600x1200 @ 160dpi
        expect(classifyDeviceKind('default', 'false', 'Physical size: 600x1200', 'Physical density: 160')).toBe(
            'tablet',
        );
    });

    it('still classifies phone when leanback call fails and is empty', () => {
        // Some Android versions exit non-zero from `pm has-feature` when the feature
        // is absent; our caller catches per-call and passes '' when that happens.
        expect(classifyDeviceKind('nosdcard', '', 'Physical size: 1080x2424', 'Physical density: 420')).toBe('phone');
    });
});
