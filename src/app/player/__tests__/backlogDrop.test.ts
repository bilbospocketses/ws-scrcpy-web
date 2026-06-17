import { describe, expect, it } from 'vitest';
import { shouldDropBacklog } from '../backlogDrop';

/**
 * Finding #43: the backlog-drop decision must trigger on a REAL keyframe (the
 * demuxer's PTS_FLAG_KEYFRAME bit), not the H.264-only NAL check (isIFrame),
 * which silently misses H.265/AV1 keyframes. The decision itself is:
 *   drop  ⇔  isKeyframe && framesListLength > maxFps / 2
 */
describe('shouldDropBacklog', () => {
    it('drops when a keyframe arrives and the backlog exceeds maxFps/2', () => {
        expect(shouldDropBacklog(true, 9, 15)).toBe(true); // 9 > 7.5
    });

    it('does not drop on a keyframe when the backlog is at or below maxFps/2', () => {
        expect(shouldDropBacklog(true, 7, 15)).toBe(false); // 7 <= 7.5
        expect(shouldDropBacklog(true, 0, 15)).toBe(false);
    });

    it('never drops on a non-keyframe regardless of backlog size', () => {
        expect(shouldDropBacklog(false, 100, 15)).toBe(false);
    });

    it('drops on a NON-H.264 keyframe that isIFrame would have missed', () => {
        // The caller passes the demuxer keyframe flag; the byte content (H.265/AV1)
        // is irrelevant to this decision — only the boolean and backlog matter.
        expect(shouldDropBacklog(true, 16, 30)).toBe(true); // 16 > 15
        expect(shouldDropBacklog(true, 30, 30)).toBe(true); // 30 > 15
    });

    it('uses strict greater-than against maxFps/2 (boundary)', () => {
        expect(shouldDropBacklog(true, 5, 10)).toBe(false); // 5 == 10/2, not >
        expect(shouldDropBacklog(true, 6, 10)).toBe(true); // 6 > 5
    });
});
