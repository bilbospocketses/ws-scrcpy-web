import type { FirstRunStatus } from '../../common/ConfigEvents';
import { OPERATOR_REFUSAL_ERROR } from '../../common/remoteAdmin';
import type { Role } from './AuthClient';

// Settings areas that only an admin may see/use. Everything NOT listed here is
// user-level and always visible. The SERVER enforces the same set via requireAdmin
// (403) — this is the cosmetic UI half.
export const ADMIN_ONLY_SECTIONS = new Set<string>([
    'updates',
    'service',
    'users',
    'webPort',
    'serverControls',
    // `/api/tls/*` is admin-gated server-side (TlsApi.ts) -- an ungated panel
    // here would 403 on every read for a non-admin, same "reads as a bug"
    // anti-pattern the `dependencies` entry below documents (finding 9.6).
    'localHttps',
    // Who may frame this app is a security decision; the server enforces the same
    // via requireLocalAdmin on /api/embed-origins.
    'embedOrigins',
    // The dependency API answers 403 for a non-admin, so an ungated panel did
    // not show less — it showed "Failed to load dependencies". An authorization
    // boundary that manifests as an error message reads as a bug to the user
    // and as coverage to the checklist (finding 9.6).
    'dependencies',
]);

/** True if `role` may see `section`. User-level sections are always visible; admin-only ones require role==='admin'. */
export function canSeeSection(role: Role | null | undefined, section: string): boolean {
    if (!ADMIN_ONLY_SECTIONS.has(section)) return true;
    return role === 'admin';
}

/**
 * Will the admin API answer THIS caller at all?
 *
 * Distinct from `canSeeSection`, which asks whether this ROLE may use a section. Both must hold: a
 * signed-in admin reaching a container without the opt-out is an admin whose calls still 403, and a
 * viewer on loopback is local but still not an admin.
 *
 * Every admin handler gates at the top of `handle`, so the GETs are gated too — without this a
 * flagless container 403-spams every poll interval on a completely healthy app. Same argument as
 * finding 9.6 above, extended from `role` to `adminScope`.
 *
 * An absent `adminScope` is a server older than the guard, where the admin API always answered —
 * assume reachable so a new frontend does not blank sections on an old server.
 */
export function adminApiReachable(runtime: Pick<FirstRunStatus, 'adminScope' | 'callerIsLocal'>): boolean {
    if (runtime.adminScope === undefined) return true;
    if (runtime.adminScope === 'local') return runtime.callerIsLocal === true;
    return true;
}

/**
 * Said once on each Settings tab whose admin controls are held back because
 * `adminApiReachable` is false for this page, and in the Dependencies table
 * when the server refuses its read: every one of those controls would only be
 * refused (0.5.5).
 */
export const ADMIN_UNREACHABLE_NOTE = 'admin changes are limited to the machine running the server.';

/**
 * Said in place of a tab's controls when the server refused its read because
 * this user is not an admin (`requireAdmin`'s `forbidden`; 0.5.6). The tab is
 * not normally shown to such a user at all: this is the role check that
 * failed open (`SettingsModal`), met by the server's own.
 */
export const ADMIN_ONLY_NOTE = 'only an admin can change these settings.';

/** Which refusal a 403 was: see `adminRefusal`. */
export type AdminRefusal = 'operator' | 'role';

/**
 * Which refusal a 403's body is (0.5.6), or null when it is not one this page
 * can act on:
 * - `operator`: `requireOperator` refused this page, which is not the
 *   operator, so every admin call from here will be refused the same way;
 * - `role`: `requireAdmin`'s bare `{"error":"forbidden"}`, a user who is not
 *   an admin;
 * - null for anything else, the stale-token refusal above all
 *   (`isStaleTokenRefusal`: `forbidden` WITH a `reason`), which says the
 *   server process changed under this page, not that this page may not ask.
 */
export function refusalFromBody(status: number, body: unknown): AdminRefusal | null {
    if (status !== 403 || typeof body !== 'object' || body === null) return null;
    const { error, reason } = body as { error?: unknown; reason?: unknown };
    if (error === OPERATOR_REFUSAL_ERROR) return 'operator';
    if (error === 'forbidden' && reason === undefined) return 'role';
    return null;
}

/**
 * Why the server refused an admin read, or null when it did not refuse it
 * (`refusalFromBody`; any status but 403 is null). A refusal is not worth a
 * retry; a null is a failure like any other, and keeps its retry. Reads the
 * body, so call it only on a response whose body nothing else will read.
 */
export async function adminRefusal(res: Response): Promise<AdminRefusal | null> {
    if (res.status !== 403) return null;
    return refusalFromBody(res.status, await res.json().catch(() => null));
}
