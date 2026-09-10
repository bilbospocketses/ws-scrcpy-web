import type { FirstRunStatus } from '../../common/ConfigEvents';
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
