import type { IncomingMessage, ServerResponse } from 'http';
import { resolveUserId } from '../auth/currentUser';
import { Config } from '../Config';
import { ControlCenter } from '../goog-device/services/ControlCenter';
import { Logger } from '../Logger';
import { serialReadOn } from './pendingLabels';
import { readJsonBody } from './utils';

const log = Logger.for('SettingsApi');

/**
 * How long a device-settings request for a live transport waits for the
 * tracker to read which device answers there (M11 fix 1). The read is one
 * `getprop` and normally lands within a second of the transport appearing.
 */
export const SERIAL_WAIT_MS = 3000;

/** Seconds a client is told to wait before asking again when the read has not landed. */
export const SERIAL_RETRY_AFTER_S = 1;

/**
 * The key a device-settings request is filed under (M11): the serial the
 * tracker read on transport `requested`, or `requested` itself when it is not
 * a transport the tracker holds (the device list asks by serial; an e2e fake
 * device has no transport) or the device there reported no serial that names
 * one device. Null while a live transport's serial is still being read: filed
 * under the transport, a setting written then would never reach the serial,
 * since a set already under the serial is never replaced by a transport's.
 */
async function settingsKeyFor(requested: string, waitMs: number): Promise<string | null> {
    const known = serialReadOn(requested);
    if (known) return known;
    const live = ControlCenter.hasInstance() ? ControlCenter.getInstance().getDevice(requested) : undefined;
    if (!live) return requested;
    if (!(await live.whenSighted(waitMs))) return null;
    return serialReadOn(requested) ?? requested;
}

/**
 * Per-user settings surface (Phase 3). The browser never touches SQLite — it
 * reads/writes here. Everything is keyed by `resolveUserId(req)` (the implicit
 * admin in open mode; the session user once auth lands in Phase 4).
 *   GET/PATCH  /api/settings              → global `user_settings`
 *   GET/PATCH  /api/settings/device?udid= → per-device `device_settings`,
 *                                            keyed by the device's serial (M11)
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
    constructor(private readonly serialWaitMs: number = SERIAL_WAIT_MS) {}

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const url = req.url || '';
        if (!url.startsWith('/api/settings')) return false;

        const pathname = url.split('?')[0];
        // The batch route is SettingsBatchApi's. This handler is registered first
        // and used to claim every /api/settings* URL, answering 404 for this one,
        // so the Settings dialog's Save never reached the batch writer.
        if (pathname === '/api/settings/batch') return false;

        res.setHeader('Content-Type', 'application/json');

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
                const requested = new URL(url, 'http://localhost').searchParams.get('udid');
                if (!requested) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'udid is required' }));
                    return true;
                }
                // Settings are keyed by the device's real serial (M11), so one
                // device keeps one set across USB, Wi-Fi and IP changes. The
                // device list asks by serial; a stream opened from a direct link,
                // or Configure opened before the card has the serial, knows only
                // the adb transport, which resolves to the serial the tracker
                // read on it. While that read is pending the request waits for
                // it, and is answered 503 + Retry-After if it does not land in
                // time, rather than split the device's settings (M11 fix 1).
                if (req.method === 'GET' || req.method === 'PATCH') {
                    // The body is read before any wait, so it is never left
                    // sitting on the socket while the serial is read.
                    const body = req.method === 'PATCH' ? await readJsonBody(req) : undefined;
                    const udid = await settingsKeyFor(requested, this.serialWaitMs);
                    if (udid === null) {
                        res.setHeader('Retry-After', String(SERIAL_RETRY_AFTER_S));
                        res.writeHead(503);
                        res.end(
                            JSON.stringify({
                                error: `the device on ${requested} has not reported its serial yet; retry shortly`,
                            }),
                        );
                        return true;
                    }
                    for (const [scope, value] of Object.entries(body ?? {})) {
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
