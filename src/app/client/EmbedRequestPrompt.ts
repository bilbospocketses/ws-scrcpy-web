import { EmbedRequestModal } from './EmbedRequestModal';

/**
 * Watches for another local app asking permission to embed this one in an
 * iframe, and puts the decision to the user.
 *
 * The asking app cannot grant itself anything — it can only cause this prompt
 * to appear (see server/security/embedRequests.ts). Approving here is what
 * writes the origin to config.json and applies it to the running server.
 *
 * The origin is shown verbatim and deny is the safe answer, because the one
 * attack this flow cannot rule out is a local process asking for an origin it
 * controls and hoping the user clicks through.
 */

const POLL_INTERVAL_MS = 5000;

/** Mirrors REQUEST_TTL_MS on the server; the countdown must not outlive it. */
const REQUEST_TTL_MS = 5 * 60 * 1000;

interface PendingEmbedRequest {
    id: string;
    origin: string;
    appName: string;
    createdAt: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
// Ids already shown, so a prompt is not re-raised while one is open or after
// the user answered it.
const handled = new Set<string>();
let promptOpen = false;

async function fetchPending(): Promise<PendingEmbedRequest | null> {
    try {
        const res = await fetch('/api/embed-request', { headers: { Accept: 'application/json' } });
        if (!res.ok) return null;
        const body = (await res.json()) as { request: PendingEmbedRequest | null };
        return body.request ?? null;
    } catch {
        // Server restarting or offline — try again on the next tick.
        return null;
    }
}

/**
 * Server-side status of one request. Used while a prompt is open, since the background poller is
 * paused then and nothing else would notice the asking app withdrawing.
 */
async function fetchStatus(id: string): Promise<string | null> {
    try {
        const res = await fetch(`/embed-request/${encodeURIComponent(id)}`, {
            headers: { Accept: 'application/json' },
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { status?: string };
        return body.status ?? null;
    } catch {
        return null;
    }
}

async function sendDecision(id: string, approved: boolean): Promise<void> {
    try {
        await fetch('/api/embed-request/decision', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, approved }),
        });
    } catch {
        // The request expires on its own if the decision never lands.
    }
}

async function checkOnce(): Promise<void> {
    if (promptOpen) return;

    const request = await fetchPending();
    if (!request || handled.has(request.id)) return;

    handled.add(request.id);
    promptOpen = true;
    try {
        // Count down the time the server will actually still honour, not a fresh
        // five minutes — the request may have been raised before this page loaded.
        const elapsed = Math.max(0, Date.now() - request.createdAt);
        const decision = await EmbedRequestModal.ask({
            appName: request.appName,
            origin: request.origin,
            expiresInMs: Math.max(0, REQUEST_TTL_MS - elapsed),
            pollStatus: () => fetchStatus(request.id),
        });

        // Nothing is sent when the request ended on its own — expired, or withdrawn by the app
        // that asked. The server has already moved it out of pending, and a decision naming a
        // non-pending request is refused anyway. Only the two buttons produce a decision.
        if (decision === 'approved' || decision === 'denied') {
            await sendDecision(request.id, decision === 'approved');
        }
    } finally {
        promptOpen = false;
    }
}

/** Begin watching for embed requests. Safe to call more than once. */
export function startEmbedRequestWatch(): void {
    if (timer !== null) return;
    void checkOnce();
    timer = setInterval(() => void checkOnce(), POLL_INTERVAL_MS);
}

export function stopEmbedRequestWatch(): void {
    if (timer !== null) {
        clearInterval(timer);
        timer = null;
    }
}
