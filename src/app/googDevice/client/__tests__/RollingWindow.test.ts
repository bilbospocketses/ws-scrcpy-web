import { describe, expect, it } from 'vitest';
import { RollingWindow } from '../RollingWindow';

/**
 * Naive reference average over a capacity-bounded window — the slow shift()/reduce()
 * implementation RollingWindow replaces. Used as the oracle for the O(1) version.
 */
function naiveAverage(values: number[], capacity: number): number {
    const window = values.slice(-capacity);
    if (window.length === 0) {
        return 0;
    }
    return window.reduce((a, b) => a + b, 0) / window.length;
}

describe('RollingWindow', () => {
    it('reports count and average correctly before reaching capacity', () => {
        const w = new RollingWindow(30);
        expect(w.count).toBe(0);
        expect(w.average()).toBe(0);
        w.push(10);
        w.push(20);
        w.push(30);
        expect(w.count).toBe(3);
        expect(w.average()).toBe(20);
    });

    it('evicts the oldest value once capacity is exceeded (fixed window of 30)', () => {
        const w = new RollingWindow(30);
        // Push 30 ones, then a 31st value of 301 — the first 1 should be evicted.
        for (let i = 0; i < 30; i++) {
            w.push(1);
        }
        expect(w.count).toBe(30);
        expect(w.average()).toBe(1);
        w.push(301);
        // Still 30 elements: 29 ones + one 301 → (29 + 301) / 30 = 11
        expect(w.count).toBe(30);
        expect(w.average()).toBeCloseTo((29 + 301) / 30, 10);
    });

    it('matches the naive shift()/reduce() reference across a long random sequence', () => {
        const capacity = 30;
        const w = new RollingWindow(capacity);
        const seen: number[] = [];
        let seed = 12345;
        const rand = () => {
            // deterministic LCG so the test is reproducible
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed % 5000;
        };
        for (let i = 0; i < 500; i++) {
            const v = rand();
            seen.push(v);
            w.push(v);
            expect(w.average()).toBeCloseTo(naiveAverage(seen, capacity), 6);
            expect(w.count).toBe(Math.min(seen.length, capacity));
        }
    });

    it('does not drift after many evictions (running sum stays exact for integers)', () => {
        const w = new RollingWindow(3);
        w.push(100);
        w.push(200);
        w.push(300);
        expect(w.average()).toBe(200);
        w.push(400); // evicts 100 → [200,300,400]
        w.push(500); // evicts 200 → [300,400,500]
        expect(w.average()).toBe(400);
    });

    it('clear() empties the window and resets the running sum', () => {
        const w = new RollingWindow(30);
        w.push(50);
        w.push(70);
        w.clear();
        expect(w.count).toBe(0);
        expect(w.average()).toBe(0);
        w.push(10);
        expect(w.average()).toBe(10);
    });
});
