import { describe, expect, it } from 'vitest';
import { shouldShowBookmark } from '../bookmarkGate';

describe('shouldShowBookmark', () => {
    it('hidden when globally dismissed, even if the port differs', () => {
        expect(shouldShowBookmark({ globallyDismissed: true, dismissedForPort: null, currentPort: 8000 })).toBe(false);
        expect(shouldShowBookmark({ globallyDismissed: true, dismissedForPort: 9999, currentPort: 8000 })).toBe(false);
    });
    it('hidden when the current port was dismissed per-port', () => {
        expect(shouldShowBookmark({ globallyDismissed: false, dismissedForPort: 8000, currentPort: 8000 })).toBe(false);
    });
    it('shown when not dismissed, or dismissed for a different port', () => {
        expect(shouldShowBookmark({ globallyDismissed: false, dismissedForPort: null, currentPort: 8000 })).toBe(true);
        expect(shouldShowBookmark({ globallyDismissed: false, dismissedForPort: 8001, currentPort: 8000 })).toBe(true);
    });
});
