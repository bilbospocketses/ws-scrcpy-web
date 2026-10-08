import type { UpdatesStatusResponse } from '../../common/UpdateEvents';
import { isElevationDeclined } from './serviceFailureMessage';

/**
 * What the two callers of POST /api/updates/apply (the top-bar chip and
 * Settings → Updates) make of an apply that did not answer 200.
 *
 * On Windows the apply downloads the update before it installs (~60 MB), so
 * the request can stay open for minutes. A proxy in front of the app gives up
 * on it first (nginx answers 504 at ~60 s) and a browser aborts it (Firefox at
 * ~300 s), while the install carries on and ends with the server going down.
 * So an answer that came from something other than the app, or no answer at
 * all, says nothing about the install: the callers keep reading the status
 * ({@link LostApplyWatch}) rather than report a failure.
 */

/**
 * How long a lost apply may sit at `ready` with no failure recorded before the
 * callers stop waiting for it. `ready` is also what the status says between
 * the end of the download and the server going down (the hygiene, and on
 * Windows local mode up to 5 s waiting for the operation-server's port), so a
 * read of it alone is not a failure. Thirty seconds covers that with room; past
 * it the apply either never reached the server or ended without recording why.
 */
export const LOST_APPLY_GRACE_MS = 30 * 1000;

/** Gateway answers: a proxy that gave up waiting, or the app not answering behind it. */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

export type ApplyFailure =
    /** A declined elevation prompt (403 uac-declined). Nothing changed. */
    | { kind: 'declined' }
    /** The app refused or failed the apply; `reason` is its error when it gave one. */
    | { kind: 'failed'; reason: string | undefined }
    /** Something between the browser and the app answered; the install may still be running. */
    | { kind: 'lost' };

/**
 * Classify a non-2xx apply response. The app's own refusals carry a JSON
 * `error` (UpdatesApi answers 409, 500 and 503 that way), so a gateway status
 * WITH one is the app's, and one without is the proxy's. Reads the body.
 */
export async function classifyFailedApply(r: Response): Promise<ApplyFailure> {
    if (await isElevationDeclined(r)) return { kind: 'declined' };
    let reason: string | undefined;
    try {
        const body = (await r.json()) as { error?: unknown } | null;
        if (typeof body?.error === 'string' && body.error.length > 0) reason = body.error;
    } catch {
        // Not JSON: not the app's own answer.
    }
    if (reason === undefined && GATEWAY_STATUSES.has(r.status)) return { kind: 'lost' };
    return { kind: 'failed', reason };
}

export type LostApplyView =
    | { kind: 'downloading'; progress: number | undefined }
    /** Still waiting: the install may be under way. */
    | { kind: 'installing' }
    /** The server recorded why the install failed. */
    | { kind: 'failed'; reason: string }
    /** `ready` for longer than {@link LOST_APPLY_GRACE_MS} with nothing recorded. */
    | { kind: 'gave-up' }
    /** The status moved on (idle, error): this apply is over. */
    | { kind: 'ended' };

/**
 * Reads the status for an apply whose answer was lost. A status read that
 * FAILS after that is the server going down for the update; the callers handle
 * that themselves, since it is not a status.
 */
export class LostApplyWatch {
    private readySince: number | null = null;

    constructor(
        private readonly graceMs = LOST_APPLY_GRACE_MS,
        private readonly now: () => number = () => Date.now(),
    ) {}

    read(s: UpdatesStatusResponse): LostApplyView {
        if (s.status !== 'ready') this.readySince = null;
        switch (s.status) {
            case 'downloading':
                return { kind: 'downloading', progress: s.progress };
            case 'checking':
                // The check a failed install starts; its answer carries the reason.
                return { kind: 'installing' };
            case 'ready': {
                if (s.lastApplyError) return { kind: 'failed', reason: s.lastApplyError };
                const now = this.now();
                if (this.readySince === null) this.readySince = now;
                return now - this.readySince >= this.graceMs ? { kind: 'gave-up' } : { kind: 'installing' };
            }
            default:
                return { kind: 'ended' };
        }
    }
}
