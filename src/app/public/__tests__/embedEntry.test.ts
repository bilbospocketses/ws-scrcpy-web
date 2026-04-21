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

    it('accepts only phone/tablet/tv for deviceKind; ignores others', () => {
        expect(parse('device=x&deviceKind=phone').options.deviceKind).toBe('phone');
        expect(parse('device=x&deviceKind=tablet').options.deviceKind).toBe('tablet');
        expect(parse('device=x&deviceKind=tv').options.deviceKind).toBe('tv');
        expect(parse('device=x&deviceKind=watch').options.deviceKind).toBeUndefined();
        expect(parse('device=x').options.deviceKind).toBeUndefined();
    });

    it('accepts only playback/output/mic for audioSource; ignores others', () => {
        expect(parse('device=x&audioSource=playback').options.audioSource).toBe('playback');
        expect(parse('device=x&audioSource=output').options.audioSource).toBe('output');
        expect(parse('device=x&audioSource=mic').options.audioSource).toBe('mic');
        expect(parse('device=x&audioSource=voice-call').options.audioSource).toBeUndefined();
        expect(parse('device=x').options.audioSource).toBeUndefined();
    });

    it('accepts only opus/aac/flac/raw for audioCodec; ignores others', () => {
        expect(parse('device=x&audioCodec=opus').options.audioCodec).toBe('opus');
        expect(parse('device=x&audioCodec=aac').options.audioCodec).toBe('aac');
        expect(parse('device=x&audioCodec=flac').options.audioCodec).toBe('flac');
        expect(parse('device=x&audioCodec=raw').options.audioCodec).toBe('raw');
        expect(parse('device=x&audioCodec=mp3').options.audioCodec).toBeUndefined();
        expect(parse('device=x').options.audioCodec).toBeUndefined();
    });

    it('ignores unknown params', () => {
        expect(() => parse('device=x&mystery=42&another=foo')).not.toThrow();
    });
});
