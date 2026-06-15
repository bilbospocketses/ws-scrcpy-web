import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as path from 'path';

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
const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
} as const;

// A missing path falls back to the SPA shell only for a navigation: an
// HTML-accepting request for an extensionless (route-like) path. Asset requests
// (those with a file extension) and non-HTML requests (e.g. an `/api/*` XHR)
// get a 404 instead of a 200 + index.html, so a missing asset is no longer
// served as the HTML shell. (#24)
export function isSpaNavigation(urlPath: string, accept: string | undefined): boolean {
    return (accept ?? '').includes('text/html') && path.extname(urlPath) === '';
}

export function createStaticHandler(publicDir: string): (req: IncomingMessage, res: ServerResponse) => void {
    return (req, res) => {
        const urlPath = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
        let filePath = path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath);

        // Normalize and prevent directory traversal
        filePath = path.resolve(filePath);
        if (!filePath.startsWith(path.resolve(publicDir))) {
            res.writeHead(403, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
            res.end('Forbidden');
            return;
        }

        fs.stat(filePath, (err, stats) => {
            if (err || !stats.isFile()) {
                if (isSpaNavigation(urlPath, req.headers.accept)) {
                    // Navigation to a client-side route → serve the SPA shell.
                    const indexPath = path.join(publicDir, 'index.html');
                    res.writeHead(200, { 'Content-Type': 'text/html', ...SECURITY_HEADERS });
                    fs.createReadStream(indexPath).pipe(res);
                } else {
                    // Missing asset (or a non-navigation request) → 404, not the shell.
                    res.writeHead(404, { 'Content-Type': 'text/plain', ...SECURITY_HEADERS });
                    res.end('Not Found');
                }
                return;
            }
            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': contentType, ...SECURITY_HEADERS });
            fs.createReadStream(filePath).pipe(res);
        });
    };
}
