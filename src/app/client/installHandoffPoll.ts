import { sameOriginUrl } from '../sameOriginUrl';
import { isStaleTokenRefusal } from './staleToken';

/**
 * The post-install port-discovery poll, shared by every "install the service"
 * button: Settings → Service and the first-run welcome modal.
 *
 * After a service install the page's own server hands the web port to the
 * service and exits, and the service then answers this origin with a NEW
 * per-process token. So the poll has to read three things that look like
 * failures as progress: a thrown fetch (the dead window between the exit and
 * the service binding), a stale-token 403 (the service is up and refusing this
 * page's old token), and the exiting local instance still answering about a
 * service it is not. Settings → Service learned all three by D4 (beta.141); the
 * welcome modal kept its own loop, which treated the first as fatal and the
 * second as "not ready" until it timed out (smoke 1.11 c, qa-harness). One loop
 * now serves both.
 */

/** One tick of the poll every this many ms. */
export const INSTALL_HANDOFF_POLL_INTERVAL_MS = 2000;
/** Ticks before the poll gives up: 30 × 2 s = one minute. */
export const INSTALL_HANDOFF_MAX_ITERATIONS = 30;
/** A single status request is abandoned after this long. */
export const INSTALL_HANDOFF_REQUEST_TIMEOUT_MS = 5000;
/** Grace before a same-port reconnect reloads, so the service has bound the port. */
export const INSTALL_HANDOFF_RECONNECT_DELAY_MS = 2500;
/** What either caller tells the user when the poll caps out. */
export const INSTALL_HANDOFF_TIMEOUT_MESSAGE =
    'service is running but port discovery timed out. reload the page at your usual address.';

/**
 * Classify one tick of the post-install port-discovery poll. Pure (no DOM or
 * timers) so it is unit-testable. After a service install the web port is handed
 * off to the service-Node, which identifies itself via `servedByService` (the
 * WS_SCRCPY_SERVICE env set on its unit):
 * - reachable AND servedByService -> the service has taken over. Same port (no
 *   config.json mtime change) -> reconnect (reload the current URL); a different
 *   bound port (mtime changed + known disk port) -> navigate there.
 * - otherwise (the local instance is still answering, or the brief hand-off dead
 *   window where nothing holds the port) -> keep polling until the cap, then
 *   timeout.
 *
 * Keying success on the POSITIVE servedByService signal — rather than catching a
 * transient unreachable tick (a race against the 2s poll) or a config.json mtime
 * change a same-port rebind never produces — removes the intermittent
 * "port discovery timed out" failure (beta.47).
 */
export type PollOutcome =
    | { kind: 'keep-polling' }
    | { kind: 'navigate'; port: number }
    | { kind: 'reconnect' }
    | { kind: 'timeout' };

export function classifyInstallPoll(args: {
    reachable: boolean;
    /** This tick was an `isStaleTokenRefusal`: a new process holds this origin. */
    tokenRejected: boolean;
    servedByService: boolean;
    configMtime: number | null;
    baselineMtime: number;
    diskWebPort: number | null;
    /** The port the browser is actually on, so a shift can be detected. */
    currentPort: number | null;
    /** Sticky: any answering instance has reported the SERVICE as running. */
    serviceSeenRunning: boolean;
    iterations: number;
    maxIterations: number;
}): PollOutcome {
    // A PORT SHIFT is its own positive signal, and it is the one case
    // servedByService can never deliver. MEASURED 2026-09-07 (qa-harness Arc 1b row
    // 4.3): the service could not bind 8000 because the exiting local instance still
    // held it, so it took 8001. This poll is SAME-ORIGIN, so it kept asking 8000 —
    // where servedByService is false by construction, since that flag is only ever
    // true inside the service process. The branch below written for "a different
    // bound port" was therefore unreachable in exactly the situation it exists for,
    // and the user sat on a dying instance until the timeout.
    //
    // The exiting local instance can answer both halves of the question: its
    // readDiskConfig reports diskWebPort from config.json, and its `status` comes
    // from an sc.exe/systemctl query about the SERVICE, not about itself. So once
    // the service is known to be running and the disk port differs from ours, we
    // know where to go — whoever is answering.
    const portMoved = args.diskWebPort != null && args.currentPort != null && args.diskWebPort !== args.currentPort;
    if (portMoved && (args.servedByService || args.serviceSeenRunning)) {
        return { kind: 'navigate', port: args.diskWebPort as number };
    }
    // Our token was refused on our own origin: the process that served this page
    // is gone and a new one (the service) holds the port. It cannot tell us
    // servedByService until we hold its token, and only a reload gets that.
    if (args.tokenRejected) {
        return { kind: 'reconnect' };
    }
    // Success requires a POSITIVE signal: the instance answering /api/service/status
    // is the service itself (WS_SCRCPY_SERVICE on its unit), not the exiting local
    // instance and not a transient dead port.
    if (args.reachable && args.servedByService) {
        // Different bound port -> navigate there; same port -> reload in place.
        if (args.configMtime != null && args.configMtime !== args.baselineMtime && args.diskWebPort != null) {
            return { kind: 'navigate', port: args.diskWebPort };
        }
        return { kind: 'reconnect' };
    }
    // Still the local instance answering, or the brief hand-off dead window:
    // keep waiting until the service identifies itself, then cap out.
    if (args.iterations > args.maxIterations) return { kind: 'timeout' };
    return { kind: 'keep-polling' };
}

/** What a tick learned, reported to `onTick` (progress) after it is classified. */
export interface InstallHandoffTick {
    iterations: number;
    reachable: boolean;
    tokenRejected: boolean;
    servedByService: boolean;
    outcome: PollOutcome;
}

/** The pieces of the browser the poll touches, injectable for tests. */
export interface InstallHandoffPollDeps {
    fetch?: (input: string, init?: RequestInit) => Promise<Response>;
    setInterval?: (fn: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
    /** Where the browser is: `href` builds the navigate URL, `port` detects a shift. */
    location?: { href: string; port: string };
}

export interface InstallHandoffPollOptions {
    /** `configMtime` from the install response (0 when the server sent none). */
    baselineMtime: number;
    /** The service holds this origin on a different port: go to `url` (same host, that port). */
    onNavigate: (url: string, port: number) => void;
    /**
     * The service holds this origin on the same port (or refused our stale token):
     * reload. The caller schedules the reload, conventionally after
     * `INSTALL_HANDOFF_RECONNECT_DELAY_MS`.
     */
    onReconnect: () => void;
    /** The cap was reached with no hand-off seen. */
    onTimeout: () => void;
    /** Every tick, after classification. */
    onTick?: (tick: InstallHandoffTick) => void;
    intervalMs?: number;
    maxIterations?: number;
    requestTimeoutMs?: number;
    deps?: InstallHandoffPollDeps;
}

export interface InstallHandoffPoll {
    /** Stop polling; no further callback fires. */
    stop(): void;
}

/**
 * Start polling GET /api/service/status until the service has taken over, then
 * report exactly one of navigate / reconnect / timeout. A thrown or aborted
 * fetch is never fatal on its own: it is the dead window, and only the cap ends
 * the poll without a hand-off.
 */
export function startInstallHandoffPoll(opts: InstallHandoffPollOptions): InstallHandoffPoll {
    const deps = opts.deps ?? {};
    // Resolved at call time, not import time, so fake timers and a stubbed
    // global fetch installed by a test are the ones used.
    const doFetch = deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
    const startTimer = deps.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms));
    const stopTimer =
        deps.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>));
    const loc = deps.location ?? window.location;
    const intervalMs = opts.intervalMs ?? INSTALL_HANDOFF_POLL_INTERVAL_MS;
    const maxIterations = opts.maxIterations ?? INSTALL_HANDOFF_MAX_ITERATIONS;
    const requestTimeoutMs = opts.requestTimeoutMs ?? INSTALL_HANDOFF_REQUEST_TIMEOUT_MS;

    let iterations = 0;
    // A tick can still be in flight when an earlier one ends the poll (a request
    // may take up to requestTimeoutMs, longer than the interval); this keeps the
    // outcome single.
    let finished = false;
    // Sticky across ticks: the origin dies mid-hand-off, so what we learned
    // while the local instance was still answering has to outlive it.
    let sawServiceRunning = false;
    let lastDiskWebPort: number | null = null;
    const browserPort = Number(loc.port) || null;

    let handle: unknown;
    const finish = (): void => {
        finished = true;
        stopTimer(handle);
    };

    const tick = async (): Promise<void> => {
        if (finished) return;
        iterations++;
        // A thrown/aborted fetch means whoever was answering has dropped —
        // the local instance exiting, or the brief hand-off dead window. We
        // do NOT treat that as success: we wait for the service to answer with
        // servedByService=true (below) before reconnecting/navigating.
        let reachable = true;
        let tokenRejected = false;
        let servedByService = false;
        let configMtime: number | null = null;
        let diskWebPort: number | null = null;
        try {
            const statusResp = await doFetch('/api/service/status', {
                signal: AbortSignal.timeout(requestTimeoutMs),
            });
            if (!statusResp.ok) {
                const body: unknown = await statusResp.json().catch(() => null);
                tokenRejected = isStaleTokenRefusal(statusResp.status, body);
            } else {
                const statusData = (await statusResp.json()) as {
                    configMtime?: number;
                    diskWebPort?: number;
                    servedByService?: boolean;
                    status?: string;
                };
                configMtime = statusData.configMtime ?? null;
                diskWebPort = statusData.diskWebPort ?? null;
                servedByService = statusData.servedByService === true;
                // `status` is the SERVICE's state (sc.exe / systemctl), not the
                // answering process's, so the local instance can tell us the
                // service came up even though it is not the service.
                if (statusData.status === 'running') {
                    sawServiceRunning = true;
                }
                if (diskWebPort != null) {
                    lastDiskWebPort = diskWebPort;
                }
            }
        } catch {
            reachable = false;
        }
        if (finished) return;
        const outcome = classifyInstallPoll({
            reachable,
            tokenRejected,
            servedByService,
            configMtime,
            baselineMtime: opts.baselineMtime,
            // The last port we saw on disk, not just this tick's: an
            // unreachable tick carries no body, and that is precisely the
            // tick after the local instance exits.
            diskWebPort: diskWebPort ?? lastDiskWebPort,
            currentPort: browserPort,
            serviceSeenRunning: sawServiceRunning,
            iterations,
            maxIterations,
        });
        opts.onTick?.({ iterations, reachable, tokenRejected, servedByService, outcome });
        switch (outcome.kind) {
            case 'navigate':
                finish();
                // Same host the browser is on, new port. A literal localhost
                // here sent every off-box client to its own machine
                // (qa-harness Arc 1b, rows 4.3 / 12.2).
                opts.onNavigate(sameOriginUrl(outcome.port, loc.href), outcome.port);
                return;
            case 'reconnect':
                finish();
                opts.onReconnect();
                return;
            case 'timeout':
                finish();
                opts.onTimeout();
                return;
            case 'keep-polling':
                return;
        }
    };

    handle = startTimer(() => {
        void tick();
    }, intervalMs);

    return {
        stop(): void {
            if (!finished) finish();
        },
    };
}
