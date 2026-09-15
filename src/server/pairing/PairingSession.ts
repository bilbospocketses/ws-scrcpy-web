import { randomBytes } from 'crypto';
import type { PairingState, PairingStatus } from '../../common/PairingStatus';

// Re-exported so server-side callers can take the lifecycle types from the
// session module they already import, without reaching into common/.
export type { PairingState, PairingStatus };

/** How the session was started: a scanned QR, or a pairing code typed by hand. */
export type PairingMode = 'qr' | 'code';

/**
 * How long a session stays usable. Android's own pairing QR is short-lived, and
 * the secret below is only as good as the window it is exposed for.
 */
export const PAIRING_TTL_MS = 180_000;

/**
 * States past which nothing more happens. A session that reached one of these is
 * never re-reported as `expired`, however long ago the clock ran out.
 */
const TERMINAL: ReadonlySet<PairingState> = new Set(['paired', 'paired-not-connected', 'failed', 'expired']);

/** RFC 4648 base32, lower-case: the character set mDNS service names tolerate. */
const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** Password alphabet, minus the glyphs that misread when a user types the code by hand (I l 1 O 0). */
const PW = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function pick(alphabet: string, len: number, random: () => Buffer): string {
    const bytes = random();
    let out = '';
    for (let i = 0; i < len; i++) {
        out += alphabet[bytes[i]! % alphabet.length]!;
    }
    return out;
}

/**
 * One wireless-pairing attempt: its secret, its deadline, and where it got to.
 *
 * Pure state -- it runs no adb, opens no socket and starts no timer. Expiry is a
 * function of the `now` the caller passes in, so the whole lifecycle is testable
 * without fake timers and a forgotten `clearTimeout` cannot leak a live secret.
 */
export class PairingSession {
    private _state: PairingState;
    private _message: string | undefined;
    private _serial: string | undefined;
    private _address: string | undefined;

    constructor(
        readonly id: string,
        readonly mode: PairingMode,
        /** mDNS service name the device will advertise. Empty for `'code'` mode. */
        readonly serviceName: string,
        /**
         * The pairing secret. NEVER put this in a log line, an error message, an
         * HTTP response body or the database -- see `toStatus`.
         */
        readonly password: string,
        readonly expiresAt: number,
    ) {
        this._state = mode === 'qr' ? 'awaiting-scan' : 'pairing';
    }

    get state(): PairingState {
        return this._state;
    }
    get message(): string | undefined {
        return this._message;
    }
    get serial(): string | undefined {
        return this._serial;
    }
    get address(): string | undefined {
        return this._address;
    }

    isExpired(now: number): boolean {
        return !TERMINAL.has(this._state) && now >= this.expiresAt;
    }

    /** Never returns the password or the QR payload, in any state. */
    toStatus(now: number): PairingStatus {
        const status: PairingStatus = { state: this.isExpired(now) ? 'expired' : this._state };
        // Built field by field rather than as one literal: `exactOptionalPropertyTypes`
        // rejects an explicit `undefined` for an optional property.
        if (this._message !== undefined) {
            status.message = this._message;
        }
        if (this._serial !== undefined) {
            status.serial = this._serial;
        }
        if (this._address !== undefined) {
            status.address = this._address;
        }
        return status;
    }

    markPairing(): void {
        this._state = 'pairing';
    }
    /** `serial` is optional because the connect service may answer before it is parsed. */
    markConnecting(serial: string | undefined, address: string): void {
        this._state = 'connecting';
        this._serial = serial;
        this._address = address;
    }
    markPaired(): void {
        this._state = 'paired';
    }
    markPairedNotConnected(message: string): void {
        this._state = 'paired-not-connected';
        this._message = message;
    }
    markFailed(message: string): void {
        this._state = 'failed';
        this._message = message;
    }
    /** No-op once terminal, so cancelling a session that just paired cannot un-pair it. */
    cancel(): void {
        if (!TERMINAL.has(this._state)) {
            this._state = 'failed';
            this._message = 'cancelled';
        }
    }
}

export function newSession(
    mode: PairingMode,
    now: number,
    random: () => Buffer = () => randomBytes(64),
): PairingSession {
    return new PairingSession(
        pick(B32, 16, random),
        mode,
        mode === 'qr' ? `wsscrcpy-${pick(B32, 10, random)}` : '',
        pick(PW, 12, random),
        now + PAIRING_TTL_MS,
    );
}
