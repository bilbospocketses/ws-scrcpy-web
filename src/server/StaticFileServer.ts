import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';
import { securityHeaders } from './security/frameGuard';

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.jar': 'application/java-archive',
    '.map': 'application/json',
};

// Security headers applied to every static response. `nosniff` stops the
// browser MIME-sniffing a response (so a 404 or a wrong-typed asset can't be
// reinterpreted as script); `SAMEORIGIN` blocks cross-origin framing
// (clickjacking) while still allowing the same-origin iframe embedding the app
// documents. (#24)
//
// Resolved per response rather than frozen in a const: an operator can allow
// specific embedding origins via config.json `frameAncestors`, which adds a CSP
// `frame-ancestors` header. See security/frameGuard.ts.

// A missing path falls back to the SPA shell only for a navigation: an
// HTML-accepting request for an extensionless (route-like) path. Asset requests
// (those with a file extension) and non-HTML requests (e.g. an `/api/*` XHR)
// get a 404 instead of a 200 + index.html, so a missing asset is no longer
// served as the HTML shell. (#24)
//
// The `/api/` prefix is excluded outright: an unknown API path is extensionless
// too, so without this the Accept header decided the error contract — an XHR to
// /api/no-such-route got its 404 while the same URL in the address bar got 200
// and the application shell, making a mistyped route look like a working page.
export function isSpaNavigation(urlPath: string, accept: string | undefined): boolean {
    if (urlPath === '/api' || urlPath.startsWith('/api/')) return false;
    return (accept ?? '').includes('text/html') && path.extname(urlPath) === '';
}

/**
 * Generates an HTTP ETag based on the file modification timestamp (nanoseconds) and size.
 * This implements the exact algorithm used by Caddy's static file server (`calculateEtag`):
 * https://github.com/caddyserver/caddy/blob/d65583e6d2d02af71490b727ef88785458661a03/modules/caddyhttp/fileserver/staticfiles.go#L822-L834
 * (Commit d6f7f18b041de650b9a35ffc5d791fdcc7cb5049 introduced the '-' separator to prevent collisions:
 *  https://github.com/caddyserver/caddy/blob/d6f7f18b041de650b9a35ffc5d791fdcc7cb5049/modules/caddyhttp/fileserver/staticfiles.go#L763-L775)
 *
 * It formats base-36 nanosecond mtime and base-36 size: `"<mtimeNano>-<size>"`.
 * Returns an empty string if mtime is invalid/placeholder (<= 1s, e.g. Nix builds),
 * matching Caddy's `usefulModTime()` check.
 */
export function getFileEtag(stats: fs.Stats): string;
export function getFileEtag(filePath: string, stats: fs.Stats): string;
export function getFileEtag(first: string | fs.Stats, second?: fs.Stats): string {
    const stats = (typeof first === 'string' ? second : first) as fs.Stats;
    const mtimeUnixSec = Math.floor(stats.mtimeMs / 1000);
    if (mtimeUnixSec <= 1) {
        return '';
    }
    const mtimeNano = BigInt(Math.round(stats.mtimeMs * 1_000_000));
    const size = BigInt(stats.size);
    return `"${mtimeNano.toString(36)}-${size.toString(36)}"`;
}

/**
 * Checks whether an incoming If-None-Match header matches the resource's ETag.
 * Supports weak/strong comparison (stripping W/ prefix) and comma-separated lists.
 */
export function isNoneMatch(ifNoneMatchHeader: string | undefined, etag: string): boolean {
    if (!ifNoneMatchHeader) return false;
    if (ifNoneMatchHeader.trim() === '*') return true;
    const cleanEtag = etag.startsWith('W/') ? etag.slice(2) : etag;
    const clientTags = ifNoneMatchHeader.split(',').map((t) => t.trim());
    return clientTags.some((clientTag) => {
        const cleanClient = clientTag.startsWith('W/') ? clientTag.slice(2) : clientTag;
        return cleanClient === cleanEtag;
    });
}

export function createStaticHandler(publicDir: string): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
        const urlPath = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
        let filePath = path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath);

        // Normalize and prevent directory traversal
        filePath = path.resolve(filePath);
        if (!filePath.startsWith(path.resolve(publicDir))) {
            res.writeHead(403, { 'Content-Type': 'text/plain', ...securityHeaders() });
            res.end('Forbidden');
            return;
        }

        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                if (isSpaNavigation(urlPath, req.headers.accept)) {
                    // Navigation to a client-side route → serve the SPA shell.
                    const indexPath = path.join(publicDir, 'index.html');
                    fs.stat(indexPath, (indexErr, indexStats) => {
                        if (indexErr || !indexStats.isFile()) {
                            res.writeHead(404, { 'Content-Type': 'text/plain', ...securityHeaders() });
                            res.end('Not Found');
                            return;
                        }
                        const etag = getFileEtag(indexPath, indexStats);
                        if (etag && isNoneMatch(req.headers['if-none-match'], etag)) {
                            res.writeHead(304, {
                                ETag: etag,
                                'Cache-Control': 'no-cache',
                                ...securityHeaders(),
                            });
                            res.end();
                            return;
                        }
                        const spaHeaders: Record<string, string> = {
                            'Content-Type': 'text/html',
                            'Cache-Control': 'no-cache',
                            ...securityHeaders(),
                        };
                        if (etag) {
                            spaHeaders['ETag'] = etag;
                        }
                        res.writeHead(200, spaHeaders);
                        fs.createReadStream(indexPath).pipe(res);
                    });
                } else {
                    // Missing asset (or a non-navigation request) → 404, not the shell.
                    res.writeHead(404, { 'Content-Type': 'text/plain', ...securityHeaders() });
                    res.end('Not Found');
                }
                return;
            }

            const etag = getFileEtag(filePath, stats);
            if (etag && isNoneMatch(req.headers['if-none-match'], etag)) {
                res.writeHead(304, {
                    ETag: etag,
                    'Cache-Control': 'no-cache',
                    ...securityHeaders(),
                });
                res.end();
                return;
            }

            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            const headers: Record<string, string> = {
                'Content-Type': contentType,
                'Cache-Control': 'no-cache',
                ...securityHeaders(),
            };
            if (etag) {
                headers['ETag'] = etag;
            }
            res.writeHead(200, headers);
            fs.createReadStream(filePath).pipe(res);
        });
    };
}
