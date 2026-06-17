// src/app/interactionHandler/multiTouchKey.ts

/** The subset of a KeyboardEvent the multi-touch gesture predicate reads. */
export interface MultiTouchKeyState {
    /** True when this is an OS key-repeat (held key). Treated as absent => false. */
    repeat?: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
}

/**
 * Whether a key event should trigger the synthetic multi-touch rebuild.
 *
 * The synthetic multi-touch (pinch/spread) gesture is gated by Ctrl/Shift in
 * `getTouch()`, so a key event with neither modifier can never change the
 * gesture — there's no point rebuilding the touch event for it. Held-key
 * repeats are also dropped: the gesture state doesn't change across repeats of
 * the same modifier, so re-running `buildTouchEvent` on every auto-repeat is
 * pure overhead (the #46 hot path).
 *
 * Returns true only for a non-repeat key while at least one of Ctrl/Shift is
 * held.
 */
export function shouldHandleMultiTouchKey(state: MultiTouchKeyState): boolean {
    if (state.repeat) {
        return false;
    }
    return state.ctrlKey || state.shiftKey;
}
