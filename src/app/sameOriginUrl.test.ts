// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { sameOriginBase, sameOriginUrl } from './sameOriginUrl';

// qa-harness Arc 1b (2026-09-06): every post-install / post-uninstall /
// port-change hand-off navigated to `http://localhost:<port>/`, so a browser
// that was not on the serving machine was sent to its own localhost. The port
// is the only thing a hand-off changes; the host must be whatever the browser
// is already using.
describe('sameOriginUrl', () => {
    it('keeps a LAN host and changes only the port', () => {
        expect(sameOriginUrl(8001, 'http://192.168.87.3:8000/')).toBe('http://192.168.87.3:8001/');
    });

    it('never rewrites a non-loopback host to localhost (the reported bug)', () => {
        for (const base of ['http://192.168.87.3:8000/', 'http://wssw.lan:8000/', 'https://ws.example.com/']) {
            expect(sameOriginUrl(8001, base)).not.toContain('localhost');
        }
    });

    it('lands on the root: path, query and hash are cleared', () => {
        expect(sameOriginUrl(8001, 'http://wssw.lan:8000/settings?tab=server#service')).toBe('http://wssw.lan:8001/');
    });

    it('keeps the scheme, so an https deployment stays https', () => {
        expect(sameOriginUrl(8001, 'https://ws.example.com:8000/')).toBe('https://ws.example.com:8001/');
    });

    it('drops a port that is the default for the scheme rather than printing it', () => {
        expect(sameOriginUrl(443, 'https://ws.example.com:8000/')).toBe('https://ws.example.com/');
        expect(sameOriginUrl(80, 'http://wssw.lan:8000/')).toBe('http://wssw.lan/');
    });

    it('keeps IPv6 brackets', () => {
        expect(sameOriginUrl(8001, 'http://[::1]:8000/')).toBe('http://[::1]:8001/');
        expect(sameOriginUrl(8001, 'http://[fd00::a1]:8000/devices')).toBe('http://[fd00::a1]:8001/');
    });

    it('is a no-op change of host for the serving machine itself', () => {
        expect(sameOriginUrl(8001, 'http://localhost:8000/')).toBe('http://localhost:8001/');
        expect(sameOriginUrl(8001, 'http://127.0.0.1:8000/')).toBe('http://127.0.0.1:8001/');
    });

    it('defaults its base to the current window location', () => {
        // jsdom's default location; only the port and the root path are ours.
        const here = new URL(window.location.href);
        const out = new URL(sameOriginUrl(9999));
        expect(out.protocol).toBe(here.protocol);
        expect(out.hostname).toBe(here.hostname);
        expect(out.port).toBe('9999');
        expect(out.pathname).toBe('/');
    });
});

describe('sameOriginBase', () => {
    it('is the origin only, for "this app lives at …" text — no trailing slash', () => {
        expect(sameOriginBase(8000, 'http://192.168.87.3:8000/devices')).toBe('http://192.168.87.3:8000');
        expect(sameOriginBase(8001, 'http://localhost:8000/')).toBe('http://localhost:8001');
    });

    it('drops a default port there too', () => {
        expect(sameOriginBase(443, 'https://ws.example.com:8000/')).toBe('https://ws.example.com');
    });
});
