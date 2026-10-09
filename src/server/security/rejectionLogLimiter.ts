/**
 * Thins out a log line that one caller can repeat every few seconds.
 *
 * Item 174 (2026-10-08): after a local-mode update the first launch's tab is
 * still open, holding the previous process's instance token, and its device
 * list retries its websocket every 2 s. Each handshake was refused and logged
 * `[WebSocket Server] rejected WS connection ... missing or invalid token`,
 * about 25 lines a minute for as long as the tab stayed open.
 *
 * Per key (the WebSocket server uses remote address + reason): the first
 * occurrence is logged; later ones inside `windowMs` are only counted; the
 * first one after the window is logged again and carries that count. A key
 * that goes quiet for a whole window starts over, so an occasional rejection is
 * logged every time, exactly as before.
 *
 * No timer: a count still pending when the caller stops is never printed. The
 * line before it already said this caller was being refused, which is the fact
 * the log needs; a timer would keep a process-lifetime handle for a summary.
 */
export class RejectionLogLimiter {
    private readonly entries = new Map<string, { windowStart: number; suppressed: number }>();

    public constructor(
        public readonly windowMs = 60_000,
        private readonly maxKeys = 256,
    ) {}

    /**
     * Note one occurrence of `key` at `now`. Returns `null` when this one is not
     * to be logged, or the number of occurrences left unlogged since the last
     * line (0 for a first occurrence) when it is.
     */
    public note(key: string, now: number): number | null {
        const entry = this.entries.get(key);
        if (entry && now - entry.windowStart < this.windowMs) {
            entry.suppressed += 1;
            return null;
        }
        const suppressed = entry?.suppressed ?? 0;
        this.entries.delete(key);
        this.entries.set(key, { windowStart: now, suppressed: 0 });
        this.evict(now);
        return suppressed;
    }

    /** Keys being tracked; for tests. */
    public get size(): number {
        return this.entries.size;
    }

    /**
     * Bound the map: drop keys whose window has closed, then, if a flood of
     * distinct addresses is still over the cap, the oldest. Insertion order is
     * window-start order because `note` re-inserts a key when it opens a window.
     */
    private evict(now: number): void {
        if (this.entries.size <= this.maxKeys) return;
        for (const [key, e] of this.entries) {
            if (now - e.windowStart >= this.windowMs) this.entries.delete(key);
        }
        for (const key of this.entries.keys()) {
            if (this.entries.size <= this.maxKeys) break;
            this.entries.delete(key);
        }
    }
}
