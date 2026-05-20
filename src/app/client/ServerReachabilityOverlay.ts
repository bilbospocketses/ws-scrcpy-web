/**
 * Server-reachability overlay.
 *
 * During an in-app update (service-mode upgrade), the launcher exits + the
 * port stops listening for ~12-15 seconds while Servy fires the post-stop
 * bat (which delays + sc starts a fresh service launcher). Without
 * intervention, the user's browser shows the OS-level "this site can't be
 * reached" page — confusing UX, easy to misread as "app broke."
 *
 * This module mounts a persistent overlay that:
 *   1. Polls a tiny endpoint at HEARTBEAT_INTERVAL_MS.
 *   2. After CONSECUTIVE_FAILURES_BEFORE_OVERLAY consecutive failures,
 *      shows the overlay ("ws-scrcpy-web is updating — reconnecting…").
 *   3. While the overlay is up, polls more aggressively at
 *      RECOVERY_POLL_INTERVAL_MS until the heartbeat succeeds.
 *   4. On recovery, removes the overlay and reloads the page so the UI
 *      re-evaluates against the freshly-restarted server (config, version,
 *      etc. may have changed).
 *
 * The reload-on-recovery is the safest default — the alternative
 * (just-remove-overlay-and-keep-going) would leave WebSocket connections,
 * cached state, and any in-progress UI in stale-stranded form. Reload is
 * one extra second the user wouldn't have seen anyway because they were
 * staring at the overlay.
 */

const HEARTBEAT_ENDPOINT = '/api/config';
// 5s normal heartbeat. Cheap enough to run continuously, slow enough that
// network blips don't show false overlays.
const HEARTBEAT_INTERVAL_MS = 5_000;
// 2s during recovery — user is staring at the overlay, snappier feels
// better. Server is fine with this load (one fetch per 2s is trivial).
const RECOVERY_POLL_INTERVAL_MS = 2_000;
// Show overlay only after this many consecutive failures. One missed
// heartbeat is normal network jitter; two indicates the server is
// genuinely down.
const CONSECUTIVE_FAILURES_BEFORE_OVERLAY = 2;
// Per-request fetch timeout. Aborts hanging connections so a TCP
// half-open state (which Velopack swap can briefly produce) doesn't keep
// us in pending-state forever.
const FETCH_TIMEOUT_MS = 3_000;

interface OverlayHandle {
    overlay: HTMLDivElement;
    detail: HTMLDivElement;
}

let consecutiveFailures = 0;
let overlayHandle: OverlayHandle | null = null;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let lastIntervalMs = 0;

function buildOverlay(): OverlayHandle {
    const overlay = document.createElement('div');
    overlay.className = 'server-reachability-overlay';

    const card = document.createElement('div');
    card.className = 'server-reachability-card';

    const heading = document.createElement('div');
    heading.className = 'server-reachability-heading';
    heading.textContent = 'ws-scrcpy-web is updating';

    const detail = document.createElement('div');
    detail.className = 'server-reachability-detail';
    detail.textContent = 'reconnecting…';

    const note = document.createElement('div');
    note.className = 'server-reachability-note';
    note.textContent = 'the page will reload automatically when the server is back';

    card.appendChild(heading);
    card.appendChild(detail);
    card.appendChild(note);
    overlay.appendChild(card);

    return { overlay, detail };
}

function showOverlay(): void {
    if (overlayHandle) return;
    overlayHandle = buildOverlay();
    document.body.appendChild(overlayHandle.overlay);
}

function hideOverlay(): void {
    if (!overlayHandle) return;
    overlayHandle.overlay.remove();
    overlayHandle = null;
}

function setPollInterval(ms: number): void {
    if (ms === lastIntervalMs && intervalHandle !== null) return;
    if (intervalHandle !== null) clearInterval(intervalHandle);
    lastIntervalMs = ms;
    intervalHandle = setInterval(() => {
        void heartbeatOnce();
    }, ms);
}

async function heartbeatOnce(): Promise<void> {
    let ok = false;
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
        try {
            const r = await fetch(HEARTBEAT_ENDPOINT, {
                method: 'GET',
                cache: 'no-store',
                signal: ctrl.signal,
            });
            ok = r.ok;
        } finally {
            clearTimeout(t);
        }
    } catch {
        ok = false;
    }

    if (ok) {
        if (overlayHandle) {
            // Recovery — server is back. Reload so the UI re-evaluates
            // against post-restart state. Slight delay so the user sees
            // the overlay finish acknowledging recovery.
            if (overlayHandle.detail) {
                overlayHandle.detail.textContent = 'reconnected — reloading…';
            }
            setTimeout(() => {
                location.reload();
            }, 400);
        }
        consecutiveFailures = 0;
        if (lastIntervalMs !== HEARTBEAT_INTERVAL_MS) {
            setPollInterval(HEARTBEAT_INTERVAL_MS);
        }
        return;
    }

    consecutiveFailures += 1;
    if (consecutiveFailures >= CONSECUTIVE_FAILURES_BEFORE_OVERLAY) {
        showOverlay();
        // Once visible, poll harder until recovery.
        if (lastIntervalMs !== RECOVERY_POLL_INTERVAL_MS) {
            setPollInterval(RECOVERY_POLL_INTERVAL_MS);
        }
    }
}

/**
 * Start the reachability watchdog. Safe to call multiple times; only
 * starts the interval once.
 */
export function startServerReachabilityWatchdog(): void {
    if (intervalHandle !== null) return;
    // Don't show the overlay on the very first failure tick — the
    // initial page load already established connectivity, so wait one
    // poll cycle before counting failures. If the very first heartbeat
    // fails (server died between page load and now), the second cycle
    // crosses the threshold and the overlay shows ~10s later. Acceptable.
    setPollInterval(HEARTBEAT_INTERVAL_MS);
}

/**
 * Stop the watchdog and hide any visible overlay. Intended for tests
 * and a hypothetical future explicit-shutdown path. Not currently
 * wired from anywhere in production (the watchdog runs for the page's
 * lifetime).
 */
export function stopServerReachabilityWatchdog(): void {
    if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
    lastIntervalMs = 0;
    consecutiveFailures = 0;
    hideOverlay();
}
