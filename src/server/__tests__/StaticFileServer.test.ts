import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStaticHandler, getFileEtag, isNoneMatch, isSpaNavigation } from '../StaticFileServer';

// #24 — a missing path falls back to the SPA shell ONLY for a navigation: an
// HTML-accepting request for an extensionless (route-like) path. Asset requests
// and non-HTML requests (e.g. /api/* XHRs) get a 404 instead of a 200 + index.
describe('isSpaNavigation', () => {
    it('treats an HTML-accepting request for an extensionless route as a navigation', () => {
        expect(isSpaNavigation('/devices', 'text/html,application/xhtml+xml,*/*')).toBe(true);
        expect(isSpaNavigation('/', 'text/html')).toBe(true);
    });

    it('treats a request with a file extension as a non-navigation (asset)', () => {
        expect(isSpaNavigation('/app.js', 'text/html')).toBe(false);
        expect(isSpaNavigation('/img/logo.png', 'text/html')).toBe(false);
    });

    it('treats a non-HTML request as a non-navigation (e.g. an /api XHR)', () => {
        expect(isSpaNavigation('/api/devices', '*/*')).toBe(false);
        expect(isSpaNavigation('/api/devices', undefined)).toBe(false);
    });

    // The API's error contract must not depend on who is asking. An unknown
    // /api/* path is extensionless, so the Accept header alone used to decide
    // between a 404 (XHR) and a 200 + application shell (address bar).
    it('never treats an /api/* path as a navigation, whatever the Accept header', () => {
        expect(isSpaNavigation('/api/no-such-route', 'text/html,application/xhtml+xml,*/*')).toBe(false);
        expect(isSpaNavigation('/api/devices/list', 'text/html')).toBe(false);
        expect(isSpaNavigation('/api', 'text/html')).toBe(false);
    });
});

describe('StaticFileServer ETag and Caching', () => {
    let tmpDir: string;
    let bundlePath: string;
    let indexPath: string;

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-scrcpy-static-test-'));
        bundlePath = path.join(tmpDir, 'bundle.js');
        indexPath = path.join(tmpDir, 'index.html');
        fs.writeFileSync(bundlePath, 'console.log("hello v1");');
        fs.writeFileSync(indexPath, '<html><body>SPA shell</body></html>');
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function mockReqRes(
        url: string,
        headers: Record<string, string> = {},
    ): {
        req: IncomingMessage;
        res: ServerResponse;
        getStatus: () => number;
        getHeaders: () => Record<string, string>;
        isEnded: () => boolean;
        waitForResponse: () => Promise<void>;
    } {
        let status = 0;
        let ended = false;
        const respHeaders: Record<string, string> = {};

        const req = {
            url,
            method: 'GET',
            headers: { host: 'localhost:8000', ...headers },
        } as unknown as IncomingMessage;

        const res = {
            writeHead(s: number, h?: Record<string, string>) {
                status = s;
                if (h) {
                    for (const [k, v] of Object.entries(h)) {
                        respHeaders[k.toLowerCase()] = v;
                    }
                }
                return res;
            },
            end() {
                ended = true;
            },
            on(_event: string, _cb: unknown) {
                return res;
            },
            once(_event: string, _cb: unknown) {
                return res;
            },
            emit(_event: string, ..._args: unknown[]) {
                return true;
            },
            write(_chunk: unknown) {
                return true;
            },
        } as unknown as ServerResponse;

        return {
            req,
            res,
            getStatus: () => status,
            getHeaders: () => respHeaders,
            isEnded: () => ended,
            waitForResponse: () =>
                new Promise((resolve) => {
                    const check = () => {
                        if (status !== 0) resolve();
                        else setTimeout(check, 10);
                    };
                    check();
                }),
        };
    }

    describe('isNoneMatch', () => {
        it('matches exact etags', () => {
            expect(isNoneMatch('"abc123"', '"abc123"')).toBe(true);
            expect(isNoneMatch('"abc123"', '"xyz999"')).toBe(false);
        });

        it('matches weak and strong etags interchangeably', () => {
            expect(isNoneMatch('W/"abc123"', '"abc123"')).toBe(true);
            expect(isNoneMatch('"abc123"', 'W/"abc123"')).toBe(true);
            expect(isNoneMatch('W/"abc123"', 'W/"abc123"')).toBe(true);
        });

        it('handles wildcard *', () => {
            expect(isNoneMatch('*', '"abc123"')).toBe(true);
        });

        it('handles comma-separated client lists', () => {
            expect(isNoneMatch('"foo", "abc123", "bar"', '"abc123"')).toBe(true);
            expect(isNoneMatch('"foo", "bar"', '"abc123"')).toBe(false);
        });

        it('returns false when header is undefined', () => {
            expect(isNoneMatch(undefined, '"abc123"')).toBe(false);
        });
    });

    describe('getFileEtag', () => {
        it('generates consistent ETag for identical stats', () => {
            const stats = fs.statSync(bundlePath);
            const etag1 = getFileEtag(bundlePath, stats);
            const etag2 = getFileEtag(stats);
            expect(etag1).toBe(etag2);
            expect(etag1.startsWith('"')).toBe(true);
            expect(etag1.endsWith('"')).toBe(true);
        });

        it('formats ETag matching Caddy calculateEtag base-36 representation', () => {
            const mockStats = {
                mtimeMs: 1728612345678,
                size: 123456,
            } as fs.Stats;
            const etag = getFileEtag(mockStats);
            const expectedNano = BigInt(Math.round(1728612345678 * 1_000_000)).toString(36);
            const expectedSize = BigInt(123456).toString(36);
            expect(etag).toBe(`"${expectedNano}-${expectedSize}"`);
        });

        it('returns empty string for unusable modification times (<= 1s, matching usefulModTime)', () => {
            const epochStats = { mtimeMs: 0, size: 100 } as fs.Stats;
            const nixStats = { mtimeMs: 1000, size: 100 } as fs.Stats;
            expect(getFileEtag(epochStats)).toBe('');
            expect(getFileEtag(nixStats)).toBe('');
        });

        it('generates different ETag when content / mtime changes', () => {
            const stats1 = fs.statSync(bundlePath);
            const etag1 = getFileEtag(bundlePath, stats1);

            // Modify file content and ensure mtime updates
            const future = new Date(Date.now() + 2000);
            fs.writeFileSync(bundlePath, 'console.log("hello v2 updated");');
            fs.utimesSync(bundlePath, future, future);

            const stats2 = fs.statSync(bundlePath);
            const etag2 = getFileEtag(bundlePath, stats2);

            expect(etag1).not.toBe(etag2);
        });
    });

    describe('createStaticHandler', () => {
        it('returns 200 with ETag and Cache-Control: no-cache on initial asset request', async () => {
            const handler = createStaticHandler(tmpDir);
            const { req, res, getStatus, getHeaders, waitForResponse } = mockReqRes('/bundle.js');

            handler(req, res);
            await waitForResponse();

            expect(getStatus()).toBe(200);
            const headers = getHeaders();
            expect(headers['content-type']).toBe('application/javascript');
            expect(headers['cache-control']).toBe('no-cache');
            expect(headers['etag']).toBeDefined();
            expect(headers['x-content-type-options']).toBe('nosniff');
        });

        it('returns 304 Not Modified when If-None-Match matches', async () => {
            const handler = createStaticHandler(tmpDir);
            const stats = fs.statSync(bundlePath);
            const currentEtag = getFileEtag(bundlePath, stats);

            const { req, res, getStatus, getHeaders, waitForResponse, isEnded } = mockReqRes('/bundle.js', {
                'if-none-match': currentEtag,
            });

            handler(req, res);
            await waitForResponse();

            expect(getStatus()).toBe(304);
            const headers = getHeaders();
            expect(headers['etag']).toBe(currentEtag);
            expect(headers['cache-control']).toBe('no-cache');
            expect(isEnded()).toBe(true);
        });

        it('returns 200 when If-None-Match does not match', async () => {
            const handler = createStaticHandler(tmpDir);
            const { req, res, getStatus, getHeaders, waitForResponse } = mockReqRes('/bundle.js', {
                'if-none-match': '"stale-etag-value"',
            });

            handler(req, res);
            await waitForResponse();

            expect(getStatus()).toBe(200);
            const headers = getHeaders();
            expect(headers['cache-control']).toBe('no-cache');
            expect(headers['etag']).not.toBe('"stale-etag-value"');
        });

        it('serves SPA navigation with ETag and supports 304 for index.html fallback', async () => {
            const handler = createStaticHandler(tmpDir);
            const { req, res, getStatus, getHeaders, waitForResponse } = mockReqRes('/some/client/route', {
                accept: 'text/html,application/xhtml+xml',
            });

            handler(req, res);
            await waitForResponse();

            expect(getStatus()).toBe(200);
            const headers = getHeaders();
            expect(headers['content-type']).toBe('text/html');
            expect(headers['cache-control']).toBe('no-cache');
            const indexEtag = headers['etag'];
            expect(indexEtag).toBeDefined();

            // Re-request with If-None-Match
            const recheck = mockReqRes('/some/client/route', {
                accept: 'text/html',
                'if-none-match': indexEtag ?? '',
            });
            handler(recheck.req, recheck.res);
            await recheck.waitForResponse();

            expect(recheck.getStatus()).toBe(304);
            expect(recheck.getHeaders()['etag']).toBe(indexEtag);
        });
    });
});
