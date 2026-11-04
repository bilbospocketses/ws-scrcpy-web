import { ACTION } from '../../../common/Action';
import type GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';

/**
 * #995: a link that opens one device's stream, the same as pressing its
 * connect button.
 *
 * The connect button is an anchor whose href is `#!action=stream&udid=<id>
 * &player=<player>` (BaseDeviceTracker.buildLink), where `<id>` is the device's
 * adb transport id: its USB serial, or `host:port` over Wi-Fi. Its click
 * handler opens the stream in place, so the href only ever served as a carrier
 * for the click's parameters, and loading it in a new tab, a bookmark or a
 * ctrl+click showed the home page and nothing else: the page never read its
 * own hash.
 *
 * Only the id is taken from the hash. It matches a device by its transport id
 * or by its `ro.serialno`, so a bookmark can name the device itself and keep
 * working when a Wi-Fi device's address or port changes. The stream is then
 * opened through the device's own connect button (DeviceTracker hands each one
 * to `offer`), so a link selects a listed, connected device and starts exactly
 * what a click would, with that button's parameters and the device's saved
 * settings, never parameters of the link's own.
 */
export function streamDeepLinkUdid(hash: string): string | null {
    const body = hash.startsWith('#!') ? hash.slice(2) : hash.startsWith('#') ? hash.slice(1) : hash;
    if (!body) return null;
    const query = new URLSearchParams(body);
    if (query.get('action') !== ACTION.STREAM_SCRCPY) return null;
    return query.get('udid') || null;
}

/**
 * Whether the server has read this device's properties yet. A device's first
 * `device`-state record goes out before `getprop` answers (server `Device.setState`
 * emits, then fetches), with every property empty: its card names no one, its
 * settings are not bound to its serial and its Android version is unknown. A
 * click on that card is rare; a waiting link would hit it every time, so the
 * link waits for the record that carries the properties. The SDK level is
 * what every device reports, where a serial can legitimately be blank.
 */
export function devicePropertiesRead(device: Pick<GoogDeviceDescriptor, 'ro.build.version.sdk'>): boolean {
    return Boolean(device['ro.build.version.sdk']);
}

/** Opens the device's stream; false when it could not (its button is gone). */
export type StreamOpener = () => boolean;

/** How a link can name a device: its adb transport id, or its own serial. */
export interface StreamTarget {
    udid: string;
    serial?: string | undefined;
}

export class StreamDeepLink {
    private pending: string | null;
    private readonly openers = new Map<string, { target: StreamTarget; open: StreamOpener }>();

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
    public offer(target: StreamTarget, open: StreamOpener): void {
        this.openers.set(target.udid, { target, open });
        if (this.pending !== null && StreamDeepLink.names(target, this.pending)) {
            this.tryOpen(open);
        }
    }

    /** The device is listed without a usable connect button (offline, or not read yet). */
    public withdraw(udid: string): void {
        this.openers.delete(udid);
    }

    /** A stream link entered in a tab that is already open. */
    public onHashChange(hash: string): void {
        const id = streamDeepLinkUdid(hash);
        if (!id) return;
        this.pending = id;
        const direct = this.openers.get(id);
        const entry = direct ?? [...this.openers.values()].find((e) => StreamDeepLink.names(e.target, id));
        if (entry) {
            this.tryOpen(entry.open);
        }
    }

    private static names(target: StreamTarget, id: string): boolean {
        return target.udid === id || (!!target.serial && target.serial === id);
    }

    private tryOpen(open: StreamOpener): void {
        if (!open()) return;
        this.pending = null;
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
