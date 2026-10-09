import { isStaleTokenRefusal } from './staleToken';

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

/** Reloads for a stale token are not repeated inside this window (see `reloadForStaleToken`). */
export const STALE_TOKEN_RELOAD_GUARD_MS = 60_000;
const RELOAD_MARK_KEY = 'ws-scrcpy-web.staleTokenReloadAt';

/**
 * True when this page's token belongs to a process that has gone. A network
 * failure (the server is restarting) or any other answer is false: keep
 * retrying as before.
 */
export async function probeStaleToken(fetchFn: typeof fetch = fetch): Promise<boolean> {
    try {
        const res = await fetchFn(STALE_TOKEN_PROBE_URL, { cache: 'no-store' });
        if (res.ok) return false;
        return isStaleTokenRefusal(res.status, await res.json().catch(() => null));
    } catch {
        return false;
    }
}

export interface StaleTokenReloadDeps {
    storage: Pick<Storage, 'getItem' | 'setItem'> | null;
    now: () => number;
    reload: () => void;
}

function defaultDeps(): StaleTokenReloadDeps {
    let storage: StaleTokenReloadDeps['storage'] = null;
    try {
        storage = window.sessionStorage;
    } catch {
        // Storage can be disabled; then the reload is simply unguarded.
    }
    return { storage, now: () => Date.now(), reload: () => window.location.reload() };
}

/**
 * Reload so the document response hands this tab the running process's token.
 * Returns false WITHOUT reloading when this tab already reloaded for a stale
 * token inside `STALE_TOKEN_RELOAD_GUARD_MS`: a reload that did not fix it (a
 * browser refusing the cookie, say) must not become a reload loop. The caller
 * then stops retrying instead.
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
