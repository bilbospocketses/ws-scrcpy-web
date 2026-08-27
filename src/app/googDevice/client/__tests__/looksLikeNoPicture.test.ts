import { describe, expect, it } from 'vitest';
import { looksLikeNoPicture, NO_PICTURE_FRAME_BYTES } from '../StreamClientScrcpy';

/**
 * Sizes taken from a Pixel 10a with a stream running across a lock/unlock:
 *
 *   locked    15 fps    13 bytes/frame
 *   unlocked  15 fps    30,000-50,000 bytes/frame
 *
 * Android refuses to let anything capture the keyguard, so it hands scrcpy a
 * black surface which encodes to almost nothing. This predicate is the cue to
 * go *ask* the device whether it is locked — it never decides the answer.
 *
 * The code this replaced treated the same signal as proof the stream had
 * degraded and forced a reconnect, which could not possibly help: the next
 * frame was black too. It just interrupted the video every ~30s and said
 * nothing, which is what issue #498 spent days chasing.
 */

const BLACK = 13;
const LIVE = 40000;

describe('looksLikeNoPicture', () => {
    it('spots a stream that goes black part-way through, against a live baseline', () => {
        expect(looksLikeNoPicture(BLACK, LIVE)).toBe(true);
    });

    it('spots a stream that was already black when it started', () => {
        // Connecting to a locked phone builds the baseline out of black frames,
        // so 13 is not "small relative to" 13. Without the absolute floor this
        // case is invisible — and it is the one a reconnect produces.
        expect(looksLikeNoPicture(BLACK, BLACK)).toBe(true);
    });

    it('spots black even with no baseline established yet', () => {
        expect(looksLikeNoPicture(BLACK, 0)).toBe(true);
    });

    it('leaves a live picture alone', () => {
        expect(looksLikeNoPicture(LIVE, LIVE)).toBe(false);
        expect(looksLikeNoPicture(35000, 40000)).toBe(false);
    });

    it('leaves a quiet but real screen alone', () => {
        // A mostly-static app is still well above the floor and within range of
        // its own baseline; it must not be mistaken for a locked device.
        expect(looksLikeNoPicture(9000, 40000)).toBe(false);
    });

    it('still catches a severe relative collapse that stays above the floor', () => {
        // 2,000 bytes against a 40,000 baseline is a 95% drop: not black, but
        // worth asking about.
        expect(looksLikeNoPicture(2000, 40000)).toBe(true);
    });

    it('treats the absolute floor as exclusive', () => {
        expect(looksLikeNoPicture(NO_PICTURE_FRAME_BYTES - 1, 0)).toBe(true);
        expect(looksLikeNoPicture(NO_PICTURE_FRAME_BYTES, 0)).toBe(false);
    });
});
