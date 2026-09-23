import { describe, expect, it } from 'vitest';
import { chooseAudioCodec, parseAudioEncodersFromDumpsys } from '../audioCodecFallback';

// A device without the configured audio codec used to lose its VIDEO stream:
// MediaCodec creation throws, the exception escapes scrcpy-server's audio
// thread, and the process exits. Measured against redroid 13 (x86_64), whose
// entire audio encoder list is aac + flac while scrcpy defaults to opus.

// The real list from redroid 13 x86_64, kept verbatim so the case that caused
// this work is the case that guards it.
const REDROID = ['OMX.google.aac.encoder', 'OMX.google.flac.encoder'];

describe('chooseAudioCodec', () => {
    it('falls back to aac on a device with no opus encoder, rather than disabling audio', () => {
        const d = chooseAudioCodec('opus', REDROID);
        expect(d.codec).toBe('aac');
        expect(d.disable).toBe(false);
        // The reason names what the device DOES have; "no opus" alone sends the
        // reader looking for a missing package.
        expect(d.reason).toContain('OMX.google.aac.encoder');
    });

    it('leaves a supported codec alone', () => {
        const d = chooseAudioCodec('aac', REDROID);
        expect(d.codec).toBeUndefined();
        expect(d.disable).toBe(false);
    });

    // THE SAFETY PROPERTY. `dumpsys media.player` does not report encoders on
    // every device — DeviceProbe has a whole second strategy for that case — so
    // reading silence as "no encoders exist" would switch off working audio
    // because a diagnostic was quiet.
    it('treats an EMPTY list as unknown, not as none', () => {
        const d = chooseAudioCodec('opus', []);
        expect(d.disable).toBe(false);
        expect(d.codec).toBeUndefined();
        expect(d.reason).toContain('unknown');
    });

    it('disables audio only on POSITIVE evidence that nothing is encodable', () => {
        // A non-empty list that contains no audio codec we can use.
        const d = chooseAudioCodec('opus', ['OMX.google.something.encoder']);
        expect(d.disable).toBe(true);
        expect(d.reason).toContain('WITHOUT audio so video survives');
    });

    it('never rewrites `raw`, which needs no encoder at all', () => {
        // An encoder list says nothing about passthrough; "correcting" it would
        // break a working configuration on evidence that does not apply.
        const d = chooseAudioCodec('raw', REDROID);
        expect(d.codec).toBeUndefined();
        expect(d.disable).toBe(false);
        expect(d.reason).toContain('needs no encoder');
    });

    it('does not offer the requested codec back to itself as the fallback', () => {
        // `aac` is first in the fallback order; asking for aac on a device
        // without it must not "fall back" to aac.
        const d = chooseAudioCodec('aac', ['c2.android.flac.encoder']);
        expect(d.codec).toBe('flac');
    });

    it('matches the dotted segment, not a bare substring', () => {
        // A vendor name containing the codec letters must not be read as
        // support for it — `.opus.` is the shape, `opus` anywhere is not.
        const d = chooseAudioCodec('opus', ['OMX.opusvendor.aac.encoder']);
        // aac IS present here; the point is that the opus-looking vendor
        // fragment did not count as an opus encoder.
        expect(d.codec).toBe('aac');
    });

    it('is case-insensitive about encoder names', () => {
        expect(chooseAudioCodec('opus', ['OMX.Google.AAC.Encoder']).codec).toBe('aac');
    });
});

describe('parseAudioEncodersFromDumpsys', () => {
    it('picks audio encoders out of dumpsys output and ignores video ones', () => {
        const out = [
            'Encoder "OMX.google.h264.encoder" supports ',
            'Encoder "OMX.google.aac.encoder" supports ',
            'Encoder "c2.android.opus.encoder" supports ',
            'noise that mentions aac but is not an encoder line',
        ].join('\n');
        expect(parseAudioEncodersFromDumpsys(out)).toEqual(['OMX.google.aac.encoder', 'c2.android.opus.encoder']);
    });

    it('returns an empty list for output with no encoder lines', () => {
        expect(parseAudioEncodersFromDumpsys('nothing here')).toEqual([]);
    });
});
