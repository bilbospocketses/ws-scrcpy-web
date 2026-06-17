import { describe, expect, it } from 'vitest';
import { parseWmDensity, parseWmDensityStrict, parseWmSize, parseWmSizeStrict } from '../wmParsers';

describe('parseWmSizeStrict', () => {
    it('parses Physical size', () => {
        expect(parseWmSizeStrict('Physical size: 1080x2400')).toEqual({ width: 1080, height: 2400 });
    });
    it('prefers Override size over Physical size', () => {
        const out = 'Physical size: 1080x2400\nOverride size: 720x1600';
        expect(parseWmSizeStrict(out)).toEqual({ width: 720, height: 1600 });
    });
    it('returns undefined on malformed input', () => {
        expect(parseWmSizeStrict('garbage')).toBeUndefined();
        expect(parseWmSizeStrict('')).toBeUndefined();
    });
});

describe('parseWmSize', () => {
    it('falls back to 1920x1080 on malformed input', () => {
        expect(parseWmSize('garbage')).toEqual({ width: 1920, height: 1080 });
    });
    it('parses valid input the same as strict', () => {
        expect(parseWmSize('Physical size: 1080x2400')).toEqual({ width: 1080, height: 2400 });
    });
});

describe('parseWmDensityStrict', () => {
    it('parses Physical density', () => {
        expect(parseWmDensityStrict('Physical density: 420')).toBe(420);
    });
    it('prefers Override density over Physical density', () => {
        const out = 'Physical density: 420\nOverride density: 320';
        expect(parseWmDensityStrict(out)).toBe(320);
    });
    it('returns undefined on malformed input', () => {
        expect(parseWmDensityStrict('garbage')).toBeUndefined();
    });
});

describe('parseWmDensity', () => {
    it('falls back to 320 on malformed input', () => {
        expect(parseWmDensity('garbage')).toBe(320);
    });
});
