/**
 * "This page has just lost its admin access" (0.5.5), for the pollers that read
 * operator-gated routes on a timer: the home page's dependency alert and
 * first-run banner, the update pill, and the Dependencies panel in an open
 * Settings dialog.
 *
 * Settings raises it when this device turns remote admin off while it is an
 * admin only because of that setting (`SettingsModal`), BEFORE the batch goes
 * out, so no poller's next tick can land on the refusal. Each poller stops for
 * good on it; the page's next load decides afresh whether they start at all
 * (`adminApiReachable`). A 403 from a poll's own read stops it the same way,
 * for every other path to the same state (another device turning the setting
 * off, a session that ended).
 *
 * A window event rather than a shared object, so the pollers need no
 * reference to Settings or to each other, and one listener per poller is torn
 * down with it.
 */
export const ADMIN_ACCESS_LOST_EVENT = 'ws-admin-access-lost';

/** Tell every poller on the page that the admin API no longer answers it. */
export function announceAdminAccessLost(): void {
    window.dispatchEvent(new Event(ADMIN_ACCESS_LOST_EVENT));
}

/** Run `listener` once admin access is lost; returns the unsubscribe. */
export function onAdminAccessLost(listener: () => void): () => void {
    window.addEventListener(ADMIN_ACCESS_LOST_EVENT, listener);
    return () => window.removeEventListener(ADMIN_ACCESS_LOST_EVENT, listener);
}

/**
 * "Remote admin without sign-in was just saved, on or off" (0.5.9), for what
 * on the page shows the admin posture: the home page's admin-scope banner. It
 * re-reads /api/config at once instead of on its next 30 s poll, so it goes
 * away the moment remote admin is turned on and comes back when it is turned
 * off (unless it was dismissed). Settings raises it AFTER the batch is
 * applied, since it asks for the policy now in force.
 */
export const REMOTE_ADMIN_CHANGED_EVENT = 'ws-remote-admin-changed';

/** Tell the page that the remote-admin setting was just saved. */
export function announceRemoteAdminChanged(): void {
    window.dispatchEvent(new Event(REMOTE_ADMIN_CHANGED_EVENT));
}

/** Run `listener` each time the remote-admin setting is saved; returns the unsubscribe. */
export function onRemoteAdminChanged(listener: () => void): () => void {
    window.addEventListener(REMOTE_ADMIN_CHANGED_EVENT, listener);
    return () => window.removeEventListener(REMOTE_ADMIN_CHANGED_EVENT, listener);
}
