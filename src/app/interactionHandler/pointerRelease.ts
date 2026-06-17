// src/app/interactionHandler/pointerRelease.ts

/**
 * Interaction types that END a pointer and so should release its entry from the
 * process-global pointer-id maps in InteractionHandler.getPointerId.
 *
 * touchend / touchcancel release a touch pointer. mouseup is the natural pair of
 * mousedown (the mouse add path, identifier 0); without it the mouse entry was
 * never deleted and leaked the static map across every mouse interaction. (#47)
 */
const POINTER_RELEASE_TYPES: ReadonlySet<string> = new Set(['touchend', 'touchcancel', 'mouseup']);

/** True when an interaction type ends a pointer and its id mapping should be freed. */
export function isPointerReleaseType(type: string): boolean {
    return POINTER_RELEASE_TYPES.has(type);
}
