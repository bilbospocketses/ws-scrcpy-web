import { describe, expect, it } from 'vitest';
import { applyStreamParams } from '../StreamUrlParams';

function make(): URL {
    return new URL('ws://example/');
}

describe('applyStreamParams — audioSource', () => {
    it('serializes audioSource when set', () => {
        const url = make();
        applyStreamParams(url, { udid: 'x', audioSource: 'playback' });
        expect(url.searchParams.get('audioSource')).toBe('playback');
    });

    it('omits audioSource when undefined', () => {
        const url = make();
        applyStreamParams(url, { udid: 'x' });
        expect(url.searchParams.has('audioSource')).toBe(false);
    });
});

describe('applyStreamParams — audio flag', () => {
    it('serializes audioEnabled=true as audio=true', () => {
        const url = make();
        applyStreamParams(url, { udid: 'x', audioEnabled: true });
        expect(url.searchParams.get('audio')).toBe('true');
    });

    it('serializes audioEnabled=false as audio=false', () => {
        const url = make();
        applyStreamParams(url, { udid: 'x', audioEnabled: false });
        expect(url.searchParams.get('audio')).toBe('false');
    });

    it('omits audio when audioEnabled is undefined', () => {
        const url = make();
        applyStreamParams(url, { udid: 'x' });
        expect(url.searchParams.has('audio')).toBe(false);
    });
});

describe('applyStreamParams — passthrough of existing params', () => {
    it('sets udid and action', () => {
        const url = make();
        applyStreamParams(url, { udid: 'abc:5555' });
        expect(url.searchParams.get('udid')).toBe('abc:5555');
        expect(url.searchParams.get('action')).toBe('stream');
    });

    it('skips default video codec (h264) and default audio codec (opus)', () => {
        const url = make();
        applyStreamParams(url, { udid: 'x', videoCodec: 'h264', audioCodec: 'opus' });
        expect(url.searchParams.has('videoCodec')).toBe(false);
        expect(url.searchParams.has('audioCodec')).toBe(false);
    });

    it('serializes non-default codecs', () => {
        const url = make();
        applyStreamParams(url, { udid: 'x', videoCodec: 'h265', audioCodec: 'aac' });
        expect(url.searchParams.get('videoCodec')).toBe('h265');
        expect(url.searchParams.get('audioCodec')).toBe('aac');
    });

    it('serializes encoderName when set', () => {
        const url = make();
        applyStreamParams(url, { udid: 'x', encoderName: 'c2.qti.hevc.encoder' });
        expect(url.searchParams.get('videoEncoder')).toBe('c2.qti.hevc.encoder');
    });

    it('serializes video-settings when supplied', () => {
        const url = make();
        applyStreamParams(
            url,
            { udid: 'x' },
            { bitrate: 4000000, maxFps: 30, bounds: { width: 1920, height: 1080 }, displayId: 0 },
        );
        expect(url.searchParams.get('bitrate')).toBe('4000000');
        expect(url.searchParams.get('maxFps')).toBe('30');
        expect(url.searchParams.get('maxSize')).toBe('1920');
        expect(url.searchParams.has('displayId')).toBe(false); // displayId=0 is default, not emitted
    });
});
