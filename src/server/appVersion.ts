import * as fs from 'fs';
import * as path from 'path';

/**
 * v0.1.17: shared accessor for the running app's version string.
 *
 * Reads package.json relative to the webpack bundle. In production:
 *   <installRoot>/current/dist/index.js  (this file's __dirname)
 *   <installRoot>/current/package.json   (stage-publish.mjs copies it here)
 * In dev (npm start):
 *   <repo>/dist/index.js
 *   <repo>/package.json
 *
 * `process.env.npm_package_version` only works when launched via `npm`,
 * which is fine for `npm start` but NOT how the packaged launcher runs.
 * Reading the file directly works in both modes.
 *
 * Cached on first read; package.json doesn't change at runtime.
 */
let cached: string | undefined;

export function getAppVersion(): string {
    if (cached !== undefined) return cached;
    try {
        const pkgPath = path.resolve(__dirname, '..', 'package.json');
        const raw = fs.readFileSync(pkgPath, 'utf8');
        const parsed = JSON.parse(raw) as { version?: unknown };
        if (typeof parsed.version === 'string' && parsed.version.length > 0) {
            cached = parsed.version;
            return cached;
        }
    } catch {
        // Fall through to env / fallback.
    }
    cached = process.env['npm_package_version'] ?? '0.0.0';
    return cached;
}
