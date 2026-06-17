import { describe, expect, it, vi } from 'vitest';
import { AnimationFrameGuard } from '../animationFrameGuard';

/**
 * Finding #44: the quality-stats requestAnimationFrame loop must not double-start
 * (a second start while one is pending) and must be cancelable (stop() cancels
 * the pending frame so it cannot leak after the player stops). AnimationFrameGuard
 * encapsulates a single rAF handle with guarded start + cancel; raf/caf are
 * injectable so it unit-tests in node with no DOM.
 */
describe('AnimationFrameGuard', () => {
    function makeFakes() {
        let nextId = 1;
        const pending = new Map<number, FrameRequestCallback>();
        const raf = vi.fn((cb: FrameRequestCallback) => {
            const id = nextId++;
            pending.set(id, cb);
            return id;
        });
        const caf = vi.fn((id: number) => {
            pending.delete(id);
        });
        const fire = (id: number) => {
            const cb = pending.get(id);
            pending.delete(id);
            cb?.(performance.now?.() ?? 0);
        };
        return { raf, caf, fire, pending };
    }

    it('schedules one frame on start and reports pending', () => {
        const { raf, caf } = makeFakes();
        const g = new AnimationFrameGuard(raf, caf);
        const cb = vi.fn();
        g.start(cb);
        expect(raf).toHaveBeenCalledTimes(1);
        expect(g.isPending()).toBe(true);
    });

    it('does NOT double-start while a frame is already pending', () => {
        const { raf, caf } = makeFakes();
        const g = new AnimationFrameGuard(raf, caf);
        const cb = vi.fn();
        g.start(cb);
        g.start(cb); // second start must be a no-op
        g.start(cb);
        expect(raf).toHaveBeenCalledTimes(1);
    });

    it('stop() cancels the pending frame with the stored id and clears pending', () => {
        const { raf, caf } = makeFakes();
        const g = new AnimationFrameGuard(raf, caf);
        const cb = vi.fn();
        g.start(cb);
        const id = raf.mock.results[0]!.value as number;
        g.stop();
        expect(caf).toHaveBeenCalledTimes(1);
        expect(caf).toHaveBeenCalledWith(id);
        expect(g.isPending()).toBe(false);
    });

    it('stop() is a no-op when nothing is pending (no cancelAnimationFrame call)', () => {
        const { raf, caf } = makeFakes();
        const g = new AnimationFrameGuard(raf, caf);
        g.stop();
        expect(caf).not.toHaveBeenCalled();
    });

    it('clears pending when the frame fires, allowing a fresh reschedule (loop)', () => {
        const { raf, caf, fire } = makeFakes();
        const g = new AnimationFrameGuard(raf, caf);
        const cb = vi.fn();
        g.start(cb);
        const id = raf.mock.results[0]!.value as number;
        fire(id);
        expect(cb).toHaveBeenCalledTimes(1);
        // After firing, the guard must no longer be pending, so a reschedule works.
        expect(g.isPending()).toBe(false);
        g.start(cb);
        expect(raf).toHaveBeenCalledTimes(2);
    });

    it('a stop() after a fire does not cancel a frame that already ran', () => {
        const { raf, caf, fire } = makeFakes();
        const g = new AnimationFrameGuard(raf, caf);
        g.start(vi.fn());
        const id = raf.mock.results[0]!.value as number;
        fire(id);
        g.stop();
        expect(caf).not.toHaveBeenCalled();
    });
});
