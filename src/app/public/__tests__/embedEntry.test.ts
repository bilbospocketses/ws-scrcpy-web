// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { parseEmbedParams } from '../embed-entry';

describe('parseEmbedParams', () => {
    const parse = (q: string) => parseEmbedParams(new URLSearchParams(q));

    it('returns null deviceId when missing', () => {
        expect(parse('')).toEqual({ deviceId: null, options: {} });
    });

    it('reads deviceId from "device" param', () => {
        expect(parse('device=abc').deviceId).toBe('abc');
    });

    it('parses string params', () => {
        const { options } = parse('device=x&host=foo&encoder=c2.mtk&pathname=/p');
        expect(options.host).toBe('foo');
        expect(options.encoder).toBe('c2.mtk');
        expect(options.pathname).toBe('/p');
    });

    it('parses integer params and ignores NaN', () => {
        const { options } = parse('device=x&port=8000&bitrate=abc&maxFps=30');
        expect(options.port).toBe(8000);
        expect(options.bitrate).toBeUndefined();
        expect(options.maxFps).toBe(30);
    });

    it('parses boolean params', () => {
        const { options } = parse('device=x&secure=true&audio=false&keyboard=true');
        expect(options.secure).toBe(true);
        expect(options.audio).toBe(false);
        expect(options.keyboard).toBe(true);
    });

    it('accepts only h264/h265/av1 for codec; ignores others', () => {
        expect(parse('device=x&codec=h265').options.codec).toBe('h265');
        expect(parse('device=x&codec=bogus').options.codec).toBeUndefined();
    });

    it('ignores unknown params', () => {
        expect(() => parse('device=x&mystery=42&another=foo')).not.toThrow();
    });
});
