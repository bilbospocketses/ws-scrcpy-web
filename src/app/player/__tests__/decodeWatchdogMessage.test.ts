import { describe, expect, it } from 'vitest';
import { decodeWatchdogMessage, detectBrowserFamily } from '../decodeWatchdogMessage';

/**
 * The decode watchdog's message prescribes a browser, so it has to know which
 * one it is talking to. Issue #498 collected a Chrome console showing the
 * watchdog advising the reporter to "try a Chromium-based browser", plus a
 * Firefox-specific H.264/H.265 note appended to a VP9 failure where neither
 * codec was involved.
 */

const BASE = { codec: 'h264', timeoutMs: 5000 };

describe('decodeWatchdogMessage', () => {
    it('always names the codec and the elapsed time', () => {
        const msg = decodeWatchdogMessage({ ...BASE, codec: 'vp9', isChromium: false, isFirefox: false });
        expect(msg).toContain('vp9:');
        expect(msg).toContain('5000ms');
    });

    it('does not tell a Chromium user to switch to a Chromium browser', () => {
        const msg = decodeWatchdogMessage({ ...BASE, isChromium: true, isFirefox: false });
        expect(msg).not.toContain('Chromium-based browser');
        expect(msg).toContain('try a different video codec');
    });

    it('offers Chromium as an option to browsers that are not Chromium', () => {
        const msg = decodeWatchdogMessage({ ...BASE, isChromium: false, isFirefox: true });
        expect(msg).toContain('Chromium-based browser');
    });

    it('explains the OS decoder handoff only for Firefox on h264', () => {
        const firefoxH264 = decodeWatchdogMessage({ ...BASE, codec: 'h264', isChromium: false, isFirefox: true });
        expect(firefoxH264).toContain('operating system');

        const firefoxVp9 = decodeWatchdogMessage({ ...BASE, codec: 'vp9', isChromium: false, isFirefox: true });
        expect(firefoxVp9).not.toContain('operating system');
    });

    it('states the flat H.265 refusal only for Firefox on h265', () => {
        const firefoxH265 = decodeWatchdogMessage({ ...BASE, codec: 'h265', isChromium: false, isFirefox: true });
        expect(firefoxH265).toContain('cannot decode H.265');

        const chromeH265 = decodeWatchdogMessage({ ...BASE, codec: 'h265', isChromium: true, isFirefox: false });
        expect(chromeH265).not.toContain('cannot decode H.265');
    });

    it('points Chromium users at chrome://gpu, and nobody else', () => {
        const chrome = decodeWatchdogMessage({ ...BASE, codec: 'vp8', isChromium: true, isFirefox: false });
        expect(chrome).toContain('chrome://gpu');

        const firefox = decodeWatchdogMessage({ ...BASE, codec: 'vp8', isChromium: false, isFirefox: true });
        expect(firefox).not.toContain('chrome://gpu');
    });

    it('never mentions a codec other than the one that failed', () => {
        const msg = decodeWatchdogMessage({ ...BASE, codec: 'vp9', isChromium: false, isFirefox: true });
        expect(msg).not.toContain('H.264');
        expect(msg).not.toContain('H.265');
    });
});

describe('detectBrowserFamily', () => {
    const FIREFOX_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:154.0) Gecko/20100101 Firefox/154.0';
    const CHROME_WIN =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
    const EDGE_WIN =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0';
    const SAFARI_MAC =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

    it('identifies Firefox and does not call it Chromium', () => {
        expect(detectBrowserFamily(FIREFOX_WIN)).toEqual({ isChromium: false, isFirefox: true });
    });

    it('identifies Chrome and Edge as Chromium', () => {
        expect(detectBrowserFamily(CHROME_WIN)).toEqual({ isChromium: true, isFirefox: false });
        expect(detectBrowserFamily(EDGE_WIN)).toEqual({ isChromium: true, isFirefox: false });
    });

    it('does not mistake Safari for Chromium on the shared AppleWebKit token', () => {
        expect(detectBrowserFamily(SAFARI_MAC)).toEqual({ isChromium: false, isFirefox: false });
    });

    it('trusts userAgentData brands when the UA string is uninformative', () => {
        const result = detectBrowserFamily('Mozilla/5.0', { brands: [{ brand: 'Chromium', version: '152' }] });
        expect(result.isChromium).toBe(true);
    });
});
