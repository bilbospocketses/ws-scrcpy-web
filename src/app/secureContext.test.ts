import { describe, expect, it } from 'vitest';
import { insecureOriginNotice, loopbackEquivalent } from './secureContext';

// Finding 8.10 — WebCodecs is exposed only in a secure context, so on
// http://<lan-ip>:8000 (the documented way to use the Docker image)
// WebCodecsPlayer.isSupported() is false, getPlayers() returns empty, and the
// device card renders no connect link at all. Measured 2026-09-03 with this
// repo's chromium 151: http://127.0.0.1:PORT gives isSecureContext true and
// VideoDecoder function; http://192.168.87.3:PORT gives false and undefined.
// Chromium's --unsafely-treat-insecure-origin-as-secure changed nothing.
describe('insecureOriginNotice', () => {
    const secure = { isSecureContext: true, location: { protocol: 'http:', hostname: '127.0.0.1', port: '8000' } };
    const lan = { isSecureContext: false, location: { protocol: 'http:', hostname: '192.168.87.3', port: '8000' } };

    it('returns null in a secure context, so nothing is shown when streaming works', () => {
        expect(insecureOriginNotice(secure)).toBeNull();
        expect(
            insecureOriginNotice({
                isSecureContext: true,
                location: { protocol: 'https:', hostname: 'ws.example.com', port: '' },
            }),
        ).toBeNull();
    });

    it('explains the cause and both remedies on an insecure origin', () => {
        const notice = insecureOriginNotice(lan);
        expect(notice).not.toBeNull();
        // The cause, in the user's terms — not "WebCodecs is undefined".
        expect(notice).toContain('secure');
        // Remedy 1: open it on the serving machine, with the exact URL.
        expect(notice).toContain('http://localhost:8000');
        // Remedy 2: put it behind a trusted origin.
        expect(notice?.toLowerCase()).toContain('https');
    });

    it('is lowercase, matching the app motif', () => {
        const notice = insecureOriginNotice(lan);
        // Device labels and model strings are the documented exceptions; this
        // string contains neither, so it should carry no capitals at all.
        expect(notice).toBe(notice?.toLowerCase());
    });
});

describe('loopbackEquivalent', () => {
    it('keeps the port so the hint is copy-pasteable', () => {
        expect(loopbackEquivalent({ protocol: 'http:', hostname: '192.168.87.3', port: '8000' })).toBe(
            'http://localhost:8000',
        );
    });

    it('omits an empty port rather than emitting a trailing colon', () => {
        expect(loopbackEquivalent({ protocol: 'http:', hostname: '10.0.0.5', port: '' })).toBe('http://localhost');
    });
});
