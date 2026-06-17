import { describe, expect, it } from 'vitest';
import { scrcpyOptionsFromQuery } from './scrcpyOptionsFromQuery';

describe('scrcpyOptionsFromQuery', () => {
    it('accepts a well-formed encoder name', () => {
        const opts = scrcpyOptionsFromQuery(new URLSearchParams('videoEncoder=OMX.qcom.video.encoder.avc'), 'scid1');
        expect(opts.videoEncoder).toBe('OMX.qcom.video.encoder.avc');
    });

    it('drops a videoEncoder containing shell metacharacters (command injection)', () => {
        const opts = scrcpyOptionsFromQuery(new URLSearchParams('videoEncoder=x;reboot'), 'scid1');
        expect(opts.videoEncoder).toBeUndefined();
    });

    it('drops a videoEncoder using command substitution', () => {
        const opts = scrcpyOptionsFromQuery(new URLSearchParams('videoEncoder=$(reboot)'), 'scid1');
        expect(opts.videoEncoder).toBeUndefined();
    });

    it('still parses the other (typed) options unaffected', () => {
        const opts = scrcpyOptionsFromQuery(new URLSearchParams('maxSize=1024&videoCodec=h265'), 'scid2');
        expect(opts.maxSize).toBe(1024);
        expect(opts.videoCodec).toBe('h265');
        expect(opts.scid).toBe('scid2');
    });
});
