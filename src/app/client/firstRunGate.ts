/**
 * v0.1.10: client-side modal gating via localStorage.
 *
 * Pre-v0.1.10 the WelcomeModal and ServiceFirstRunModal gated on
 * server-side config flags (firstRunComplete, serviceFirstRunSeen).
 * That meant uninstalling and re-installing the service re-triggered
 * the "welcome to service mode" modal because the new install reset
 * (or never persisted) the flag — even though the same user had
 * already dismissed the modal once.
 *
 * v0.1.10 moves dismissal tracking entirely to localStorage. Each
 * modal now ships a "don't show again" checkbox, and the flag is
 * only persisted when the user checks that checkbox AND clicks the
 * commit button. The flags are independent — dismissing the local
 * (Welcome) modal does not dismiss the service (ServiceFirstRun)
 * modal and vice versa, mirroring the user's mental model: "I have
 * been told what I need to know on this side."
 *
 * The bookmark-port flag is keyed on a port number, not a boolean.
 * On page load, if the saved port differs from the current port,
 * the bookmark reminder shows again — over-reminding a user about
 * a NEW URL is the right tradeoff vs. silently letting them lose
 * their bookmark.
 *
 * The only way to clear any of these flags is for the user to clear
 * browser storage. There is no in-app reset button by design — the
 * flags exist to stop noise, not to be re-armed.
 */

const KEY_WELCOME = 'wsScrcpy.welcomeDismissed';
const KEY_SERVICE_FIRST_RUN = 'wsScrcpy.serviceFirstRunDismissed';
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
        // The modal will show again next load; that is acceptable.
    }
}

export function isWelcomeDismissed(): boolean {
    return safeGet(KEY_WELCOME) === '1';
}

export function setWelcomeDismissed(): void {
    safeSet(KEY_WELCOME, '1');
}

export function isServiceFirstRunDismissed(): boolean {
    return safeGet(KEY_SERVICE_FIRST_RUN) === '1';
}

export function setServiceFirstRunDismissed(): void {
    safeSet(KEY_SERVICE_FIRST_RUN, '1');
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
