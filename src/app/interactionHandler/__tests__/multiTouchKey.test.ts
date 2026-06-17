import { describe, expect, it } from 'vitest';
import { shouldHandleMultiTouchKey } from '../multiTouchKey';

describe('shouldHandleMultiTouchKey', () => {
    it('returns false for held-key repeats (even with a modifier)', () => {
        expect(shouldHandleMultiTouchKey({ repeat: true, ctrlKey: true, shiftKey: false })).toBe(false);
        expect(shouldHandleMultiTouchKey({ repeat: true, ctrlKey: false, shiftKey: true })).toBe(false);
        expect(shouldHandleMultiTouchKey({ repeat: true, ctrlKey: true, shiftKey: true })).toBe(false);
    });

    it('returns false when no relevant modifier (ctrl/shift) is held', () => {
        expect(shouldHandleMultiTouchKey({ repeat: false, ctrlKey: false, shiftKey: false })).toBe(false);
    });

    it('returns true on a non-repeat key with ctrl held', () => {
        expect(shouldHandleMultiTouchKey({ repeat: false, ctrlKey: true, shiftKey: false })).toBe(true);
    });

    it('returns true on a non-repeat key with shift held', () => {
        expect(shouldHandleMultiTouchKey({ repeat: false, ctrlKey: false, shiftKey: true })).toBe(true);
    });

    it('returns true on a non-repeat key with both modifiers held', () => {
        expect(shouldHandleMultiTouchKey({ repeat: false, ctrlKey: true, shiftKey: true })).toBe(true);
    });

    it('treats a missing repeat field as not-a-repeat', () => {
        expect(shouldHandleMultiTouchKey({ ctrlKey: true, shiftKey: false })).toBe(true);
        expect(shouldHandleMultiTouchKey({ ctrlKey: false, shiftKey: false })).toBe(false);
    });
});
