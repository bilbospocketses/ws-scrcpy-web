import type { IncomingMessage, ServerResponse } from 'http';
import { resolveUserId } from '../auth/currentUser';
import { Config } from '../Config';
import { Logger } from '../Logger';
import { readJsonBody } from './utils';

const log = Logger.for('SettingsApi');

/**
 * Per-user settings surface (Phase 3). The browser never touches SQLite — it
 * reads/writes here. Everything is keyed by `resolveUserId(req)` (the implicit
 * admin in open mode; the session user once auth lands in Phase 4).
 *   GET/PATCH  /api/settings              → global `user_settings`
 *   GET/PATCH  /api/settings/device?udid= → per-device `device_settings`
 *   POST       /api/settings/reset        → clear the caller's settings + labels
 *
 * Storage is intentionally schema-less: PATCH bodies are persisted as opaque
 * per-user JSON keyed by setting name (global) or scope (device), so adding a
 * new client setting — theme, iconSize, scanSubnets, dismissed-prompt flags,
 * video/audio — needs no server change. We deliberately do NOT validate
 * individual keys/values here:
 *   - the body is already size-capped (1 MiB) and guaranteed a plain object by
 *     `readJsonBody` (arrays/primitives/parse-failures collapse to `{}`), and
 *     values are bound through prepared statements (no injection);
 *   - every row is scoped to the calling user, who is also the sole consumer,
 *     and the frontend coerces on read (e.g. a non-number iconSize → null);
 *   - a per-key allowlist would break the schema-less contract above and add
 *     ongoing fragility for nil security/correctness benefit (item 60c — judged
 *     by-design on review).
 * If a single setting ever needs a server-enforced invariant, validate that one
 * key explicitly rather than reintroducing a global schema.
 */
export class SettingsApi {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/settings')) return false;

        res.setHeader('Content-Type', 'application/json');
        const pathname = url.split('?')[0];

        try {
            const db = Config.getInstance().db;
            const userId = resolveUserId(req);

            if (pathname === '/api/settings') {
                if (req.method === 'GET') {
                    res.writeHead(200);
                    res.end(JSON.stringify(db.userSettings.getAll(userId)));
                    return true;
                }
                if (req.method === 'PATCH') {
                    const body = await readJsonBody(req);
                    for (const [key, value] of Object.entries(body)) db.userSettings.set(userId, key, value);
                    res.writeHead(200);
                    res.end(JSON.stringify(db.userSettings.getAll(userId)));
                    return true;
                }
            }

            if (pathname === '/api/settings/device') {
                const udid = new URL(url, 'http://localhost').searchParams.get('udid');
                if (!udid) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid is required' }));
                    return true;
                }
                if (req.method === 'GET') {
                    res.writeHead(200);
                    res.end(JSON.stringify(db.devices.getDeviceSettings(userId, udid)));
                    return true;
                }
                if (req.method === 'PATCH') {
                    const body = await readJsonBody(req);
                    for (const [scope, value] of Object.entries(body)) {
                        db.devices.setDeviceSetting(userId, udid, scope, value);
                    }
                    res.writeHead(200);
                    res.end(JSON.stringify(db.devices.getDeviceSettings(userId, udid)));
                    return true;
                }
            }

            if (req.method === 'POST' && pathname === '/api/settings/reset') {
                db.userSettings.clearForUser(userId);
                db.devices.clearForUser(userId);
                res.writeHead(200);
                res.end(JSON.stringify({ success: true }));
                return true;
            }

            res.writeHead(404);
            res.end(JSON.stringify({ error: 'Not found' }));
            return true;
        } catch (err) {
            log.error(`${req.method} ${req.url} threw: ${(err as Error)?.message ?? String(err)}`);
            res.writeHead(500);
            res.end(JSON.stringify({ error: (err as Error).message }));
            return true;
        }
    }
}
