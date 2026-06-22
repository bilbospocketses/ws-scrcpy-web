import type { Role } from './AuthClient';

// Settings areas that only an admin may see/use. Everything NOT listed here is
// user-level and always visible. The SERVER enforces the same set via requireAdmin
// (403) — this is the cosmetic UI half.
export const ADMIN_ONLY_SECTIONS = new Set<string>(['updates', 'service', 'users', 'webPort', 'serverControls']);

/** True if `role` may see `section`. User-level sections are always visible; admin-only ones require role==='admin'. */
export function canSeeSection(role: Role | null | undefined, section: string): boolean {
    if (!ADMIN_ONLY_SECTIONS.has(section)) return true;
    return role === 'admin';
}
