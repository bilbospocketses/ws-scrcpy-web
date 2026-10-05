import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { type APIRequestContext, type Browser, type BrowserContext, expect, type Page } from '@playwright/test';
import { type Credentials, loginAs, SESSION_COOKIE } from './auth';

/**
 * Login sessions on a spec-owned server: signing in, reading and backdating
 * the sessions row behind a cookie, and live WebSockets held open in a page so
 * a row can watch what ending a session does to them.
 *
 * Backdating writes the live server's database, so these are for private
 * servers only; the shared server's sessions belong to every later spec.
 */

/**
 * ONE login, and a non-200 throws with the body. Never retried: the lockout is
 * per user row, and these rows only ever type correct passwords.
 */
export async function signIn(ctx: APIRequestContext, creds: Credentials): Promise<void> {
    const res = await loginAs(ctx, creds);
    if (res.status() !== 200) {
        throw new Error(`login as ${creds.username} answered ${res.status()} ${await res.text()} — never retried`);
    }
    expect(await res.json()).toEqual({ ok: true });
}

/** A browser context on a spec-owned server that has loaded '/' and signed in as `creds`. */
export async function signedInVisitor(
    browser: Browser,
    baseURL: string,
    creds: Credentials,
): Promise<{ context: BrowserContext; page: Page }> {
    const context = await browser.newContext({ baseURL });
    const page = await context.newPage();
    await page.goto('/');
    await signIn(context.request, creds);
    return { context, page };
}

/** The session cookie a context holds for `baseURL`, as the raw value the server hashed. */
export async function sidOf(ctx: APIRequestContext | BrowserContext): Promise<string> {
    const state = await ctx.storageState();
    const sid = state.cookies.find((c) => c.name === SESSION_COOKIE)?.value;
    if (!sid) throw new Error('no session cookie in this context');
    return sid;
}

// ---------------------------------------------------------------------------
// The sessions table, read and written directly (row 18.18)
// ---------------------------------------------------------------------------

export interface StoredSession {
    user_id: number;
    created_at: number;
    expires_at: number;
    last_seen_at: number;
}

/** sha256 hex of the cookie value: the only form the server stores (session.ts). */
export function tokenHash(sid: string): string {
    return createHash('sha256').update(sid).digest('hex');
}

/**
 * Open the live server's database for one statement. The server holds the same
 * WAL-mode file open, so a busy timeout covers the moment a write of its own is
 * in flight; the handle is closed at once so nothing lingers into teardown.
 */
function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(dbPath);
    try {
        db.exec('PRAGMA busy_timeout = 5000');
        return fn(db);
    } finally {
        db.close();
    }
}

export function readSession(dbPath: string, sid: string): StoredSession | undefined {
    return withDb(
        dbPath,
        (db) =>
            db
                .prepare('SELECT user_id, created_at, expires_at, last_seen_at FROM sessions WHERE token_hash = ?')
                .get(tokenHash(sid)) as StoredSession | undefined,
    );
}

/** Move a session's clock: `lastSeenAt` and the sliding deadline it implies (`lastSeenAt + ttl`). */
export function backdateSession(dbPath: string, sid: string, lastSeenAt: number, ttlMs: number): void {
    const changes = withDb(dbPath, (db) => {
        const r = db
            .prepare('UPDATE sessions SET created_at = ?, last_seen_at = ?, expires_at = ? WHERE token_hash = ?')
            .run(lastSeenAt, lastSeenAt, lastSeenAt + ttlMs, tokenHash(sid));
        return Number(r.changes);
    });
    expect(changes, 'exactly one sessions row backdated').toBe(1);
}

// ---------------------------------------------------------------------------
// Live sockets held open inside a page (row 18.17)
// ---------------------------------------------------------------------------

export interface SocketState {
    readyState: number;
    close: { code: number; reason: string; wasClean: boolean } | null;
}

/**
 * Open a WebSocket inside the page, keep it in `window.__e2eSockets[key]`, and
 * record how it ends. Resolves once the socket is OPEN and has been SERVED: in
 * locked mode the server completes the handshake before it checks the session,
 * so 'open' alone would also be reported for a socket about to be refused 4401.
 * The served proof is a reply only the scan handler can send, after the gate.
 */
export async function openLiveSocket(page: Page, key: string, pathAndQuery = '/ws-scan'): Promise<void> {
    const opened = await page.evaluate(
        ({ key, pathAndQuery }) =>
            new Promise<string>((resolve) => {
                type Entry = {
                    ws: WebSocket;
                    close: { code: number; reason: string; wasClean: boolean } | null;
                };
                const w = window as unknown as { __e2eSockets?: Record<string, Entry> };
                w.__e2eSockets ??= {};
                const url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${pathAndQuery}`;
                const ws = new WebSocket(url);
                const entry: Entry = { ws, close: null };
                w.__e2eSockets[key] = entry;
                ws.addEventListener('close', (e) => {
                    entry.close = { code: e.code, reason: e.reason, wasClean: e.wasClean };
                    resolve(`closed ${e.code} ${e.reason}`);
                });
                ws.addEventListener('open', () => resolve('open'));
            }),
        { key, pathAndQuery },
    );
    expect(opened, `socket ${key} must open`).toBe('open');
    await expectSocketServed(page, key);
}

/**
 * Prove the socket is still live AND still served right now: one invalid frame,
 * one `scan.error` reply. A socket that was closed — or one the server stopped
 * reading — cannot answer.
 */
export async function expectSocketServed(page: Page, key: string): Promise<void> {
    const reply = await page.evaluate(
        (key) =>
            new Promise<string>((resolve) => {
                type Entry = {
                    ws: WebSocket;
                    close: { code: number; reason: string; wasClean: boolean } | null;
                };
                const entry = (window as unknown as { __e2eSockets?: Record<string, Entry> }).__e2eSockets?.[key];
                if (!entry) {
                    resolve(`no socket ${key}`);
                    return;
                }
                if (entry.ws.readyState !== WebSocket.OPEN) {
                    resolve(`socket ${key} not open: readyState ${entry.ws.readyState} ${JSON.stringify(entry.close)}`);
                    return;
                }
                const timer = setTimeout(() => {
                    entry.ws.removeEventListener('message', onMessage);
                    resolve(`socket ${key}: no reply within 5000 ms`);
                }, 5_000);
                const onMessage = (event: MessageEvent) => {
                    clearTimeout(timer);
                    entry.ws.removeEventListener('message', onMessage);
                    resolve(String(event.data));
                };
                entry.ws.addEventListener('message', onMessage);
                entry.ws.send('this is not json');
            }),
        key,
    );
    let parsed: unknown;
    try {
        parsed = JSON.parse(reply);
    } catch {
        parsed = reply; // a failure description from the page; the toEqual below then prints it
    }
    expect(parsed, `socket ${key} must still be served`).toEqual({ type: 'scan.error', reason: 'invalid JSON' });
}

export async function socketState(page: Page, key: string): Promise<SocketState> {
    return page.evaluate((key) => {
        type Entry = {
            ws: WebSocket;
            close: { code: number; reason: string; wasClean: boolean } | null;
        };
        const entry = (window as unknown as { __e2eSockets?: Record<string, Entry> }).__e2eSockets?.[key];
        if (!entry) throw new Error(`no socket ${key}`);
        return { readyState: entry.ws.readyState, close: entry.close };
    }, key);
}

/** What `SocketRegistry` sends a socket whose login ended (socketRegistry.ts). */
export const REVOKED: SocketState = {
    readyState: 3, // WebSocket.CLOSED
    close: { code: 4401, reason: 'session ended', wasClean: true },
};
