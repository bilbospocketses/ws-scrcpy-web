import { isStaleTokenRefusal } from './staleToken';
import { showStatusBanner } from './statusBanner';

/**
 * Item 174 (2026-10-08): after a local-mode update, a tab left open from the
 * first launch holds the previous process's instance token. The new process
 * refuses its websocket handshake with a plain 403, which a browser reports to
 * the page only as a close with code 1006, the same as "server down". So the
 * device list kept retrying every 2 s, for as long as the tab stayed open, and
 * the server logged every refusal.
 *
 * The handshake cannot say why it was refused, but an HTTP request carrying the
 * same cookie can: `GET /api/auth/me` is token-gated (instanceToken.ts), cheap,
 * read-only, and allow-listed by the sign-in gate, so with a stale token it is
 * answered with the stale-token 403 (`isStaleTokenRefusal`) and nothing else.
 */
export const STALE_TOKEN_PROBE_URL = '/api/auth/me';

/** How long the probe may take before it counts as "no answer" (the server is busy or restarting). */
export const STALE_TOKEN_PROBE_TIMEOUT_MS = 5000;

/** Reloads for a stale token are not repeated inside this window (see `reloadForStaleToken`). */
export const STALE_TOKEN_RELOAD_GUARD_MS = 60_000;
const RELOAD_MARK_KEY = 'ws-scrcpy-web.staleTokenReloadAt';

/**
 * What the probe learned: `stale` (this page's token belongs to a process
 * that has gone), `ok` (the token works), or `unknown` (no answer in time, a
 * network failure while the server restarts, or any other reply). Only `stale`
 * stops the retry loop.
 */
export type TokenProbe = 'stale' | 'ok' | 'unknown';

export async function probeStaleToken(
    fetchFn: typeof fetch = fetch,
    timeoutMs: number = STALE_TOKEN_PROBE_TIMEOUT_MS,
): Promise<TokenProbe> {
    // AbortSignal.timeout is missing from older WebViews; without this fallback
    // the call would throw and the probe would never report stale.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        let signal: AbortSignal;
        if (typeof AbortSignal.timeout === 'function') {
            signal = AbortSignal.timeout(timeoutMs);
        } else {
            const ctrl = new AbortController();
            timer = setTimeout(() => ctrl.abort(), timeoutMs);
            signal = ctrl.signal;
        }
        const res = await fetchFn(STALE_TOKEN_PROBE_URL, { cache: 'no-store', signal });
        if (res.ok) return 'ok';
        return isStaleTokenRefusal(res.status, await res.json().catch(() => null)) ? 'stale' : 'unknown';
    } catch {
        return 'unknown';
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

type MarkStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface StaleTokenReloadDeps {
    storage: MarkStorage | null;
    now: () => number;
    reload: () => void;
}

function sessionStore(): MarkStorage | null {
    try {
        return window.sessionStorage;
    } catch {
        // Storage can be disabled; then the reload is simply unguarded.
        return null;
    }
}

function defaultDeps(): StaleTokenReloadDeps {
    return { storage: sessionStore(), now: () => Date.now(), reload: () => window.location.reload() };
}

/**
 * Reload so the document response hands this tab the running process's token.
 *
 * Returns false WITHOUT reloading when this tab reloaded for a stale token
 * inside `STALE_TOKEN_RELOAD_GUARD_MS` and has not connected since: that reload
 * did not help (a browser refusing the cookie, say), and repeating it would be
 * a reload loop. "Connected since" is what `clearStaleTokenReloadMark` records,
 * so a SECOND restart shortly after a reload that worked reloads again rather
 * than freezing the page.
 */
export function reloadForStaleToken(deps: StaleTokenReloadDeps = defaultDeps()): boolean {
    const now = deps.now();
    const last = Number(deps.storage?.getItem(RELOAD_MARK_KEY) ?? Number.NaN);
    if (Number.isFinite(last) && now - last >= 0 && now - last < STALE_TOKEN_RELOAD_GUARD_MS) {
        return false;
    }
    try {
        deps.storage?.setItem(RELOAD_MARK_KEY, String(now));
    } catch {
        // Quota or disabled storage: reload anyway.
    }
    deps.reload();
    return true;
}

/**
 * The page reached the server with its token (a websocket message arrived, or
 * the probe answered 200): any earlier stale-token reload worked, so the guard
 * must not hold against the next one.
 */
export function clearStaleTokenReloadMark(storage: MarkStorage | null = sessionStore()): void {
    try {
        storage?.removeItem(RELOAD_MARK_KEY);
    } catch {
        // Nothing to clear.
    }
}

/** The text of the notice shown when the retry loop gives up (lowercase, per the app's UI text rule). */
export const STALE_TOKEN_NOTICE_TEXT =
    'this page lost its connection to the server and could not get it back. reload the page to reconnect.';

/**
 * Tell the user the device list stopped retrying, with a reload action, rather
 * than leaving a silent dead page. One notice per page, whichever tracker
 * gives up first.
 */
export function showStaleTokenNotice(reload: () => void = () => window.location.reload()): HTMLElement {
    const existing = document.querySelector<HTMLElement>('[data-stale-token-notice]');
    if (existing) return existing;
    const banner = showStatusBanner(STALE_TOKEN_NOTICE_TEXT, 'reload', reload);
    banner.setAttribute('data-stale-token-notice', '');
    banner.setAttribute('role', 'alert');
    return banner;
}
