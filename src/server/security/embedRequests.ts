import { randomUUID } from 'node:crypto';
import { parseFrameAncestorOrigin } from './frameGuard';

/**
 * Consent flow for embedding permission.
 *
 * Another local app (e.g. Control Menu) cannot edit our config.json, and asking
 * a user to hand-edit a file in ProgramData to make an iframe work is a poor
 * experience. Instead it *asks*, a human approves in this app's own UI, and the
 * origin is written for them.
 *
 * The split is the whole security design:
 *
 *   - Asking is unauthenticated but can do nothing except make a prompt appear.
 *     It never touches config.
 *   - Granting happens only through the admin-gated API, from this app's own
 *     origin, driven by a human clicking Approve.
 *
 * A browser page cannot even ask: `fetch()` always sends an Origin header, and
 * the origin guard rejects a cross-origin one on every non-GET request. Only a
 * non-browser local caller reaches the request endpoint at all. The residual
 * risk is a local native process spamming prompts or social-engineering an
 * approval, which is why exactly one request is pending at a time, it expires,
 * and the UI shows the requesting origin verbatim with deny as the safe action.
 */

export const REQUEST_TTL_MS = 5 * 60 * 1000;

export type EmbedRequestStatus = 'pending' | 'approved' | 'denied' | 'cancelled' | 'expired' | 'unknown';

export interface EmbedRequest {
    id: string;
    origin: string;
    appName: string;
    createdAt: number;
}

interface StoredRequest extends EmbedRequest {
    status: Exclude<EmbedRequestStatus, 'unknown'>;
}

// At most one request is pending at a time; a new one replaces it (an app that
// asks twice should not queue two prompts). Resolved requests are retained only
// so the asking app can read the outcome once, and are dropped after TTL.
let current: StoredRequest | null = null;

/** Test seam so the TTL can be exercised without waiting. */
let now: () => number = () => Date.now();

export function _setClockForTest(clock: () => number): void {
    now = clock;
}

export function _resetForTest(): void {
    current = null;
    now = () => Date.now();
}

function expireIfStale(): void {
    if (current && current.status === 'pending' && now() - current.createdAt >= REQUEST_TTL_MS) {
        current.status = 'expired';
    }
}

/**
 * Record a request to embed the app. Returns null when the origin is not a
 * usable frame ancestor, so a caller cannot park junk in the prompt.
 */
export function createRequest(origin: string, appName: string): EmbedRequest | null {
    const normalized = parseFrameAncestorOrigin(origin);
    if (normalized === null) return null;

    const name = appName.trim().slice(0, 64);
    current = {
        id: randomUUID(),
        origin: normalized,
        appName: name.length > 0 ? name : 'An application',
        createdAt: now(),
        status: 'pending',
    };
    return { id: current.id, origin: current.origin, appName: current.appName, createdAt: current.createdAt };
}

/** The request awaiting a decision, for the approval UI. */
export function getPendingRequest(): EmbedRequest | null {
    expireIfStale();
    if (current?.status !== 'pending') return null;
    return { id: current.id, origin: current.origin, appName: current.appName, createdAt: current.createdAt };
}

/** Outcome lookup for the app that asked. */
export function getStatus(id: string): EmbedRequestStatus {
    expireIfStale();
    if (!current || current.id !== id) return 'unknown';
    return current.status;
}

/**
 * Record a human's decision. Returns the request it applied to, or null when
 * the id does not match a pending request — a stale prompt (already answered,
 * expired, or superseded) must never approve anything.
 */
export function resolveRequest(id: string, approved: boolean): EmbedRequest | null {
    expireIfStale();
    if (!current || current.id !== id || current.status !== 'pending') return null;

    current.status = approved ? 'approved' : 'denied';
    return { id: current.id, origin: current.origin, appName: current.appName, createdAt: current.createdAt };
}

/**
 * Withdraw a request the asking app no longer wants an answer to. Returns whether anything was
 * withdrawn.
 *
 * Only ever retracts: like resolveRequest it refuses an id that is not currently pending, so a
 * cancel can never undo a decision a human already made. Leaving an abandoned prompt on screen is
 * worse than closing it — approving it would grant permission to an app that stopped waiting.
 */
export function cancelRequest(id: string): boolean {
    expireIfStale();
    if (!current || current.id !== id || current.status !== 'pending') return false;

    current.status = 'cancelled';
    return true;
}
