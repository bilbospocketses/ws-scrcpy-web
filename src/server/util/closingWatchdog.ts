// src/server/util/closingWatchdog.ts
//
// Bound how long a websocket may sit in CLOSING.
//
// WHY THIS EXISTS (item 151). A stream session is released only when its
// websocket emits 'close' (Mw.onSocketClose), and `ws` has a CLOSING path with
// no time limit. When the peer half-closes TCP (FIN) without sending a close
// frame, ws enters CLOSING from its socket 'end' handler and calls
// `socket.end()` — but sets NO close timer, unlike every path that starts from
// `ws.close()`, which destroys the socket after `closeTimeout` (30 s). If the
// peer has also stopped reading, our send buffer never drains, the socket never
// finishes closing, and 'close' never fires. Measured on ws 8.21.3: still
// CLOSING after 75 s with 12.7 MB buffered, where the same peer sending a proper
// close frame is released at 30 s. qa-harness saw a closed viewer hold its
// device for ~4 minutes, until the page navigated away and the TCP connection
// finally died.
//
// A socket that has left OPEN can never carry the stream again, so there is
// nothing to wait for: if it is still not CLOSED after a short grace, terminate
// it. `terminate()` destroys the socket, which makes ws emit 'close' at once
// (code 1006), and the session's normal release runs.
//
// POLLED, not driven by traffic. A static screen with audio off produces no
// frames, so a check that only ran when a frame arrived would never run in the
// very session that is idle.

import WS from 'ws';

/** A healthy close completes in milliseconds (1–64 ms measured); ws's own bound is 30 s. */
export const CLOSING_GRACE_MS = 5000;
export const CLOSING_POLL_MS = 1000;

export interface StuckClosing {
    closingForMs: number;
    bufferedAmount: number;
}

export interface ClosingWatchdogOptions {
    graceMs?: number;
    pollMs?: number;
    onStuck?: (info: StuckClosing) => void;
}

/**
 * Watch `ws` and terminate it if it stays CLOSING for `graceMs`. Returns a stop
 * function; call it when the session is released, so a released session is never
 * terminated after the fact. The poll timer is unref'd and never keeps the
 * process alive.
 */
export function watchForStuckClosing(ws: WS, options: ClosingWatchdogOptions = {}): () => void {
    const graceMs = options.graceMs ?? CLOSING_GRACE_MS;
    const pollMs = options.pollMs ?? CLOSING_POLL_MS;
    let closingSince: number | undefined;
    let elapsed = 0;

    const timer = setInterval(() => {
        elapsed += pollMs;
        // The module's STATIC constants, not `ws.CLOSED` on the instance: they are
        // the same numbers, and a caller-supplied object is compared against the
        // protocol's values rather than against whatever fields it happens to carry.
        const state = ws.readyState;
        if (state === WS.CLOSED) {
            clearInterval(timer);
            return;
        }
        if (state !== WS.CLOSING) return;
        if (closingSince === undefined) {
            closingSince = elapsed;
            return;
        }
        const closingForMs = elapsed - closingSince;
        if (closingForMs < graceMs) return;
        clearInterval(timer);
        options.onStuck?.({ closingForMs, bufferedAmount: ws.bufferedAmount });
        ws.terminate();
    }, pollMs);
    timer.unref?.();

    return () => clearInterval(timer);
}
