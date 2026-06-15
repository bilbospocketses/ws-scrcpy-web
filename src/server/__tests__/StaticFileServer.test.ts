import { describe, it, expect } from 'vitest';
import { isSpaNavigation } from '../StaticFileServer';

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
});
