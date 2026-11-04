import { afterEach, describe, expect, it, vi } from 'vitest';
import { localDownloadProgress, serverIsLocal, whileDownloading } from '../e2e/support/downloadWait';

// The e2e suite's no-progress download waits (tests/e2e/support/downloadWait.ts).
// Pure enough to run here: nothing below calls into a Playwright test.

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('whileDownloading', () => {
    it('returns the reply as soon as it arrives', async () => {
        const reply = Promise.resolve('the answer');
        await expect(whileDownloading(reply, { what: 'a reply', progress: () => 'still' })).resolves.toBe('the answer');
    });

    it('passes a failed reply through as itself, not as HUNG', async () => {
        const reply = Promise.reject(new Error('HTTP 500 from the route'));
        await expect(whileDownloading(reply, { what: 'a reply', progress: () => 'still' })).rejects.toThrow(
            'HTTP 500 from the route',
        );
    });

    it('waits on while the bytes on disk keep moving, however long the reply takes', async () => {
        let bytes = 0;
        const reply = new Promise<string>((resolve) => setTimeout(() => resolve('late but fine'), 2_500));
        // A 1 ms stall window: only the moving bytes keep this wait alive.
        await expect(
            whileDownloading(reply, { what: 'a slow reply', progress: () => `${(bytes += 1)} bytes`, stallMs: 1 }),
        ).resolves.toBe('late but fine');
    });

    it('fails as HUNG, naming what it waited for, when neither the bytes nor the status move', async () => {
        const never = new Promise<string>(() => {});
        await expect(
            whileDownloading(never, {
                what: 'the stuck reply',
                progress: () => '7 files, 100 bytes',
                status: async () => 'adb=updating',
                stallMs: 1,
            }),
        ).rejects.toThrow(/^HUNG: the stuck reply: neither the dependency list nor the bytes on disk changed/);
    });

    it('says plainly when only the status was watched', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const never = new Promise<string>(() => {});
            const waiting = whileDownloading(never, { what: 'a remote reply', progress: () => null });
            waiting.catch(() => {});
            // Once the first poll has recorded the status, jump past the
            // status-only window: the next poll sees it, without spending it.
            await new Promise((r) => setTimeout(r, 1_200));
            vi.setSystemTime(Date.now() + 11 * 60_000);
            await expect(waiting).rejects.toThrow(/Only the status was watched/);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('serverIsLocal / localDownloadProgress', () => {
    it('a loopback server this run spawned is local, and its scratch dirs are read', () => {
        expect(serverIsLocal('http://127.0.0.1:8145')).toBe(true);
        expect(serverIsLocal('http://localhost:8123')).toBe(true);
        expect(localDownloadProgress('http://127.0.0.1:8145')()).toMatch(
            /^\d+ files, \d+ bytes in update scratch dirs$/,
        );
    });

    it('a remote server is not, so the wait watches the status only', () => {
        expect(serverIsLocal('http://192.0.2.10:8000')).toBe(false);
        expect(localDownloadProgress('http://192.0.2.10:8000')()).toBeNull();
    });

    it('nothing is local under an external stack, loopback included', () => {
        vi.stubEnv('QA_EXTERNAL_STACK', '1');
        expect(serverIsLocal('http://127.0.0.1:8123')).toBe(false);
        expect(localDownloadProgress()()).toBeNull();
    });
});
