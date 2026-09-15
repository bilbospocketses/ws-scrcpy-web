// src/common/PairingStatus.ts
//
// The lifecycle of one wireless-pairing session, shared verbatim by the server
// that drives it and the client that renders it. It lives in common/ rather than
// beside `PairingSession` because the browser polls this shape and must never
// import from src/server/.

/**
 * Where a pairing session is in its lifecycle.
 *
 * - `awaiting-scan` -- the QR is on screen, no device has connected yet. Only
 *   `'qr'` sessions start here; a typed pairing code goes straight to `pairing`.
 * - `pairing` -- the device answered, the adb pairing handshake is running.
 * - `connecting` -- pairing succeeded; the connect service is being resolved.
 * - `paired` -- terminal, the happy path: paired AND connected.
 * - `paired-not-connected` -- terminal, and NOT a failure. The device trusts us,
 *   but its connect port was never found, so the user must connect by hand.
 * - `failed` -- terminal. Also where a cancelled session lands.
 * - `expired` -- the TTL ran out before any terminal state was reached. It is
 *   derived from the clock at read time, never stored.
 */
export type PairingState =
    | 'awaiting-scan'
    | 'pairing'
    | 'connecting'
    | 'paired'
    | 'paired-not-connected'
    | 'failed'
    | 'expired';

/**
 * The public, pollable view of a pairing session.
 *
 * This is the ONLY shape that leaves the server for a pairing session, and it
 * deliberately has no field for the pairing password or the QR payload that
 * embeds it. Do not add one.
 */
export interface PairingStatus {
    state: PairingState;
    /** Human-readable detail for a terminal state. Never carries the password. */
    message?: string;
    /** Device serial, once known. */
    serial?: string;
    /** 'IP:port' of the connect endpoint, once known. */
    address?: string;
}
