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
