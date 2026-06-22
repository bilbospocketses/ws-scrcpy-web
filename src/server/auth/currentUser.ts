import type { IncomingMessage } from 'http';
import { IMPLICIT_ADMIN_ID } from '../db/constants';

/**
 * The acting user's id for a request. AuthGate attaches `req.user` for an authenticated session;
 * in open mode (no auth) nothing is attached, so this falls back to the implicit admin.
 */
export function resolveUserId(req?: IncomingMessage): number {
    const user = (req as (IncomingMessage & { user?: { id?: number } }) | undefined)?.user;
    return user?.id ?? IMPLICIT_ADMIN_ID;
}
