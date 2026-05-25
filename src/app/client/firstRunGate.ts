/**
 * Client-side bookmark-port tracking via localStorage.
 *
 * Welcome and ServiceFirstRun modal gating moved to config.json
 * (server-side) in v0.1.25-beta.59. The bookmark-port flag stays
 * in localStorage because it's inherently per-origin — a port
 * change IS the trigger for re-showing the bookmark reminder.
 *
 * resetAllDismissals clears the bookmark localStorage key; the
 * config.json flags (firstRunComplete, serviceFirstRunSeen) are
 * reset by the Settings button's PATCH call, not here.
 */

const KEY_BOOKMARK_PORT = 'wsScrcpy.bookmarkDismissedForPort';

function safeGet(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

function safeSet(key: string, value: string): void {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // Private mode / quota exceeded / disabled — fall through.
    }
}

export function getBookmarkDismissedPort(): number | null {
    const raw = safeGet(KEY_BOOKMARK_PORT);
    if (raw === null) return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : null;
}

export function setBookmarkDismissedPort(port: number): void {
    safeSet(KEY_BOOKMARK_PORT, String(port));
}

/**
 * Clear the bookmark-port localStorage flag. Called by Settings →
 * "Reset welcome prompts" alongside the config.json PATCH that
 * resets firstRunComplete + serviceFirstRunSeen.
 */
export function resetAllDismissals(): void {
    try {
        window.localStorage.removeItem(KEY_BOOKMARK_PORT);
    } catch {
        // Private mode / quota / disabled — silent fall-through.
    }
}
