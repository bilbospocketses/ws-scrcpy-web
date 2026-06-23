// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import VideoSettings from '../../VideoSettings';
import { BasePlayer } from '../BasePlayer';

/**
 * Finding #44 at the BasePlayer level: stop() must cancelAnimationFrame the
 * stored stats-loop id, and the loop must not double-start (a second pushFrame
 * while a frame is pending creates no second loop). resetStats() must also cancel.
 *
 * We stub raf/caf globally in beforeEach (BEFORE each test constructs a player)
 * so AnimationFrameGuard's constructor default params capture the stubs. That
 * capture happens at CONSTRUCTION time, not module-eval, so BasePlayer is a
 * plain static import — which also keeps its (heavy) transform at file-collection
 * time, out of the per-test timeout, avoiding the full-suite parallel-load flake
 * an in-test `await import()` exposed (item 60a).
 */

let rafSpy: ReturnType<typeof vi.fn>;
let cafSpy: ReturnType<typeof vi.fn>;
let pending: Map<number, FrameRequestCallback>;

describe('BasePlayer quality-stats rAF lifecycle (finding #44)', () => {
    beforeEach(() => {
        let nextId = 1;
        pending = new Map();
        rafSpy = vi.fn((cb: FrameRequestCallback) => {
            const id = nextId++;
            pending.set(id, cb);
            return id;
        });
        cafSpy = vi.fn((id: number) => {
            pending.delete(id);
        });
        vi.stubGlobal('requestAnimationFrame', rafSpy);
        vi.stubGlobal('cancelAnimationFrame', cafSpy);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    async function makePlayer() {
        class TestPlayer extends BasePlayer {
            public getImageDataURL(): string {
                return '';
            }
            public getPreferredVideoSetting() {
                return new VideoSettings({ bitrate: 8_000_000, maxFps: 15, iFrameInterval: 2 });
            }
            protected calculateMomentumStats(): void {
                /* no-op for stats lifecycle test */
            }
            public getFitToScreenStatus(): boolean {
                return false;
            }
            public loadVideoSettings() {
                return new VideoSettings({ bitrate: 8_000_000, maxFps: 15, iFrameInterval: 2 });
            }
        }
        return new TestPlayer('udid');
    }

    it('starts exactly one stats frame on first pushFrame and does not double-start', async () => {
        const player = await makePlayer();
        player.pushFrame(new Uint8Array([0, 0, 0, 1, 0x65]));
        expect(rafSpy).toHaveBeenCalledTimes(1);
        // Second pushFrame while a frame is still pending must NOT schedule again.
        player.pushFrame(new Uint8Array([0, 0, 0, 1, 0x41]));
        expect(rafSpy).toHaveBeenCalledTimes(1);
    });

    it('stop() cancels the pending stats frame with the stored id', async () => {
        const player = await makePlayer();
        player.pushFrame(new Uint8Array([0, 0, 0, 1, 0x65]));
        const id = rafSpy.mock.results[0]!.value as number;
        player.stop();
        expect(cafSpy).toHaveBeenCalledTimes(1);
        expect(cafSpy).toHaveBeenCalledWith(id);
    });

    it('after stop() a fresh pushFrame can start a new loop (re-arm), still only one', async () => {
        const player = await makePlayer();
        player.pushFrame(new Uint8Array([0, 0, 0, 1, 0x65]));
        player.stop();
        // receivedFirstFrame is still true after stop(), so pushFrame won't re-arm;
        // setVideoSettings()/resetStats() clears it. Simulate the reset path:
        player.setVideoSettings(player.getVideoSettings(), false, false);
        player.pushFrame(new Uint8Array([0, 0, 0, 1, 0x65]));
        // raf called: initial + after re-arm = 2; never two concurrent (cancel happened).
        expect(rafSpy).toHaveBeenCalledTimes(2);
    });

    it('setVideoSettings/resetStats cancels a pending frame (no leaked loop)', async () => {
        const player = await makePlayer();
        player.pushFrame(new Uint8Array([0, 0, 0, 1, 0x65]));
        expect(cafSpy).not.toHaveBeenCalled();
        player.setVideoSettings(player.getVideoSettings(), false, false); // calls resetStats()
        expect(cafSpy).toHaveBeenCalledTimes(1);
    });
});
