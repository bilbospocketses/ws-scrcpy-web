import * as crypto from 'crypto';

/**
 * Resume tokens for the v0.1.8 cross-instance handoff flows.
 *
 * Use case: user clicks "uninstall service" on the service-instance UI
 * (port 8001). Server spawns a fresh user-session local launcher, which
 * binds a new port. Server returns a redirect URL with a token. User's
 * browser navigates to the new local-instance URL with
 * `?resume=uninstall-service&token=<token>`. The local instance reads
 * the URL params, validates the token, and auto-fires the uninstall.
 *
 * Token semantics:
 *   - 32 random hex chars (128 bits of entropy)
 *   - Stored on disk in a file under <install>/.resume-tokens/<token>.json
 *   - Single-use: validated and deleted in the same call
 *   - Time-bounded: 10 minutes from creation; expired tokens are
 *     ignored (and best-effort cleaned on next access)
 *   - Action-bound: token includes the action it authorizes
 *     ("uninstall-service") so a token issued for one purpose can't
 *     be replayed for another
 *
 * Threat model: a stale URL bookmarked by the user, a leaked URL
 * shared by accident, a malicious shortcut on the desktop. Single-use
 * + 10-minute expiry + action binding all defend against accidental
 * replay; nothing here defends against an attacker with filesystem
 * read access (they could read the token file). That's an acceptable
 * threat for a local-tray-app-managed service.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Logger } from '../Logger';

const log = Logger.for('ResumeToken');

const TOKEN_TTL_MS = 10 * 60 * 1000;
const TOKEN_BYTES = 16;

export interface ResumeTokenRecord {
    token: string;
    action: 'uninstall-service';
    createdAt: number;
}

function tokenDir(installRoot: string): string {
    return path.join(installRoot, '.resume-tokens');
}

function tokenPath(installRoot: string, token: string): string {
    // Sanitize the token to alphanumeric only so a malicious URL param
    // can't traverse paths. Tokens we issue are pure hex, so a
    // sanitized token that doesn't equal the original is invalid by
    // construction.
    const sanitized = token.replace(/[^a-zA-Z0-9]/g, '');
    return path.join(tokenDir(installRoot), `${sanitized}.json`);
}

/**
 * Issue a new resume token for the given action. Returns the token
 * string the caller should embed in the redirect URL.
 */
export function issueToken(installRoot: string, action: 'uninstall-service', now: number = Date.now()): string {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
    const record: ResumeTokenRecord = { token, action, createdAt: now };
    const dir = tokenDir(installRoot);
    // #30: restrict the token dir/file to the owner (0700/0600) and write it
    // atomically (tmp + rename) so a crash or a concurrent reader never sees a
    // partial token. POSIX perms; on Windows the per-user install root + ACLs
    // govern and the mode/chmod calls are effectively no-ops.
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
        fs.chmodSync(dir, 0o700);
    } catch {
        /* best-effort: pre-existing dir */
    }
    const finalPath = tokenPath(installRoot, token);
    const tmpPath = `${finalPath}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    fs.writeFileSync(tmpPath, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, finalPath);
    log.info(`issued resume token for ${action}`);
    return token;
}

/**
 * Validate a resume token. If valid, returns the record AND consumes
 * the token (deletes the file). If invalid (missing, expired, action
 * mismatch, malformed), returns `null`.
 *
 * Single-use: a successful validation deletes the token file so it
 * can't be reused even within the TTL window.
 */
export function consumeToken(
    installRoot: string,
    token: string,
    expectedAction: 'uninstall-service',
    now: number = Date.now(),
): ResumeTokenRecord | null {
    if (!token || token.length !== TOKEN_BYTES * 2) return null;
    if (token !== token.replace(/[^a-zA-Z0-9]/g, '')) return null;

    const filepath = tokenPath(installRoot, token);
    if (!fs.existsSync(filepath)) return null;

    let raw: string;
    try {
        raw = fs.readFileSync(filepath, 'utf8');
    } catch {
        return null;
    }

    let record: ResumeTokenRecord;
    try {
        record = JSON.parse(raw) as ResumeTokenRecord;
    } catch {
        // Malformed file. Best-effort delete so it doesn't pile up.
        try {
            fs.unlinkSync(filepath);
        } catch {
            /* ignore */
        }
        return null;
    }

    // Validate.
    if (record.token !== token) return null;
    if (record.action !== expectedAction) return null;
    if (typeof record.createdAt !== 'number') return null;
    if (now - record.createdAt > TOKEN_TTL_MS) {
        // Expired. Delete and reject.
        try {
            fs.unlinkSync(filepath);
        } catch {
            /* ignore */
        }
        log.info(`resume token rejected: expired (${(now - record.createdAt) / 1000}s old)`);
        return null;
    }

    // Valid. Consume.
    try {
        fs.unlinkSync(filepath);
    } catch {
        /* ignore */
    }
    log.info(`resume token consumed: ${record.action}`);
    return record;
}

/** Best-effort cleanup of expired tokens. Called from server boot. */
export function purgeExpiredTokens(installRoot: string, now: number = Date.now()): void {
    const dir = tokenDir(installRoot);
    if (!fs.existsSync(dir)) return;
    try {
        for (const entry of fs.readdirSync(dir)) {
            const filepath = path.join(dir, entry);
            try {
                const raw = fs.readFileSync(filepath, 'utf8');
                const record = JSON.parse(raw) as ResumeTokenRecord;
                if (now - record.createdAt > TOKEN_TTL_MS) {
                    fs.unlinkSync(filepath);
                }
            } catch {
                // Malformed or unreadable — best-effort delete.
                try {
                    fs.unlinkSync(filepath);
                } catch {
                    /* ignore */
                }
            }
        }
    } catch (err) {
        log.warn(`token purge failed: ${(err as Error).message}`);
    }
}
