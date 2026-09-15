import type { PairingStatus } from '../../common/PairingStatus';
import { AdbClient, PairingError, parsePairGuid, parseSerialFromMdnsName } from '../AdbClient';
import { Config } from '../Config';
import { ControlCenter } from '../goog-device/services/ControlCenter';
import { Logger } from '../Logger';
import { newSession, type PairingSession } from './PairingSession';

// Re-exported so the API layer can take the pollable shape from the service it
// already imports. This is the type from common/ -- there is deliberately no
// second copy, because the browser polls this exact shape and client code must
// never import from src/server/.
export type { PairingStatus };

const log = Logger.for('PairingService');

/**
 * mDNS service types Android advertises while pairing and once paired.
 *
 * Exported so tests can pin them against what `parseMdnsOutput` actually
 * produces, rather than against a second copy that would drift silently: these
 * are compared with `===`, so a service type that arrives in any other spelling
 * (a trailing DNS root dot, say) makes discovery fail with no error at all.
 * `parseMdnsOutput` normalises the dot away for exactly that reason.
 */
export const PAIR_SVC = '_adb-tls-pairing._tcp';
export const CONNECT_SVC = '_adb-tls-connect._tcp';

/** How often a QR session re-asks adb what it can see. */
export const POLL_INTERVAL_MS = 1_000;

export interface PairingDeps {
    adb: Pick<AdbClient, 'pair' | 'mdnsServices' | 'connect'>;
    now: () => number;
    setTimeoutFn?: typeof setTimeout;
    /**
     * Called once a session has paired AND connected. Injected rather than
     * imported so this service still knows nothing about device tracking, and
     * so tests are not obliged to stand a tracker up.
     */
    onConnected?: () => void;
}

/**
 * Drives one wireless-pairing attempt at a time: hand out the QR payload, watch
 * adb's mDNS list for the service that QR told the phone to advertise, pair
 * against it, then connect the device that comes up.
 *
 * ONE session is live at a time, by design. Replacement, cancellation and expiry
 * all make prior work inert -- every async continuation below re-checks
 * `this.session === s` before it mutates anything, so a slow adb call belonging
 * to a session the user has already abandoned cannot report into the new one.
 * `PairingSession` guards its own transitions as well; that protects the object,
 * while the identity checks here protect this service's notion of "current".
 */
export class PairingService {
    private static instance: PairingService | undefined;

    private session: PairingSession | undefined;
    private timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Public on purpose: tests build their own with stub deps rather than
     * reaching into the singleton, which would leak a live timer between tests.
     */
    constructor(private readonly deps: PairingDeps) {}

    /** Production singleton: the real adb binary and the real clock. */
    static getInstance(): PairingService {
        if (!PairingService.instance) {
            // Local-Dependencies-Only: adb resolves from Config, never from PATH.
            PairingService.instance = new PairingService({
                adb: new AdbClient(Config.getInstance().adbPath),
                now: () => Date.now(),
                onConnected: () => {
                    // `hasInstance`, never `getInstance`: standing a tracker up
                    // here would start a 5 s adb poll as a side effect of
                    // pairing, in a process that had deliberately not started
                    // one. If nothing is tracking devices, there is no list to
                    // refresh.
                    if (ControlCenter.hasInstance()) {
                        void ControlCenter.getInstance().refreshNow();
                    }
                },
            });
        }
        return PairingService.instance;
    }

    /**
     * Start a QR session and return the payload for the caller to render.
     *
     * The payload embeds the pairing password, so it goes to the in-process
     * caller only -- the API layer turns it into an SVG and drops the string. It
     * must never be logged, stored, or put in a response body as text.
     */
    startQr(): { sessionId: string; payload: string; expiresInMs: number } {
        const now = this.deps.now();
        const s = newSession('qr', now);
        this.replace(s);
        log.info(`session ${s.id} started (qr), advertising as ${s.serviceName}`);
        return {
            sessionId: s.id,
            payload: `WIFI:T:ADB;S:${s.serviceName};P:${s.password};;`,
            // A DURATION, not the absolute deadline. The browser has no way to
            // read this clock, so handing it `expiresAt` made it difference two
            // unrelated clocks -- any skew between the server and the user's
            // machine came out as a wrong "stops working in about N", or as no
            // note at all when the skew ran the other way.
            expiresInMs: s.expiresAt - now,
        };
    }

    /**
     * Start a session from a pairing code the user typed off the phone. There is
     * nothing to discover -- the address came with the code -- so this pairs
     * immediately rather than polling.
     */
    startCode(address: string, code: string): { sessionId: string } {
        const s = newSession('code', this.deps.now());
        this.replace(s);
        log.info(`session ${s.id} started (code) against ${address}`);
        // The IP for the connect-service fallback: `address` is 'IP:pairingPort',
        // and the port the device listens on once paired is a different one.
        void this.pairAndConnect(s, address, code, address.split(':')[0] ?? address);
        return { sessionId: s.id };
    }

    /** `undefined` for any id that is not the current session. */
    status(sessionId: string): PairingStatus | undefined {
        const s = this.session;
        if (!s || s.id !== sessionId) {
            return undefined;
        }
        return s.toStatus(this.deps.now());
    }

    cancel(sessionId: string): void {
        const s = this.session;
        if (!s || s.id !== sessionId) {
            return;
        }
        log.info(`session ${s.id} cancelled`);
        this.terminate(s, () => s.cancel());
        this.stop();
    }

    /** Clears the timer and drops the session, blanking its secret on the way out. */
    stop(): void {
        this.clearTimer();
        // Dropping the reference is not enough: a continuation still in flight
        // can hold the same object, so blank the secret before letting go of it.
        this.session?.clearSecret();
        this.session = undefined;
    }

    /**
     * One discovery tick. Public on purpose: production drives it on a timer,
     * tests call it directly, so nothing here needs fake timers.
     */
    async pollOnce(): Promise<void> {
        const s = this.session;
        if (s?.state !== 'awaiting-scan') {
            return;
        }
        if (s.isExpired(this.deps.now())) {
            this.expire(s);
            return;
        }
        // mdnsServices throws on a missing binary or an adb timeout. A tick that
        // saw nothing and a tick that could not ask are the same thing here --
        // both mean "not yet" -- and the next tick will ask again.
        const services = await this.deps.adb.mdnsServices().catch(() => []);
        if (this.session !== s) {
            return; // superseded while awaiting mDNS
        }
        // The deadline can also pass DURING that call (mdnsServices gets 8 s). A
        // status poll in the gap already reported 'expired', so honouring a hit
        // found afterwards would walk the session expired -> pairing -> paired
        // in front of the user. 'expired' is final; the late hit is discarded and
        // the user rescans.
        if (s.isExpired(this.deps.now())) {
            this.expire(s);
            return;
        }
        // EXACT name match. Never "any _adb-tls-pairing._tcp on the network":
        // that is a neighbouring host's pairing session as often as it is ours,
        // and the name we generated is the only thing that correlates the two.
        const hit = services.find((x) => x.service === PAIR_SVC && x.name === s.serviceName);
        if (!hit) {
            return;
        }
        log.info(`session ${s.id} found its device at ${hit.address}:${hit.port}, pairing`);
        s.markPairing();
        await this.pairAndConnect(s, `${hit.address}:${hit.port}`, s.password, hit.address);
    }

    private async pairAndConnect(s: PairingSession, pairAddress: string, code: string, ip: string): Promise<void> {
        let out: string;
        try {
            out = await this.deps.adb.pair(pairAddress, code);
        } catch (e) {
            // PairingError.message is already redacted -- it names the failure
            // kind and nothing else. Anything else that surfaced here has an
            // unaudited message, and the pairing code was an argument to the
            // call that produced it, so it gets a fixed string instead.
            const message = e instanceof PairingError ? e.message : 'pairing failed';
            if (this.session === s) {
                log.warn(`session ${s.id} failed to pair: ${message}`);
                this.terminate(s, () => s.markFailed(message));
            }
            return;
        }
        if (this.session !== s) {
            return;
        }

        const guid = parsePairGuid(out);
        const services = await this.deps.adb.mdnsServices().catch(() => []);
        if (this.session !== s) {
            return;
        }

        const connects = services.filter((x) => x.service === CONNECT_SVC);
        // guid first, then same IP. NEVER "the only connect service on the
        // network" -- with several devices advertising that is a coin toss.
        const target = (guid && connects.find((x) => x.name === guid)) ?? connects.find((x) => x.address === ip);
        // Every `markPairedNotConnected` message below -- all three of them --
        // is a DETAIL CLAUSE, not a sentence. The client owns the framing:
        // `pairingStatusText` renders "Paired, but not connected yet --
        // <message>.", so a message that opens with "paired, but" reaches the
        // user doubled. (The log lines are sentences and are not affected.)
        if (!target) {
            // Not a failure: the device trusts us now. Only the automatic
            // connect could not be completed, so the user finishes by hand.
            log.info(`session ${s.id} paired, but no connect service was advertised`);
            this.terminate(s, () => s.markPairedNotConnected('no connect service was advertised for this device'));
            return;
        }
        const address = `${target.address}:${target.port}`;
        // The guid is an mDNS instance name (`adb-<serial>-<suffix>`), not a
        // serial: `PairingStatus.serial` is documented as one, and the rest of
        // the app keys devices by the stripped form (DeviceDiscoveryApi runs
        // every connect-service name through the same helper), so storing the
        // guid raw would put a value in that field that matches nothing.
        s.markConnecting(guid ? parseSerialFromMdnsName(guid, CONNECT_SVC) : undefined, address);
        try {
            const res = await this.deps.adb.connect(address);
            if (this.session !== s) {
                return;
            }
            if (/connected/i.test(res)) {
                log.info(`session ${s.id} paired and connected ${address}`);
                this.terminate(s, () => s.markPaired());
                // The device set just changed and this process is the one that
                // changed it, so say so rather than waiting to be rediscovered.
                //
                // Caught here so a throwing listener is LOGGED rather than
                // swallowed. It is not what protects the reported state: this
                // sits inside the outer try, and `markPaired()` above has
                // already made the session terminal, so `PairingSession`'s
                // terminal guard would turn the outer catch's
                // `markPairedNotConnected` into a no-op anyway. Confirmed by
                // mutation — removing this catch changes nothing a user sees,
                // only what the log says.
                try {
                    this.deps.onConnected?.();
                } catch (e) {
                    log.warn(`session ${s.id} connected, but the device-list refresh threw: ${String(e)}`);
                }
            } else {
                this.terminate(s, () => s.markPairedNotConnected(`connect said: ${res.trim()}`));
            }
        } catch {
            if (this.session === s) {
                this.terminate(s, () => s.markPairedNotConnected('the connect attempt failed'));
            }
        }
    }

    private replace(s: PairingSession): void {
        // Replacement makes prior work inert: the old session object is dropped,
        // and every continuation above re-checks identity, so a late mDNS hit or
        // a late adb result belonging to it can no longer mutate anything.
        this.stop();
        this.session = s;
        this.schedule();
    }

    private schedule(): void {
        const s = this.session;
        // Expiry is checked here as well as in pollOnce, and it has to be: an
        // expired session's stored state is still 'awaiting-scan' (expiry is
        // derived from the clock at read time, never stored), so a state-only
        // guard would re-arm this timer every second forever on a QR nobody ever
        // scanned.
        if (s?.state !== 'awaiting-scan' || s.isExpired(this.deps.now())) {
            return;
        }
        const setT = this.deps.setTimeoutFn ?? setTimeout;
        const timer = setT(() => {
            // The re-arm needs the same identity check as every other
            // continuation. A tick belonging to a session that has since been
            // replaced would otherwise re-arm on behalf of its SUCCESSOR, and
            // since `stop()` can only clear the one handle in `this.timer`, the
            // timer that replacement already armed is orphaned while still live
            // -- two poll loops for one session, and another with every further
            // replacement mid-tick. (Deduping on `this.timer` instead does not
            // work: an already-fired Node handle is still truthy, and a stub
            // handle may be 0.)
            void this.pollOnce().finally(() => {
                if (this.session === s) {
                    this.schedule();
                }
            });
        }, POLL_INTERVAL_MS);
        // A discovery tick must not hold the process open on its own. Node's
        // timer has unref; an injected stub or a DOM timer handle may not.
        const unref = (timer as { unref?: () => void }).unref;
        if (typeof unref === 'function') {
            unref.call(timer);
        }
        this.timer = timer;
    }

    /**
     * Run a terminal transition and blank the secret it no longer needs.
     *
     * Every path into paired / paired-not-connected / failed goes through here so
     * no later hand can add one and forget the second half. The session itself is
     * kept and stays pollable -- the UI has to read 'paired' off it.
     */
    private terminate(s: PairingSession, transition: () => void): void {
        transition();
        s.clearSecret();
    }

    /**
     * The TTL ran out. The session is kept so `status` goes on answering
     * 'expired' (which `toStatus` derives from the clock); only the timer and the
     * secret go.
     */
    private expire(s: PairingSession): void {
        log.info(`session ${s.id} expired before it was scanned`);
        this.clearTimer();
        s.clearSecret();
    }

    private clearTimer(): void {
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = undefined;
    }
}
