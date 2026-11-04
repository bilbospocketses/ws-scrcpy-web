import { ACTION } from '../../../common/Action';

/**
 * #995: a link that opens one device's stream, the same as pressing its
 * connect button.
 *
 * The connect button is an anchor whose href is `#!action=stream&udid=<serial>
 * &player=<player>` (BaseDeviceTracker.buildLink). Its click handler opens the
 * stream in place, so the href only ever served as a carrier for the click's
 * parameters, and loading it in a new tab, a bookmark or a ctrl+click showed
 * the home page and nothing else: the page never read its own hash.
 *
 * Only the udid is taken from the hash. The stream is then opened through the
 * device's own connect button (DeviceTracker hands each one to `offer`), so a
 * link selects a listed, connected device and starts exactly what a click
 * would, with that button's parameters and the device's saved settings, never
 * parameters of the link's own.
 */
export function streamDeepLinkUdid(hash: string): string | null {
    const body = hash.startsWith('#!') ? hash.slice(2) : hash.startsWith('#') ? hash.slice(1) : hash;
    if (!body) return null;
    const query = new URLSearchParams(body);
    if (query.get('action') !== ACTION.STREAM_SCRCPY) return null;
    return query.get('udid') || null;
}

/** Opens the device's stream; false when it could not (its button is gone). */
export type StreamOpener = () => boolean;

export class StreamDeepLink {
    private pending: string | null;
    private readonly openers = new Map<string, StreamOpener>();

    constructor(
        initialHash: string,
        private readonly clearHash: () => void,
    ) {
        this.pending = streamDeepLinkUdid(initialHash);
    }

    /**
     * A connected device's connect button was (re)built. Opens it when it is
     * the linked device; a link is followed once, and dropped from the address
     * bar so the same link entered again in this tab is a fresh hash change.
     */
    public offer(udid: string, open: StreamOpener): void {
        this.openers.set(udid, open);
        if (this.pending === udid) {
            this.tryOpen(udid, open);
        }
    }

    /** The device is listed without a connect button (offline or gone). */
    public withdraw(udid: string): void {
        this.openers.delete(udid);
    }

    /** A stream link entered in a tab that is already open. */
    public onHashChange(hash: string): void {
        const udid = streamDeepLinkUdid(hash);
        if (!udid) return;
        this.pending = udid;
        const open = this.openers.get(udid);
        if (open) {
            this.tryOpen(udid, open);
        }
    }

    private tryOpen(udid: string, open: StreamOpener): void {
        if (!open()) return;
        if (this.pending === udid) {
            this.pending = null;
        }
        this.clearHash();
    }
}

let instance: StreamDeepLink | undefined;

/** The page's one deep-link reader, created on first use from the page's own URL. */
export function pageStreamDeepLink(): StreamDeepLink {
    if (!instance) {
        const link = new StreamDeepLink(window.location.hash, () => {
            window.history.replaceState(
                window.history.state,
                '',
                `${window.location.pathname}${window.location.search}`,
            );
        });
        window.addEventListener('hashchange', () => link.onHashChange(window.location.hash));
        instance = link;
    }
    return instance;
}
