/**
 * Guards a single requestAnimationFrame handle so a rAF-driven loop cannot
 * double-start or leak (finding #44).
 *
 * - `start(cb)` schedules a frame only if none is already pending (no
 *   double-start). The handle is cleared the instant the frame fires, so the
 *   callback may call `start` again to keep a loop running.
 * - `stop()` cancels any pending frame and clears the handle (no leak after the
 *   owner stops); it is a no-op when nothing is pending.
 *
 * raf/caf are injectable for unit testing without a DOM.
 */
type Raf = (cb: FrameRequestCallback) => number;
type Caf = (handle: number) => void;

export class AnimationFrameGuard {
    private id: number | null = null;

    constructor(
        private readonly raf: Raf = requestAnimationFrame,
        private readonly caf: Caf = cancelAnimationFrame,
    ) {}

    public isPending(): boolean {
        return this.id !== null;
    }

    /** Schedule one frame, unless one is already pending. */
    public start(cb: FrameRequestCallback): void {
        if (this.id !== null) {
            return;
        }
        this.id = this.raf((time) => {
            // Clear before invoking so the callback can reschedule cleanly and a
            // subsequent stop() won't try to cancel an already-fired frame.
            this.id = null;
            cb(time);
        });
    }

    /** Cancel the pending frame, if any. */
    public stop(): void {
        if (this.id !== null) {
            this.caf(this.id);
            this.id = null;
        }
    }
}
