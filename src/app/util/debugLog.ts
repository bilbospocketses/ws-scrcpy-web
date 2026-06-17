/**
 * Tiny localStorage-gated debug logger for ws-scrcpy-web.
 *
 * Verbose per-message / per-frame / lifecycle traces in hot paths (e.g. the
 * file-listing protocol in ListFilesModal) are silenced by default and only
 * surface when the `ws-scrcpy-web-debug` localStorage flag is set to the exact
 * string `'true'`. This mirrors the localStorage convention used by
 * themeEmbed.ts / AudioSettingsStore.
 *
 * Set in the browser console to enable:
 *   localStorage.setItem('ws-scrcpy-web-debug', 'true')
 *
 * Genuine user-facing errors should NOT use this — they should always surface
 * via plain `console.error`. This is only for the debug scaffolding.
 */

export const DEBUG_STORAGE_KEY = 'ws-scrcpy-web-debug';

/**
 * True only when the debug flag is present and exactly `'true'`. Guards against
 * environments where `localStorage` is unavailable or throws (e.g. blocked
 * storage, non-browser runtimes) by treating any failure as "disabled".
 */
export function isDebugEnabled(): boolean {
    try {
        return globalThis.localStorage?.getItem(DEBUG_STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

/** No-op unless the debug flag is enabled; otherwise forwards to console.log. */
export function debugLog(...args: unknown[]): void {
    if (isDebugEnabled()) {
        console.log(...args);
    }
}

/**
 * No-op unless the debug flag is enabled; otherwise forwards to console.error.
 * Use ONLY for debug-scaffolding errors — keep always-surface errors on plain
 * console.error.
 */
export function debugError(...args: unknown[]): void {
    if (isDebugEnabled()) {
        console.error(...args);
    }
}
