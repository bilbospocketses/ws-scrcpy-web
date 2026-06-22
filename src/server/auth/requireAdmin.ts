import type { IncomingMessage, ServerResponse } from 'http';
import { Config } from '../Config';
import { resolveUserId } from './currentUser';

/** True if the acting user is an admin; otherwise writes 403 and returns false.
 *  In open mode resolveUserId is the implicit admin (role 'admin'), so this passes. */
export function requireAdmin(req: IncomingMessage, res: ServerResponse): boolean {
    const db = Config.getInstance().db;
    const user = db.users.getById(resolveUserId(req));
    if (user?.role === 'admin') return true;
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return false;
}
