/**
 * Fixed-capacity rolling window over numbers with an O(1) running average.
 *
 * Replaces the per-frame `array.shift()` + full `array.reduce()` churn in the
 * stream degradation path: `push()` evicts the oldest element and updates a
 * running sum in O(1), and `average()` is sum/count with no iteration.
 *
 * Backed by a ring buffer so eviction never shifts elements.
 */
export class RollingWindow {
    private readonly buffer: number[];
    private readonly capacity: number;
    private start = 0;
    private size = 0;
    private sum = 0;

    constructor(capacity: number) {
        if (capacity <= 0) {
            throw new Error(`RollingWindow capacity must be > 0, got ${capacity}`);
        }
        this.capacity = capacity;
        this.buffer = new Array<number>(capacity);
    }

    /** Number of values currently held (<= capacity). */
    get count(): number {
        return this.size;
    }

    /** Append a value, evicting the oldest when at capacity. O(1). */
    public push(value: number): void {
        if (this.size < this.capacity) {
            const index = (this.start + this.size) % this.capacity;
            this.buffer[index] = value;
            this.size++;
            this.sum += value;
        } else {
            // Full: overwrite the oldest slot, advance start, adjust running sum.
            const evicted = this.buffer[this.start]!;
            this.buffer[this.start] = value;
            this.start = (this.start + 1) % this.capacity;
            this.sum += value - evicted;
        }
    }

    /** Mean of the held values, or 0 when empty. O(1). */
    public average(): number {
        if (this.size === 0) {
            return 0;
        }
        return this.sum / this.size;
    }

    /** Drop all values and reset the running sum. */
    public clear(): void {
        this.start = 0;
        this.size = 0;
        this.sum = 0;
    }
}
