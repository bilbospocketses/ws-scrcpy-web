import type { IncomingMessage } from 'http';
import { IMPLICIT_ADMIN_ID } from '../db/constants';

/**
 * The acting user's id for a request. In open mode (no auth) this is always the
 * implicit admin. Phase 4 extends this to return the authenticated session
 * user's id (falling back to IMPLICIT_ADMIN_ID only when auth is disabled).
 */
export function resolveUserId(_req?: IncomingMessage): number {
    return IMPLICIT_ADMIN_ID;
}
