import { describe, expect, it } from 'vitest';
import { scrcpyOptionsFromQuery } from '../scrcpyOptionsFromQuery';

function qp(pairs: Record<string, string>): URLSearchParams {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(pairs)) p.set(k, v);
    return p;
}

describe('scrcpyOptionsFromQuery — audio param', () => {
    it('sets options.audio=false when query has audio=false', () => {
        const opts = scrcpyOptionsFromQuery(qp({ audio: 'false' }), 'scid0');
        expect(opts.audio).toBe(false);
    });

    it('sets options.audio=true when query has audio=true', () => {
        const opts = scrcpyOptionsFromQuery(qp({ audio: 'true' }), 'scid0');
        expect(opts.audio).toBe(true);
    });

    it('leaves options.audio undefined when query omits audio', () => {
        const opts = scrcpyOptionsFromQuery(qp({}), 'scid0');
        expect(opts.audio).toBeUndefined();
    });

    it('ignores garbage values for audio (defensive)', () => {
        const opts = scrcpyOptionsFromQuery(qp({ audio: 'yes' }), 'scid0');
        expect(opts.audio).toBeUndefined();
    });
});

describe('scrcpyOptionsFromQuery — audioSource param', () => {
    it('accepts playback and pairs it with audio_dup', () => {
        const opts = scrcpyOptionsFromQuery(qp({ audioSource: 'playback' }), 's');
        expect(opts.audioSource).toBe('playback');
        expect(opts.audioDup).toBe(true);
    });

    it('accepts output without audioDup', () => {
        const opts = scrcpyOptionsFromQuery(qp({ audioSource: 'output' }), 's');
        expect(opts.audioSource).toBe('output');
        expect(opts.audioDup).toBeUndefined();
    });

    it('accepts mic without audioDup', () => {
        const opts = scrcpyOptionsFromQuery(qp({ audioSource: 'mic' }), 's');
        expect(opts.audioSource).toBe('mic');
        expect(opts.audioDup).toBeUndefined();
    });

    it('ignores unknown audioSource values', () => {
        const opts = scrcpyOptionsFromQuery(qp({ audioSource: 'voice-call' }), 's');
        expect(opts.audioSource).toBeUndefined();
    });

    it('leaves audioSource undefined when omitted', () => {
        const opts = scrcpyOptionsFromQuery(qp({}), 's');
        expect(opts.audioSource).toBeUndefined();
    });
});

describe('scrcpyOptionsFromQuery — other params carry over', () => {
    it('attaches the scid', () => {
        const opts = scrcpyOptionsFromQuery(qp({}), 'abc123');
        expect(opts.scid).toBe('abc123');
    });

    it('parses numeric settings', () => {
        const opts = scrcpyOptionsFromQuery(
            qp({ maxSize: '1920', bitrate: '4000000', maxFps: '30', displayId: '2' }),
            'scid0',
        );
        expect(opts.maxSize).toBe(1920);
        expect(opts.videoBitRate).toBe(4000000);
        expect(opts.maxFps).toBe(30);
        expect(opts.displayId).toBe(2);
    });

    it('accepts h265/av1 but ignores other videoCodec values', () => {
        expect(scrcpyOptionsFromQuery(qp({ videoCodec: 'h265' }), 's').videoCodec).toBe('h265');
        expect(scrcpyOptionsFromQuery(qp({ videoCodec: 'av1' }), 's').videoCodec).toBe('av1');
        expect(scrcpyOptionsFromQuery(qp({ videoCodec: 'vp9' }), 's').videoCodec).toBeUndefined();
    });

    it('accepts aac/flac/raw but ignores other audioCodec values', () => {
        expect(scrcpyOptionsFromQuery(qp({ audioCodec: 'aac' }), 's').audioCodec).toBe('aac');
        expect(scrcpyOptionsFromQuery(qp({ audioCodec: 'flac' }), 's').audioCodec).toBe('flac');
        expect(scrcpyOptionsFromQuery(qp({ audioCodec: 'raw' }), 's').audioCodec).toBe('raw');
        expect(scrcpyOptionsFromQuery(qp({ audioCodec: 'mp3' }), 's').audioCodec).toBeUndefined();
    });

    it('passes through videoEncoder', () => {
        const opts = scrcpyOptionsFromQuery(qp({ videoEncoder: 'c2.qti.hevc.encoder' }), 's');
        expect(opts.videoEncoder).toBe('c2.qti.hevc.encoder');
    });
});
